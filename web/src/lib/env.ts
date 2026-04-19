// Centralized env parsing. Throws at import time if required vars are missing
// so we fail the build loudly rather than silently at the first request.
//
// Client-safe vars: only those prefixed with NEXT_PUBLIC_* may be read in
// browser code. Import `env.server` only from server components / route
// handlers / the seed script.

import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Secrets below are optional during Phase 1 — they're only consumed by code
  // paths that don't exist yet (Stripe webhook, Deepgram mint, Resend send).
  // We parse them as optional so `pnpm build` works before they're set.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  DEEPGRAM_PROJECT_ID: z.string().min(1).optional(),
  DEEPGRAM_PROJECT_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_EMAIL: z.string().email().default("mike@brevoort.com"),
  // Used to encrypt Deepgram keys stored in the DB (org overrides + system).
  // Generate with: openssl rand -base64 32
  APP_ENCRYPTION_KEY: z.string().min(32).optional(),
});

function parsePublic() {
  const parsed = publicSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid public env:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid public env");
  }
  return parsed.data;
}

function parseServer() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid server env:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid server env");
  }
  return parsed.data;
}

export const env = {
  public: parsePublic(),
  // Lazy getter so client bundles don't accidentally pull server vars.
  get server() {
    if (typeof window !== "undefined") {
      throw new Error("env.server accessed in client context");
    }
    return parseServer();
  },
};
