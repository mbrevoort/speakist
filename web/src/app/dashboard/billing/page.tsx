// Billing page. Balance card, top-up tiles, payment method management,
// auto-topup config, and ledger history. Top-up + portal flow happens via
// the client component (fetch + window.location); this server component
// just loads state.
//
// Returns from Stripe with `?topup=success` or `?topup=cancel` → banner on
// the billing-client.

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { getDb } from "@/lib/db";
import { organizations, pricingConfig } from "@/lib/db/schema";
import { listLedger } from "@/lib/credits";
import { formatDollars } from "@/lib/utils";
import { BillingClient } from "./billing-client";

export const metadata = { title: "Billing — Speakist" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string }>;
}) {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!;
  const sp = await searchParams;

  // Member-level users shouldn't see org-level billing. Sidebar hides
  // the entry; direct URL hits bounce to Overview.
  if (org.role !== "owner" && org.role !== "admin") {
    redirect("/dashboard");
  }

  const db = getDb();

  const [orgRow] = await db
    .select({
      autoTopupEnabled: organizations.autoTopupEnabled,
      autoTopupThresholdMillicents: organizations.autoTopupThresholdMillicents,
      autoTopupAmountMillicents: organizations.autoTopupAmountMillicents,
      stripeDefaultPaymentMethodId: organizations.stripeDefaultPaymentMethodId,
    })
    .from(organizations)
    .where(eq(organizations.id, org.id))
    .limit(1);

  const [cfg] = await db
    .select({
      defaultThreshold: pricingConfig.defaultAutoTopupThresholdMillicents,
      defaultAmount: pricingConfig.defaultAutoTopupAmountMillicents,
    })
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 1))
    .limit(1);

  const [balanceMc, ledger] = await Promise.all([
    getOrgCreditBalance(org.id),
    listLedger(org.id, 30),
  ]);

  const thresholdMc =
    orgRow?.autoTopupThresholdMillicents ?? cfg?.defaultThreshold ?? 500_000;
  const amountMc =
    orgRow?.autoTopupAmountMillicents ?? cfg?.defaultAmount ?? 2_000_000;

  const canAdmin = org.role === "owner" || org.role === "admin";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Billing"
        description="Top up your team's credit and manage auto-top-up."
      />

      <BillingClient
        balanceMillicents={balanceMc}
        isComped={org.isComped}
        canAdmin={canAdmin}
        hasPaymentMethod={!!orgRow?.stripeDefaultPaymentMethodId}
        autoTopupEnabled={orgRow?.autoTopupEnabled ?? false}
        autoTopupThresholdDollars={thresholdMc / 100_000}
        autoTopupAmountDollars={amountMc / 100_000}
        topupStatus={sp.topup === "success" ? "success" : sp.topup === "cancel" ? "cancel" : null}
      />

      {/* Ledger history — server-rendered, no client interactivity needed */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Recent activity
        </h2>
        {ledger.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No ledger activity yet. Top-ups and transcription debits show up here.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Note</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">
                      {row.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <ReasonLabel reason={row.reason} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground truncate max-w-[280px]">
                      {row.note ?? "—"}
                    </td>
                    <td
                      className={`px-5 py-3 text-right font-mono tabular-nums ${
                        row.deltaMillicents >= 0 ? "text-sage" : "text-foreground"
                      }`}
                    >
                      {row.deltaMillicents >= 0 ? "+" : ""}
                      {formatDollars(row.deltaMillicents, { precision: row.reason === "usage" ? 4 : 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ReasonLabel({ reason }: { reason: string }) {
  const style =
    reason === "signup_bonus" || reason === "comp"
      ? "bg-peach/15 text-peach-deep"
      : reason.startsWith("stripe_")
      ? "bg-sage/10 text-sage"
      : reason === "usage"
      ? "bg-plum/10 text-plum"
      : reason === "refund"
      ? "bg-mustard/10 text-mustard"
      : "bg-muted text-muted-foreground";
  const label =
    reason === "stripe_topup"
      ? "Top-up"
      : reason === "stripe_auto_topup"
      ? "Auto top-up"
      : reason === "signup_bonus"
      ? "Signup bonus"
      : reason.charAt(0).toUpperCase() + reason.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {label}
    </span>
  );
}
