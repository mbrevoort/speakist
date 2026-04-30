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
});

export const env = {
  public: publicSchema.parse({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  }),
  get server() {
    if (typeof window !== "undefined") {
      throw new Error("env.server accessed in client context");
    }
    // Coerce empty strings → undefined before validation. Zod's
    // `.optional()` only treats undefined as "absent"; an empty
    // string passes the `.optional()` gate but then fails the
    // inner `.min(1)` / `.url()` / `.email()` constraint, which
    // is unintuitive when a user has `KEY=` (no value) in their
    // .env.local. The user reasonably expects that to mean
    // "not set", same as omitting the line entirely.
    //
    // Same coercion applies to fields with defaults: `.default()`
    // only kicks in when the value is undefined, not when it's
    // an empty string. Empty strings would otherwise fail the
    // upstream constraint (e.g. `z.string().email().default(...)`)
    // before the default could replace them.
    //
    // Worker-deployed env (where everything legit is set or
    // missing entirely) is unaffected — there are no empty
    // strings in the prod runtime env. This is purely a local-
    // dev quality-of-life fix for `.env.local` files where users
    // leave keys-without-values as a placeholder for "I'll fill
    // this in later".
    const sanitized: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      sanitized[k] = typeof v === "string" && v.length === 0 ? undefined : v;
    }
    const parsed = serverSchema.safeParse(sanitized);
    if (!parsed.success) {
      // Log every issue with its path + message + code so we can
      // actually see WHICH var is missing or malformed. The original
      // `flatten().fieldErrors`-only log printed `{}` for any error
      // whose path was empty (top-level shape failures, root-coerce
      // mismatches), which is exactly the case that's hardest to
      // debug. Issues come pre-pathed; flatten() loses that.
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
        code: i.code,
      }));
      console.error("❌ Invalid server env:");
      console.error("  issues:", issues);
      // Also surface which expected names ARE / ARE NOT present in
      // process.env so a missing AUTH_SECRET vs a malformed one is
      // distinguishable at a glance during local dev.
      const expected = [
        "NEXT_PUBLIC_SITE_URL",
        "AUTH_SECRET",
        "AUTH_URL",
        "APP_ENCRYPTION_KEY",
        "SUPER_ADMIN_EMAIL",
        "RESEND_API_KEY",
        "RESEND_FROM_EMAIL",
        "IOS_TESTFLIGHT_URL",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PUBLISHABLE_KEY",
        "DEEPGRAM_PROJECT_ID",
        "DEEPGRAM_PROJECT_KEY",
      ];
      const presence = Object.fromEntries(
        expected.map((k) => [k, typeof process.env[k] === "string" && process.env[k]!.length > 0])
      );
      console.error("  presence:", presence);
      throw new Error(
        "Invalid server env: " +
          issues.map((i) => `${i.path}: ${i.message}`).join("; ")
      );
    }
    return parsed.data;
  },
};
