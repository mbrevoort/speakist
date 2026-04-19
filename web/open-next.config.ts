// OpenNext Cloudflare adapter configuration.
//
// OpenNext reads this file at build time to decide how to emit the Worker.
// For Phase 1 we use the default build: no incremental cache, no queue for
// ISR, no tag cache. If/when we need image optimization or ISR we can wire
// in the KV-based incremental cache — see:
// https://opennext.js.org/cloudflare/caching

import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // incrementalCache: kvIncrementalCache,
  // queue: ...,
  // tagCache: ...,
});
