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
      // Pin explicitly: anonymous traffic shouldn't burn PostHog's MTU
      // quota until the user is identified. SDK default has been
      // "identified_only" since v1.151 but pinning protects against a
      // future default flip.
      person_profiles: "identified_only",
      capture_pageview: true,
      capture_pageleave: true,
      // Mask anything tagged `data-ph-mask` so sensitive fields
      // (Stripe forms, magic-link inputs) never land in replays.
      session_recording: {
        maskTextSelector: "[data-ph-mask]",
      },
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
