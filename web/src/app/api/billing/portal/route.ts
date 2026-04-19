// POST /api/billing/portal
//
// Creates a Stripe Billing Portal session for the caller's org and returns
// the URL. The Portal lets the user update their payment method, download
// invoices, and see their payment history. Admins/owners only — same logic
// as /topup.
//
// Hosted by Stripe; no UI to design on our side. Configure the Portal's
// appearance + allowed actions in the Stripe Dashboard (one-time setup).

import { requireOrgAdmin, requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { createBillingPortalSession } from "@/lib/billing";

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return Response.json({ error: "No current org" }, { status: 400 });
    await requireOrgAdmin(org.id);

    const origin = new URL(req.url).origin;
    const returnUrl = `${origin}/dashboard/billing`;

    const session = await createBillingPortalSession(org.id, returnUrl);
    return Response.json({ url: session.url });
  } catch (err) {
    console.error("/api/billing/portal failed:", err);
    return Response.json({ error: "portal failed" }, { status: 500 });
  }
}
