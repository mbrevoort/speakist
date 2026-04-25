// Hamburger trigger + slide-in drawer for the dashboard nav, shown only
// below the md breakpoint where the permanent Sidebar is hidden. The
// drawer's nav list is deliberately identical (in shape and active-state
// rules) to the desktop sidebar — both consume nav-items.ts — so a user
// who shrinks the window doesn't get a different mental model.
//
// Implementation notes:
//   * Open state is local; we close on route change so a tap on
//     "Settings" navigates and dismisses the drawer in one gesture.
//   * SheetClose wraps each link so the close happens before navigation
//     hands off to next/link, avoiding the "tap a link, see the new page
//     under a still-open drawer" flash.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/logo";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  isNavActive,
  visibleNavItems,
  type DashboardRole,
} from "@/components/dashboard/nav-items";

interface MobileNavProps {
  orgName: string;
  role: DashboardRole;
}

export function MobileNav({ orgName, role }: MobileNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const visible = visibleNavItems(role);

  // Auto-close on route change. Without this, tapping a nav link
  // navigates but the drawer animates open→closed→open as React
  // re-renders the new page under it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>

      <SheetContent title="Dashboard navigation" className="p-0">
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

        <nav
          className="flex-1 overflow-y-auto px-3 space-y-0.5"
          aria-label="Dashboard navigation"
        >
          {visible.map((item) => {
            const active = isNavActive(item.href, pathname);

            const base =
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
            const enabled = active
              ? "bg-peach/10 text-peach-deep font-medium"
              : "text-muted-foreground hover:bg-muted hover:text-foreground";
            const disabled =
              "text-muted-foreground/50 cursor-not-allowed pointer-events-none";

            const Icon = item.icon;

            // Disabled rows don't participate in close-on-select since
            // they don't navigate; render plain anchor without SheetClose.
            if (item.disabled) {
              return (
                <span
                  key={item.href}
                  className={cn(base, disabled)}
                  title={item.disabledReason}
                  aria-disabled
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider rounded-full bg-muted px-1.5 py-0.5">
                    soon
                  </span>
                </span>
              );
            }

            return (
              <SheetClose asChild key={item.href}>
                <Link href={item.href} className={cn(base, enabled)}>
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                </Link>
              </SheetClose>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-border/70 text-xs text-muted-foreground">
          <p>Speakist private beta</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
