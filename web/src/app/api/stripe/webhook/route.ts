// Stripe webhook receiver.
//
// Events we care about:
//   * checkout.session.completed      — manual top-up paid
//   * payment_intent.succeeded        — used by auto-top-up (off-session PI)
//                                       + sometimes fires for Checkout too,
//                                       which is why we key idempotency on
//                                       the event id, not the PI id
//   * payment_intent.payment_failed   — auto-top-up failure; log + TODO email
//
// Every handler path is idempotent (creditLedger.stripe_event_id UNIQUE) so
// Stripe's at-least-once delivery is safe. Failures (4xx/5xx response) cause
// Stripe to retry — we want that for transient errors; we want 200 for
// "already processed" cases so retries stop.
//
// Signature verification uses SubtleCrypto (edge-compat) via the provider
// from src/lib/stripe.ts.

import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getStripe, getWebhookCryptoProvider } from "@/lib/stripe";
import { recordStripeTopup } from "@/lib/credits";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { notifyTopup } from "@/lib/slack";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // We still accept the request (200) so Stripe doesn't retry indefinitely
    // during the window where we haven't configured the secret yet, but log
    // loudly. Switch to 500 once you've set the secret in prod.
    console.error("[stripe webhook] STRIPE_WEBHOOK_SECRET not set; ignoring event");
    return new Response("not configured", { status: 200 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("missing signature", { status: 400 });
  }

  // IMPORTANT: constructEventAsync requires the raw request body.
  // Don't read as JSON first — the signature is over the exact bytes.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      getWebhookCryptoProvider()
    );
  } catch (err) {
    console.error("[stripe webhook] signature verification failed:", err);
    return new Response("bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event);
        break;
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event);
        break;
      default:
        // Not an event we care about — ack 200 so Stripe stops retrying.
        break;
    }
  } catch (err) {
    console.error(`[stripe webhook] handler for ${event.type} failed:`, err);
    // 500 → Stripe retries. Good for transient DB issues.
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

// --- handlers --------------------------------------------------------------

async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return;

  const orgId = session.metadata?.orgId;
  // For pricing-v2 manual top-ups we stamp the resolved tier onto the
  // session — `creditMillicents` already reflects the volume bonus, so the
  // ledger gets the bonus amount, not the dollar charge.
  const creditMillicentsStr = session.metadata?.creditMillicents;
  const tierId = session.metadata?.tierId;
  if (!orgId || !creditMillicentsStr) {
    console.warn(`[stripe webhook] checkout.session.completed without metadata: ${session.id}`);
    return;
  }
  const creditMillicents = Number(creditMillicentsStr);
  if (!Number.isFinite(creditMillicents) || creditMillicents <= 0) {
    console.warn(`[stripe webhook] invalid creditMillicents on ${session.id}`);
    return;
  }

  const { duplicate } = await recordStripeTopup({
    orgId,
    stripeEventId: event.id,
    amountMillicents: creditMillicents,
    reason: "stripe_topup",
    note: `Manual top-up via Checkout ${session.id}${tierId ? ` (tier ${tierId})` : ""}`,
  });

  // First successful Checkout: Stripe attached the PaymentMethod to the
  // Customer (because we set setup_future_usage=off_session). Record it as
  // the default so auto-top-up can use it next time.
  if (session.payment_intent) {
    await captureDefaultPaymentMethod(orgId, session.payment_intent as string);
  }

  if (!duplicate) {
    await notifyTopupForOrg({
      orgId,
      amountMillicents: creditMillicents,
      kind: "manual",
      userEmail: session.customer_details?.email ?? null,
    });
  }
}

async function handlePaymentIntentSucceeded(event: Stripe.Event) {
  const pi = event.data.object as Stripe.PaymentIntent;
  const reason = (pi.metadata?.reason ?? "stripe_topup") as
    | "stripe_topup"
    | "stripe_auto_topup";

  // Only act if this PI originated from our auto-topup path. Manual top-ups
  // are credited via checkout.session.completed to avoid double-crediting.
  if (reason !== "stripe_auto_topup") return;

  const orgId = pi.metadata?.orgId;
  // Auto-top-ups don't use a tier — they credit exactly what was charged
  // (no bonus). The `amountMillicents` field is stamped by triggerAutoTopup.
  const amountMillicentsStr = pi.metadata?.amountMillicents;
  if (!orgId || !amountMillicentsStr) return;

  const amountMillicents = Number(amountMillicentsStr);
  const { duplicate } = await recordStripeTopup({
    orgId,
    stripeEventId: event.id,
    amountMillicents,
    reason: "stripe_auto_topup",
    note: `Auto top-up via PaymentIntent ${pi.id}`,
  });

  if (!duplicate) {
    await notifyTopupForOrg({
      orgId,
      amountMillicents,
      kind: "auto",
      userEmail: null,
    });
  }
}

async function handlePaymentIntentFailed(event: Stripe.Event) {
  const pi = event.data.object as Stripe.PaymentIntent;
  const reason = pi.metadata?.reason;
  if (reason !== "stripe_auto_topup") return;
  const orgId = pi.metadata?.orgId;
  console.warn(
    `[stripe webhook] auto-topup failed for org=${orgId} pi=${pi.id}: ${pi.last_payment_error?.message}`
  );
  // TODO(phase-4-follow-up): notify the user via Resend so they know to
  // update their payment method. Safe to do here because the webhook
  // handler already returned success-bound to Stripe by the time this
  // async work kicks off.
}

// --- helpers ---------------------------------------------------------------

interface NotifyTopupForOrgArgs {
  orgId: string;
  amountMillicents: number;
  kind: "manual" | "auto";
  userEmail: string | null;
}

/**
 * Look up the org's display name and post a Slack top-up notification.
 * Failures are logged but never propagated — Stripe's webhook retry
 * shouldn't fire just because Slack was flaky, and the credit has
 * already landed in the ledger by the time we get here.
 */
async function notifyTopupForOrg(args: NotifyTopupForOrgArgs) {
  try {
    const db = getDb();
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, args.orgId))
      .limit(1);
    await notifyTopup({
      orgName: org?.name ?? `(unknown org ${args.orgId})`,
      kind: args.kind,
      amountMillicents: args.amountMillicents,
      userEmail: args.userEmail,
    });
  } catch (err) {
    console.error("[stripe webhook] notifyTopup failed:", err);
  }
}

async function captureDefaultPaymentMethod(orgId: string, paymentIntentId: string) {
  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const pmId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
    if (!pmId) return;

    const db = getDb();
    // Only overwrite if not already set — respects manual changes via Portal.
    await db
      .update(organizations)
      .set({ stripeDefaultPaymentMethodId: pmId })
      .where(eq(organizations.id, orgId));
  } catch (err) {
    // Non-fatal. Auto-top-up just won't fire until a later top-up fixes this.
    console.error("[stripe webhook] captureDefaultPaymentMethod failed:", err);
  }
}
