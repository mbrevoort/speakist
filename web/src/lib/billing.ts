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
  amountMillicents: number;
  returnUrl: string;
  customerEmail?: string;
}

/**
 * Create a Stripe Checkout Session for a one-time top-up. `amount_millicents`
 * is converted to Stripe's integer cents for the line item. We pass
 * `payment_intent_data.setup_future_usage = "off_session"` so the payment
 * method is saved on the Customer and can be used by triggerAutoTopup()
 * for subsequent auto-top-ups.
 *
 * metadata.orgId + metadata.amountMillicents is how the webhook knows who to
 * credit. We don't rely on amount_total — Stripe's number is in cents and
 * conversion back to millicents could lose precision.
 */
export async function createTopupCheckoutSession(
  args: CreateCheckoutArgs
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(args.orgId);

  // Millicents → Stripe cents. Round down to be safe; 1000 millicents/cent.
  const amountCents = Math.floor(args.amountMillicents / 1000);
  if (amountCents < 50) {
    throw new Error(`Top-up amount ${amountCents}¢ below Stripe's $0.50 minimum`);
  }

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
            name: "Speakist credit top-up",
            description: `Adds $${(amountCents / 100).toFixed(2)} of transcription credit.`,
          },
        },
      },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: {
        orgId: args.orgId,
        amountMillicents: String(args.amountMillicents),
        reason: "stripe_topup",
      },
    },
    metadata: {
      orgId: args.orgId,
      amountMillicents: String(args.amountMillicents),
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
