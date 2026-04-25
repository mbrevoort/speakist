// Hamburger trigger + slide-in drawer for super admin, shown only
// below the md breakpoint where AdminSidebar is hidden. Mirrors
// dashboard/mobile-nav.tsx but with the plum admin palette and
// includes the "Back to dashboard" exit.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Menu, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/logo";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ADMIN_NAV, isAdminNavActive } from "@/components/admin/nav-items";

export function AdminMobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Auto-close on route change. Without this the drawer animates
  // open→closed→open as the new page renders under it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-plum/70 hover:bg-plum/10 hover:text-plum transition-colors"
          aria-label="Open admin navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>

      <SheetContent
        title="Super admin navigation"
        className="p-0 border-r-plum/20 bg-plum/5"
      >
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

        <nav
          className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5"
          aria-label="Admin navigation"
        >
          {ADMIN_NAV.map((item) => {
            const active = isAdminNavActive(item.href, pathname);
            const Icon = item.icon;
            return (
              <SheetClose asChild key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-plum text-cream font-medium"
                      : "text-plum/70 hover:bg-plum/10 hover:text-plum",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </SheetClose>
            );
          })}
        </nav>

        <div className="px-3 pb-4 border-t border-plum/15 pt-3">
          <SheetClose asChild>
            <Link
              href="/dashboard"
              className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>Back to dashboard</span>
            </Link>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}
