// Dashboard top bar. Hamburger + mobile nav drawer on the left (visible
// only below md, where the permanent sidebar is hidden), user avatar +
// menu on the right. `signOutAction` is passed in so the component can
// stay a pure-presentation client component and the actual sign-out
// runs as a server action on the server.

"use client";

import Link from "next/link";
import { useTransition } from "react";
import { Building2, Check, ChevronsUpDown, LogOut, Shield, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchActiveWorkspace } from "@/app/dashboard/workspace-actions";

interface TopbarWorkspace {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
}

interface TopbarProps {
  userEmail: string;
  userDisplayName: string | null;
  isSuperAdmin: boolean;
  signOutAction: () => Promise<void>;
  /** Slot rendered on the left of the topbar — typically a hamburger
   *  trigger that opens a mobile nav drawer (md:hidden). Each layout
   *  supplies its own variant: dashboard layout passes <MobileNav>,
   *  admin layout passes <AdminMobileNav>. Omit when no left-side
   *  surface is needed; a spacer keeps the avatar right-aligned via
   *  justify-between. */
  mobileNav?: React.ReactNode;
  /** Every org the user belongs to. When length >= 2, a workspace
   *  switcher dropdown renders to the left of the avatar. Single-
   *  membership users see no switcher — the same UX as before. */
  workspaces?: TopbarWorkspace[];
  /** Currently-active org id, used to highlight the selected entry
   *  in the switcher. */
  activeOrgId?: string;
}

export function Topbar({
  userEmail,
  userDisplayName,
  isSuperAdmin,
  signOutAction,
  mobileNav,
  workspaces,
  activeOrgId,
}: TopbarProps) {
  const initial = (userDisplayName?.[0] ?? userEmail[0] ?? "?").toUpperCase();
  const showSwitcher = (workspaces?.length ?? 0) >= 2;
  const activeWorkspace = workspaces?.find((w) => w.id === activeOrgId);

  return (
    <header className="h-16 shrink-0 border-b border-border/70 bg-background/70 backdrop-blur flex items-center justify-between gap-3 px-4 sm:px-6">
      {mobileNav ?? <span />}

      <div className="flex items-center gap-2">
        {showSwitcher && activeWorkspace && (
          <WorkspaceSwitcher
            workspaces={workspaces!}
            activeOrgId={activeOrgId!}
            activeName={activeWorkspace.name}
          />
        )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full pl-1 pr-3 py-1 hover:bg-muted transition-colors"
            aria-label="Account menu"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-peach text-white text-sm font-semibold">
              {initial}
            </span>
            <span className="hidden sm:inline text-sm text-foreground truncate max-w-[180px]">
              {userDisplayName ?? userEmail}
            </span>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={8} className="min-w-[220px]">
          <DropdownMenuLabel className="font-normal">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground truncate">
                {userDisplayName ?? userEmail.split("@")[0]}
              </p>
              <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <UserRound className="h-4 w-4" />
              <span>Account & org</span>
            </Link>
          </DropdownMenuItem>

          {isSuperAdmin && (
            <DropdownMenuItem asChild>
              <Link href="/admin" className="text-peach-deep">
                <Shield className="h-4 w-4" />
                <span>Super admin</span>
              </Link>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              signOutAction();
            }}
          >
            <LogOut className="h-4 w-4" />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </header>
  );
}

/**
 * Workspace dropdown shown to multi-org users. Sits to the left of the
 * account dropdown so the active workspace name is glanceable as part
 * of "where am I" context. Single-membership users never render this.
 */
function WorkspaceSwitcher({
  workspaces,
  activeOrgId,
  activeName,
}: {
  workspaces: TopbarWorkspace[];
  activeOrgId: string;
  activeName: string;
}) {
  const [pending, startTransition] = useTransition();

  function pick(id: string) {
    if (id === activeOrgId) return;
    const fd = new FormData();
    fd.set("org_id", id);
    startTransition(async () => {
      await switchActiveWorkspace(fd);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="hidden sm:inline-flex items-center gap-2 rounded-md border border-border/70 bg-background pl-2.5 pr-2 py-1.5 text-sm hover:bg-muted/50 transition-colors"
          aria-label="Switch workspace"
          disabled={pending}
        >
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium truncate max-w-[160px]">{activeName}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[260px]">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
          Switch workspace
        </DropdownMenuLabel>
        {workspaces.map((w) => {
          const active = w.id === activeOrgId;
          return (
            <DropdownMenuItem
              key={w.id}
              onSelect={(e) => {
                e.preventDefault();
                pick(w.id);
              }}
              className="flex items-start gap-2"
            >
              <span className="mt-0.5 inline-flex w-4 justify-center">
                {active && <Check className="h-3.5 w-3.5 text-peach-deep" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate">{w.name}</span>
                <span className="block text-xs text-muted-foreground truncate">
                  {w.slug} · {w.role}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
