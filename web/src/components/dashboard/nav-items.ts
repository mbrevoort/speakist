// Single source of truth for the dashboard left-nav entries. Both the
// permanent sidebar (md+) and the mobile drawer consume this list, so
// adding a new page is one edit, not two.

import { BarChart3, CreditCard, Home, Settings, Users } from "lucide-react";

export interface DashboardNavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When true, only render this entry for owners/admins. */
  adminOnly?: boolean;
  /** Greyed-out label with a "soon" badge. Used for not-yet-shipped pages. */
  disabled?: boolean;
  disabledReason?: string;
}

export const DASHBOARD_NAV: DashboardNavItem[] = [
  { label: "Overview", href: "/dashboard", icon: Home },
  { label: "Usage", href: "/dashboard/usage", icon: BarChart3 },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard, adminOnly: true },
  { label: "Members", href: "/dashboard/members", icon: Users },
  // Settings is reachable to every member because the polish prompt
  // editor lives there. Org-admin fields (org name, auto-join domain,
  // delete) inside the page are gated per-row via the `canAdmin` flag.
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

export type DashboardRole = "owner" | "admin" | "member";

export function visibleNavItems(role: DashboardRole): DashboardNavItem[] {
  const isAdmin = role === "owner" || role === "admin";
  return DASHBOARD_NAV.filter((item) => isAdmin || !item.adminOnly);
}

/**
 * Active-link logic shared between the sidebar and the mobile drawer.
 * Overview matches `/dashboard` exactly because every other dashboard
 * route also starts with `/dashboard` — a startsWith check would light
 * up Overview on every page.
 */
export function isNavActive(itemHref: string, pathname: string): boolean {
  if (itemHref === "/dashboard") return pathname === "/dashboard";
  return pathname.startsWith(itemHref);
}
