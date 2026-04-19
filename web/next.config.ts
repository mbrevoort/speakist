import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Wires Cloudflare bindings (D1, KV, R2, Queues) into `next dev` so
// `getCloudflareContext().env.DB` works locally the same way it does in the
// deployed Worker. Without this, the dev server has no D1 binding.
// The helper is a no-op in production / build contexts.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
