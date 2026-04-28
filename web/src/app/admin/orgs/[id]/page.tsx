// Admin → single-workspace management page.
//
// Shows workspace summary + admin-only actions: comp toggle, manual credit
// adjustment, Deepgram key override. Also lists recent ledger entries and
// members so the operator has full context in one view.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Gift } from "lucide-react";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getOrgDetail, listActiveProviderModels } from "@/lib/admin";
import { listOrgMembers } from "@/lib/orgs";
import { listLedger } from "@/lib/credits";
import { formatDollars } from "@/lib/utils";
import { OrgAdminActions } from "./org-client";

export const metadata = { title: "Workspace — Admin" };

export default async function AdminOrgPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;

  const [org, members, ledger, availableModels] = await Promise.all([
    getOrgDetail(id),
    listOrgMembers(id).catch(() => []),
    listLedger(id, 25).catch(() => []),
    listActiveProviderModels().catch(() => []),
  ]);
  if (!org) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div>
        <Link
          href="/admin/orgs"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All workspaces
        </Link>
        <PageHeader
          title={org.name}
          description={
            <>
              {org.slug} · created{" "}
              <LocalTime value={org.createdAt} format="date" />
              {org.autoJoinDomain ? ` · @${org.autoJoinDomain} auto-invite` : ""}
            </>
          }
          actions={
            org.isComped ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-peach/15 text-peach-deep text-xs font-semibold px-3 py-1">
                <Gift className="h-3 w-3" /> Comped
              </span>
            ) : null
          }
        />
      </div>

      {/* Summary tiles */}
      <section className="grid sm:grid-cols-4 gap-3">
        <StatTile label="Members" value={org.memberCount.toLocaleString()} />
        <StatTile
          label="Balance"
          value={formatDollars(org.balanceMillicents)}
          valueClass={org.balanceMillicents < 0 ? "text-destructive" : ""}
        />
        <StatTile
          label="Lifetime spend"
          value={formatDollars(org.lifetimeSpendMillicents)}
        />
        <StatTile label="Events (30d)" value={org.last30dEvents.toLocaleString()} />
      </section>

      {/* Payment method + Stripe */}
      <section className="rounded-2xl border border-border/70 bg-background p-5">
        <h3 className="text-sm font-semibold">Stripe</h3>
        <dl className="mt-3 grid sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground uppercase tracking-wider">
              Customer
            </dt>
            <dd className="mt-1 font-mono text-xs truncate">
              {org.stripeCustomerId ?? "— not yet"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground uppercase tracking-wider">
              Payment method on file
            </dt>
            <dd className="mt-1">{org.hasPaymentMethod ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground uppercase tracking-wider">
              Auto top-up
            </dt>
            <dd className="mt-1">{org.autoTopupEnabled ? "Enabled" : "Off"}</dd>
          </div>
        </dl>
      </section>

      {/* Admin actions */}
      <OrgAdminActions
        orgId={org.id}
        isComped={org.isComped}
        hasDeepgramOverride={org.hasDeepgramOverride}
        hasGroqOverride={org.hasGroqOverride}
        allowedModels={org.allowedModels}
        availableModels={availableModels}
      />

      {/* Recent ledger */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">Ledger</h2>
        {ledger.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background p-8 text-center">
            <p className="text-sm text-muted-foreground">No ledger activity yet.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                  <th className="px-5 py-3 font-medium">Note</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">
                      <LocalTime value={r.createdAt} format="datetime" />
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{r.reason}</td>
                    <td className="px-5 py-3 text-muted-foreground truncate max-w-[320px]">
                      {r.note ?? "—"}
                    </td>
                    <td
                      className={`px-5 py-3 text-right font-mono tabular-nums ${
                        r.deltaMillicents >= 0 ? "text-sage" : "text-foreground"
                      }`}
                    >
                      {r.deltaMillicents >= 0 ? "+" : ""}
                      {formatDollars(r.deltaMillicents, {
                        precision: r.reason === "usage" ? 4 : 2,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Members */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Members <span className="text-muted-foreground font-normal">({members.length})</span>
        </h2>
        {members.length > 0 && (
          <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium">
                        {m.displayName ?? m.email.split("@")[0]}
                      </p>
                      <p className="text-xs text-muted-foreground">{m.email}</p>
                    </td>
                    <td className="px-5 py-3 text-right text-xs font-mono uppercase tracking-wider text-muted-foreground">
                      {m.role}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-muted-foreground">
                      joined <LocalTime value={m.joinedAt} format="date" />
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

function StatTile({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background p-4">
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${
          valueClass ?? ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
