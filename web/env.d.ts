// Type declarations for Cloudflare bindings surfaced via
// `@opennextjs/cloudflare`. `getCloudflareContext()` is typed against the
// global `CloudflareEnv` interface — match the [[d1_databases]] etc. blocks
// in wrangler.toml here so `env.DB` is typed.

import type { D1Database } from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    /** Main application database (Drizzle client is initialized from this). */
    DB: D1Database;

    // Phase 4+: additional bindings will go here as we add them.
    // CACHE: KVNamespace;
    // AUDIO: R2Bucket;
    // QUEUE: Queue;
  }
}

export {};
