"use client";

// Pushes the signed-in user's identity into the client PostHog session
// the moment we have it server-side. Drop this into a server component
// that already loaded the user (e.g. dashboard layout) so PostHog
// associates the anonymous pageviews-before-login with the real user.
//
// No-op when posthog-js never initialized (no API key configured).

import { useEffect } from "react";
import posthog from "posthog-js";

interface PostHogIdentifyProps {
  userId: string;
  email: string;
  displayName?: string | null;
  orgId?: string;
  orgName?: string;
  orgRole?: string;
  isSuperAdmin?: boolean;
}

export function PostHogIdentify(props: PostHogIdentifyProps) {
  const { userId, email, displayName, orgId, orgName, orgRole, isSuperAdmin } =
    props;
  useEffect(() => {
    if (!posthog.__loaded) return;
    posthog.identify(userId, {
      email,
      name: displayName ?? undefined,
      is_super_admin: isSuperAdmin ?? false,
    });
    if (orgId) {
      posthog.group("organization", orgId, {
        name: orgName,
        role: orgRole,
      });
    }
  }, [userId, email, displayName, orgId, orgName, orgRole, isSuperAdmin]);
  return null;
}
