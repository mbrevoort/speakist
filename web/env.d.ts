// Type declarations for Cloudflare bindings surfaced via
// `@cloudflare/next-on-pages`. These match the [[d1_databases]] etc. blocks
// in wrangler.toml — if you add a binding there, add it here too.

import type { D1Database } from "@cloudflare/workers-types";

declare global {
  namespace CloudflareEnv {
    interface Env {
      /** Main application database (Drizzle client is initialized from this). */
      DB: D1Database;

      // Phase 4+: additional bindings will go here as we add them.
      // KV: KVNamespace;
      // AUDIO: R2Bucket;
      // QUEUE: Queue;
    }
  }
}

export {};
