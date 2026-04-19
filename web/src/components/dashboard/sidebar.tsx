// Dashboard left sidebar. Static links; active state derived from
// pathname. Minimal on purpose — the nav will grow with Phase 4 (billing,
// usage) and Phase 5 (super admin), but Phase 3 just has three entries.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, CreditCard, Home, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/logo";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

const NAV: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: Home },
  { label: "Members", href: "/dashboard/members", icon: Users },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
  // Phase 4 — render but disabled so the UX is discoverable.
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard, disabled: true, disabledReason: "Coming in Phase 4" },
  { label: "Usage", href: "/dashboard/usage", icon: Building2, disabled: true, disabledReason: "Coming in Phase 4" },
];

export function Sidebar({ orgName }: { orgName: string }) {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-border/70 bg-white/40">
      <Link
        href="/"
        className="flex items-center gap-2 px-5 py-5 border-b border-border/70"
        aria-label="Speakist home"
      >
        <Wordmark markClassName="w-6 h-6" />
      </Link>

      <div className="px-3 py-3">
        <p className="px-3 pt-2 pb-1 text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
          {orgName}
        </p>
      </div>

      <nav className="flex-1 px-3 space-y-0.5" aria-label="Dashboard navigation">
        {NAV.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          const base =
            "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
          const enabled = active
            ? "bg-peach/10 text-peach-deep font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground";
          const disabled =
            "text-muted-foreground/50 cursor-not-allowed pointer-events-none";

          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.disabled ? "#" : item.href}
              className={cn(base, item.disabled ? disabled : enabled)}
              title={item.disabled ? item.disabledReason : undefined}
              aria-disabled={item.disabled}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {item.disabled && (
                <span className="text-[10px] font-mono uppercase tracking-wider rounded-full bg-muted px-1.5 py-0.5">
                  soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-border/70 text-xs text-muted-foreground">
        <p>Speakist private beta</p>
      </div>
    </aside>
  );
}
