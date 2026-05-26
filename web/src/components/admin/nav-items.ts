// Single source of truth for the super-admin nav. Mirrors the
// dashboard's nav-items.ts pattern so AdminSidebar (md+) and
// AdminMobileNav (below md) consume the same list.

import {
  Building2,
  DollarSign,
  Flag,
  Home,
  KeyRound,
  Server,
  Sparkles,
  Users,
} from "lucide-react";

export interface AdminNavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { label: "Overview", href: "/admin", icon: Home },
  { label: "Workspaces", href: "/admin/orgs", icon: Building2 },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Pricing", href: "/admin/pricing", icon: DollarSign },
  { label: "Feedback", href: "/admin/feedback", icon: Flag },
  { label: "Polish prompts", href: "/admin/polish-prompts", icon: Sparkles },
  { label: "Tokens", href: "/admin/tokens", icon: KeyRound },
  { label: "System", href: "/admin/system", icon: Server },
];

/** Active-link logic — Overview matches `/admin` exactly so it doesn't
 *  light up on every admin sub-route via startsWith. */
export function isAdminNavActive(itemHref: string, pathname: string): boolean {
  if (itemHref === "/admin") return pathname === "/admin";
  return pathname.startsWith(itemHref);
}
