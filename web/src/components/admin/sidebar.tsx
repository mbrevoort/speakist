// Super-admin sidebar (md+ only). Below md, AdminMobileNav renders an
// equivalent drawer from the topbar's hamburger. NAV list + active-link
// logic live in nav-items.ts so both surfaces stay in sync.
//
// Distinct plum palette (vs. the dashboard's peach) so the operator
// never forgets they're in an elevated context.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/logo";
import { ADMIN_NAV, isAdminNavActive } from "@/components/admin/nav-items";

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-plum/20 bg-plum/5">
      <Link
        href="/"
        className="flex items-center gap-2 px-5 py-5 border-b border-plum/15"
        aria-label="Speakist home"
      >
        <Wordmark markClassName="w-6 h-6" />
      </Link>

      <div className="px-4 py-3 flex items-center gap-2 border-b border-plum/15">
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-plum text-cream">
          <Shield className="h-3.5 w-3.5" />
        </div>
        <p className="text-xs uppercase tracking-[0.15em] text-plum font-semibold">
          Super admin
        </p>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-0.5" aria-label="Admin navigation">
        {ADMIN_NAV.map((item) => {
          const active = isAdminNavActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-plum text-cream font-medium"
                  : "text-plum/70 hover:bg-plum/10 hover:text-plum"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-3 pb-4 border-t border-plum/15 pt-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          <span>Back to dashboard</span>
        </Link>
      </div>
    </aside>
  );
}
