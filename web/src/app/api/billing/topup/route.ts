// POST /api/billing/topup
//
// Creates a Stripe Checkout Session for the caller's current org and returns
// the session URL. The client navigates the user to that URL; on return,
// Stripe's webhook adds the credit.
//
// Body: { tierId: string }
//   The client picks one of the SKUs in src/lib/billing/topupTiers.ts. We
//   resolve it server-side so the bonus credit can't be tampered with from
//   the browser.
//
// Only admins/owners can initiate top-ups — members shouldn't be able to
// spend the org's money. (They can still consume credit by transcribing;
// they just can't add to the pool.)

import { z } from "zod";
import { requireOrgAdmin, requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { createTopupCheckoutSession } from "@/lib/billing";
import { getTopupTier } from "@/lib/billing/topupTiers";

const bodySchema = z.object({
  tierId: z.string().min(1).max(32),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return Response.json({ error: "No current org" }, { status: 400 });
    await requireOrgAdmin(org.id);

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: "Bad request body" }, { status: 400 });
    }

    const tier = getTopupTier(parsed.data.tierId);
    if (!tier) {
      return Response.json({ error: "Unknown top-up tier" }, { status: 400 });
    }

    // Build a return URL back to /dashboard/billing. The base comes from the
    // request origin so preview/dev/prod all work without env-var dance.
    const origin = new URL(req.url).origin;
    const returnUrl = `${origin}/dashboard/billing`;

    const session = await createTopupCheckoutSession({
      orgId: org.id,
      tier,
      returnUrl,
      customerEmail: user.email,
    });

    if (!session.url) {
      return Response.json({ error: "Stripe session missing URL" }, { status: 500 });
    }

    return Response.json({ url: session.url });
  } catch (err) {
    console.error("/api/billing/topup failed:", err);
    return Response.json({ error: "topup failed" }, { status: 500 });
  }
}
