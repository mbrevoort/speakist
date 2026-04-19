// Dashboard top bar. Empty on the left (breadcrumbs land in Phase 5 for
// super admin), user avatar + menu on the right. `signOutAction` is passed
// in so the component can stay a pure-presentation client component and
// the actual sign-out runs as a server action on the server.

"use client";

import Link from "next/link";
import { LogOut, Shield, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TopbarProps {
  userEmail: string;
  userDisplayName: string | null;
  isSuperAdmin: boolean;
  signOutAction: () => Promise<void>;
}

export function Topbar({
  userEmail,
  userDisplayName,
  isSuperAdmin,
  signOutAction,
}: TopbarProps) {
  const initial = (userDisplayName?.[0] ?? userEmail[0] ?? "?").toUpperCase();

  return (
    <header className="h-16 shrink-0 border-b border-border/70 bg-background/70 backdrop-blur flex items-center justify-end px-6">
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
    </header>
  );
}
