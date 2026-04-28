// Admin → Workspaces list.
//
// One row per workspace with key stats. Search filters on name/slug/domain
// via URL query (?q=acme) so the page stays server-rendered + linkable.

import Link from "next/link";
import { ArrowRight, Gift } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { listAllOrgs } from "@/lib/admin";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Workspaces — Admin" };

export default async function AdminOrgsList({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSuperAdmin();
  const { q } = await searchParams;
  const orgs = await listAllOrgs(q?.trim() || undefined);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Workspaces"
        description="Every workspace on the platform. Click one to manage."
      />

      <form className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by name, slug, or domain…"
          className="w-full sm:w-96 rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </form>

      {orgs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {q ? `No workspaces match "${q}".` : "No workspaces yet."}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                <th className="px-5 py-3 font-medium">Workspace</th>
                <th className="px-5 py-3 font-medium">Members</th>
                <th className="px-5 py-3 font-medium text-right">Balance</th>
                <th className="px-5 py-3 font-medium text-right">Lifetime spend</th>
                <th className="px-5 py-3 font-medium text-right">30d events</th>
                <th className="px-5 py-3" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-b border-border/40 last:border-0 hover:bg-muted/30">
                  <td className="px-5 py-3">
                    <Link href={`/admin/orgs/${o.id}`} className="block group">
                      <p className="font-medium text-foreground group-hover:underline flex items-center gap-2">
                        {o.name}
                        {o.isComped && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-peach/15 text-peach-deep text-[10px] font-semibold px-2 py-0.5 uppercase"
                            title="Comped workspace"
                          >
                            <Gift className="h-3 w-3" /> Comp
                          </span>
                        )}
                        {o.hasDeepgramOverride && (
                          <span
                            className="rounded-full bg-plum/10 text-plum text-[10px] font-semibold px-2 py-0.5 uppercase"
                            title="Uses custom Deepgram key"
                          >
                            BYOK
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {o.slug}
                        {o.autoJoinDomain ? ` · @${o.autoJoinDomain}` : ""}
                      </p>
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">
                    {o.memberCount}
                  </td>
                  <td
                    className={`px-5 py-3 text-right tabular-nums font-mono ${
                      o.balanceMillicents < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {formatDollars(o.balanceMillicents)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                    {formatDollars(o.lifetimeSpendMillicents, { precision: 2 })}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                    {o.last30dEvents.toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/orgs/${o.id}`}
                      className="inline-flex items-center text-muted-foreground hover:text-foreground"
                      aria-label={`Manage ${o.name}`}
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
