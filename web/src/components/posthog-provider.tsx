"use client";

// Client-side PostHog initialization.
//
// PostHog runs in the browser only — server-side capture goes through the
// posthog-node helper in lib/posthog/server.ts. Mounted in the root layout
// so every route gets analytics + session replay.
//
// Production-only: when NEXT_PUBLIC_POSTHOG_KEY is unset (dev / preview /
// any deploy that didn't bake the key), this is a pass-through component
// and posthog-js never initializes. That keeps localhost noise out of the
// PostHog project.

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider as ClientProvider } from "posthog-js/react";

interface PostHogProviderProps {
  apiKey: string | undefined;
  apiHost: string;
  children: React.ReactNode;
}

export function PostHogProvider({
  apiKey,
  apiHost,
  children,
}: PostHogProviderProps) {
  useEffect(() => {
    if (!apiKey) return;
    if (posthog.__loaded) return;
    posthog.init(apiKey, {
      api_host: apiHost,
      // Reverse-proxy not configured yet — use the cloud host directly.
      // person_profiles defaults to "identified_only" in current versions
      // which is what we want: anonymous traffic doesn't burn through
      // PostHog's MTU quota until the user is actually identified.
      person_profiles: "identified_only",
      // Capture pageviews and pageleaves automatically.
      capture_pageview: true,
      capture_pageleave: true,
      // Session replay — enabled by default once the key is set; we
      // mask anything inside an `[data-ph-mask]` element so sensitive
      // fields (Stripe forms, magic-link inputs) never get recorded.
      session_recording: {
        maskTextSelector: "[data-ph-mask]",
      },
      // We do our own identify() in PostHogIdentify, so disable the
      // built-in anonymous→identified merge attempt on every load.
      loaded: (ph) => {
        if (process.env.NODE_ENV === "development") {
          ph.debug();
        }
      },
    });
  }, [apiKey, apiHost]);

  if (!apiKey) {
    return <>{children}</>;
  }
  return <ClientProvider client={posthog}>{children}</ClientProvider>;
}
