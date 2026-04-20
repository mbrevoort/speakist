// Speakist env schema.
//
// Two runtimes to keep in mind:
//   * Node-ish for `next dev` / build → plain process.env
//   * Cloudflare Workers for deployed routes → process.env is polyfilled by
//     OpenNext's nodejs_compat layer, but the canonical surface for bindings
//     (D1, KV, R2) is `getCloudflareContext().env`, not process.env. This
//     file is only for scalar *secrets* and public URLs, never for bindings.
//
// AUTH_SECRET / RESEND_* etc. are set via:
//   * Local dev:  .env.local (not committed)
//   * Production: `wrangler pages secret put AUTH_SECRET` (encrypted in CF)

import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url(),
});

const serverSchema = publicSchema.extend({
  // Auth.js — required at runtime.
  AUTH_SECRET: z.string().min(32, "Generate with: openssl rand -base64 33"),
  // Only needed in deployed Workers; in `next dev`, Auth.js reads NEXTAUTH_URL
  // or falls back to the request origin. Kept optional for dev convenience.
  AUTH_URL: z.string().url().optional(),

  // App-layer encryption for Deepgram key fields (added in Phase 5).
  APP_ENCRYPTION_KEY: z.string().min(32).optional(),

  SUPER_ADMIN_EMAIL: z.string().email().default("mike@brevoort.com"),

  // Resend — required for magic-link emails. Optional in dev (falls back to
  // logging the link to console — see src/lib/auth.ts).
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().default("noreply@speakist-dev.brevoortstudio.com"),

  // Stripe (Phase 4).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  // Deepgram (Phase 6) — used server-side to mint short-lived keys.
  DEEPGRAM_PROJECT_ID: z.string().min(1).optional(),
  DEEPGRAM_PROJECT_KEY: z.string().min(1).optional(),
});

export const env = {
  public: publicSchema.parse({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  }),
  get server() {
    if (typeof window !== "undefined") {
      throw new Error("env.server accessed in client context");
    }
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error("❌ Invalid server env:", parsed.error.flatten().fieldErrors);
      throw new Error("Invalid server env");
    }
    return parsed.data;
  },
};
