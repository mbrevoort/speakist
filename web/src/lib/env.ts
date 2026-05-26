// Speakist env schema.
//
// Two runtimes to keep in mind:
//   * Node-ish for `next dev` / build → plain process.env
//   * Cloudflare Workers for deployed routes → process.env is polyfilled by
//     OpenNext's nodejs_compat layer, but the canonical surface for bindings
//     (D1, KV, R2) is `getCloudflareContext().env`, not process.env. This
//     file is only for scalar *secrets* and public URLs, never for bindings.
//
// Configuration tiers (see docs/cicd.md "Config management"):
//
//   1. NEXT_PUBLIC_*  — inlined into the JS bundle at build time. Set in
//      package.json's deploy:dev / deploy:prod scripts so each env's
//      build sees its own value. Falls back to localhost for `next dev`.
//   2. Worker vars    — non-secret, env-specific, read at runtime via
//      process.env. Source of truth = wrangler.toml [env.X.vars].
//      Examples below: SUPER_ADMIN_EMAIL, RESEND_FROM_EMAIL,
//      IOS_TESTFLIGHT_URL.
//   3. Worker secrets — encrypted, set via `wrangler secret put X --env Y`.
//      Examples below: AUTH_SECRET, RESEND_API_KEY, STRIPE_*, DEEPGRAM_*.
//
// Defaults in this schema are fallbacks for `next dev` only. Deployed
// Workers should always have the real value coming from wrangler.toml
// (vars) or `wrangler secret put` (secrets); a fallback firing in
// production means a config drift, not a feature.

import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url(),

  // PostHog. The KEY is a "phc_..." project key safe to inline in the
  // client bundle (not a secret). Production-only by convention: run
  // `NEXT_PUBLIC_POSTHOG_KEY=phc_xxx pnpm deploy:prod` so the value gets
  // baked into the prod build. Dev / local / preview omit it and the
  // client SDK simply never initializes (see PostHogProvider.tsx).
  // posthog-node uses the same key on the server side.
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  // US cloud is the default. Override to https://eu.i.posthog.com or a
  // self-hosted reverse proxy if needed.
  NEXT_PUBLIC_POSTHOG_HOST: z
    .string()
    .url()
    .default("https://us.i.posthog.com"),
});

const serverSchema = publicSchema.extend({
  // Auth.js — required at runtime.
  AUTH_SECRET: z.string().min(32, "Generate with: openssl rand -base64 33"),
  // Only needed in deployed Workers; in `next dev`, Auth.js reads NEXTAUTH_URL
  // or falls back to the request origin. Kept optional for dev convenience.
  AUTH_URL: z.string().url().optional(),

  // App-layer encryption for Deepgram key fields (added in Phase 5).
  APP_ENCRYPTION_KEY: z.string().min(32).optional(),

  // Worker var (wrangler.toml [env.X.vars]) — bootstrap super-admin.
  // Same value on dev and prod today; the schema default catches
  // local `next dev` runs that haven't set it.
  SUPER_ADMIN_EMAIL: z.string().email().default("mike@brevoort.com"),

  // Resend — required for magic-link emails. Optional in dev (falls back to
  // logging the link to console — see src/lib/auth.ts).
  RESEND_API_KEY: z.string().min(1).optional(),
  // Worker var — Resend "from" address. Both envs default to the prod
  // domain because Resend is only configured for speakist.ai (no
  // separate dev sender domain exists).
  RESEND_FROM_EMAIL: z.string().email().default("noreply@speakist.ai"),

  // Worker var — public TestFlight invite. Read by marketing pages
  // and dashboard to surface the right invite per env. Defaulted to
  // the dev invite so a forgotten wrangler.toml entry doesn't render
  // an empty link in `next dev`.
  IOS_TESTFLIGHT_URL: z.string().url().default("https://testflight.apple.com/join/5jqHKMnu"),

  // Stripe (Phase 4).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  // Deepgram (Phase 6) — used server-side to mint short-lived keys.
  DEEPGRAM_PROJECT_ID: z.string().min(1).optional(),
  DEEPGRAM_PROJECT_KEY: z.string().min(1).optional(),

  // Polish-prompt prod → dev mirror. Both are env-specific by design —
  // only set on prod, never on dev (the receiver doesn't need them).
  // See docs/polish-prompt-mirror.md for the one-time setup.
  //
  //   * DEV_MIRROR_BACKEND_URL — Worker var in wrangler.toml's
  //     [env.production.vars]; the dev Worker's base URL. The sender
  //     POSTs to ${DEV_MIRROR_BACKEND_URL}/api/admin/polish-prompts/mirror-receive.
  //   * DEV_MIRROR_TOKEN       — Worker secret on prod; an ssat_ token
  //     minted on /admin/tokens of the DEV environment with scope
  //     prompts:write. Set via `wrangler secret put DEV_MIRROR_TOKEN
  //     --env production`. Never lives in plain config.
  //
  // Both optional so dev and local-dev builds parse the schema cleanly.
  // The /api/admin/polish-prompts/mirror endpoint surfaces a 412
  // "preconditions not met" if either is missing when invoked, with
  // pointers to the doc.
  DEV_MIRROR_BACKEND_URL: z.string().url().optional(),
  DEV_MIRROR_TOKEN: z.string().min(1).optional(),
});

export const env = {
  public: publicSchema.parse({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  }),
  get server() {
    if (typeof window !== "undefined") {
      throw new Error("env.server accessed in client context");
    }
    // Coerce empty-string env vars → undefined before validation.
    // Zod's `.optional()` only treats undefined as "absent"; an empty
    // string passes the optional gate but then fails the inner
    // `.min(1)` / `.url()` / `.email()` constraint. That's unintuitive
    // when a user has `KEY=` (no value) in their .env.local — they
    // reasonably expect that to behave the same as omitting the line
    // entirely. Same coercion lets `.default(...)` actually fire for
    // blank-but-present keys, since `.default()` only kicks in for
    // undefined.
    //
    // Worker prod env is unaffected — values there are either set or
    // absent, never empty strings. Purely a `.env.local` quality-of-
    // life fix.
    const sanitized: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      sanitized[k] = typeof v === "string" && v.length === 0 ? undefined : v;
    }
    const parsed = serverSchema.safeParse(sanitized);
    if (!parsed.success) {
      console.error("❌ Invalid server env:", parsed.error.flatten().fieldErrors);
      throw new Error("Invalid server env");
    }
    return parsed.data;
  },
};
