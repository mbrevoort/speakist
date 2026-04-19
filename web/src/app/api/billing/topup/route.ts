// POST /api/billing/topup
//
// Creates a Stripe Checkout Session for the caller's current org and returns
// the session URL. The client navigates the user to that URL; on return,
// Stripe's webhook adds the credit.
//
// Body: { amountMillicents: number }
// Only admins/owners can initiate top-ups — members shouldn't be able to
// spend the org's money. (They can still consume credit by transcribing;
// they just can't add to the pool.)

import { z } from "zod";
import { requireOrgAdmin, requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { createTopupCheckoutSession } from "@/lib/billing";

const bodySchema = z.object({
  amountMillicents: z.number().int().positive().max(100_000_000),
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
      return Response.json({ error: "Bad amount" }, { status: 400 });
    }

    // Build a return URL back to /dashboard/billing. The base comes from the
    // request origin so preview/dev/prod all work without env-var dance.
    const origin = new URL(req.url).origin;
    const returnUrl = `${origin}/dashboard/billing`;

    const session = await createTopupCheckoutSession({
      orgId: org.id,
      amountMillicents: parsed.data.amountMillicents,
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
