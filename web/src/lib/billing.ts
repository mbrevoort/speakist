// Billing — Stripe interactions on behalf of an org.
//
// Shape:
//   * getOrCreateStripeCustomer(orgId) — idempotent "ensure a customer exists"
//   * createTopupCheckoutSession      — hosted Checkout for manual top-ups
//   * createBillingPortalSession      — hosted Portal for payment-method mgmt
//   * triggerAutoTopup                — off-session PaymentIntent

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getStripe } from "@/lib/stripe";
import { type TopupTier } from "@/lib/billing/topupTiers";

// --- customer -------------------------------------------------------------

/**
 * Ensure the org has a Stripe Customer; create one lazily on first billing
 * interaction. We don't create Customers up-front at signup because most
 * users won't ever pay (they live off the $5 signup bonus) and Stripe
 * doesn't love orphan customers.
 */
export async function getOrCreateStripeCustomer(orgId: string): Promise<string> {
  const db = getDb();
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      stripeCustomerId: organizations.stripeCustomerId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw new Error(`Org ${orgId} not found`);
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: org.name,
    metadata: { orgId },
  });

  await db
    .update(organizations)
    .set({ stripeCustomerId: customer.id })
    .where(eq(organizations.id, orgId));

  return customer.id;
}

// --- Checkout session -----------------------------------------------------

interface CreateCheckoutArgs {
  orgId: string;
  tier: TopupTier;
  returnUrl: string;
  customerEmail?: string;
}

/**
 * Create a Stripe Checkout Session for a one-time top-up of the given
 * tier. `tier.dollarAmount` is what Stripe charges; `tier.creditMillicents`
 * is what we'll credit on success — for tiers above $5 the latter exceeds
 * the former (the bonus). Both are stamped into Stripe metadata so the
 * webhook credits the right amount idempotently. We don't rely on
 * `amount_total` — that's in Stripe cents and round-tripping through it
 * loses precision plus skips the bonus entirely.
 *
 * `payment_intent_data.setup_future_usage = "off_session"` saves the
 * payment method on the Customer so triggerAutoTopup() can charge it later.
 */
export async function createTopupCheckoutSession(
  args: CreateCheckoutArgs
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(args.orgId);

  const amountCents = args.tier.dollarAmount * 100;
  if (amountCents < 50) {
    throw new Error(`Tier ${args.tier.id} below Stripe's $0.50 minimum`);
  }

  const bonusLine =
    args.tier.bonusPct > 0
      ? ` (+${args.tier.bonusPct}% bonus)`
      : "";

  return stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    success_url: `${args.returnUrl}?topup=success`,
    cancel_url: `${args.returnUrl}?topup=cancel`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: `Speakist top-up — $${args.tier.dollarAmount}${bonusLine}`,
            description: `Adds $${(args.tier.creditMillicents / 100_000).toFixed(2)} of transcription credit to your account.`,
          },
        },
      },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: {
        orgId: args.orgId,
        tierId: args.tier.id,
        creditMillicents: String(args.tier.creditMillicents),
        reason: "stripe_topup",
      },
    },
    metadata: {
      orgId: args.orgId,
      tierId: args.tier.id,
      creditMillicents: String(args.tier.creditMillicents),
    },
  });
}

// --- Customer Portal ------------------------------------------------------

export async function createBillingPortalSession(
  orgId: string,
  returnUrl: string
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(orgId);
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

// --- auto top-up ----------------------------------------------------------

interface TriggerAutoTopupArgs {
  orgId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  amountMillicents: number;
}

/**
 * Create an off-session PaymentIntent to charge the org's saved payment
 * method. Stripe processes it, and the resulting payment_intent.succeeded
 * webhook writes the ledger credit.
 *
 * We mark the PaymentIntent's metadata with reason=stripe_auto_topup so the
 * webhook can distinguish auto from manual top-ups.
 *
 * Card authentication failures (3DS required) in an off-session context
 * surface as Stripe errors here; we let them propagate to the caller (credits.ts)
 * which logs + ideally emails the user to complete a manual top-up.
 */
export async function triggerAutoTopup(args: TriggerAutoTopupArgs): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const amountCents = Math.floor(args.amountMillicents / 1000);
  if (amountCents < 50) {
    throw new Error("Auto-topup amount below Stripe's $0.50 minimum");
  }
  return stripe.paymentIntents.create({
    customer: args.stripeCustomerId,
    payment_method: args.stripePaymentMethodId,
    amount: amountCents,
    currency: "usd",
    off_session: true,
    confirm: true,
    metadata: {
      orgId: args.orgId,
      amountMillicents: String(args.amountMillicents),
      reason: "stripe_auto_topup",
    },
    description: "Speakist credit auto-top-up",
  });
}
