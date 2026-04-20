import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Wires Cloudflare bindings (D1, KV, R2, Queues) into `next dev` so
// `getCloudflareContext().env.DB` works locally the same way it does in the
// deployed Worker. Without this, the dev server has no D1 binding.
//
// `environment: "dev"` tells OpenNext to read bindings from the [env.dev]
// section of wrangler.toml (both our environments are explicitly named; no
// top-level env exists). The helper is a no-op in production / build.
initOpenNextCloudflareForDev({ environment: "dev" });

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
