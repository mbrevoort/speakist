import type { NextConfig } from "next";

// `setupDevPlatform()` wires Cloudflare bindings (D1, KV, R2, Queues) into
// `next dev` so `getRequestContext().env.DB` works locally the same way it
// does in deployed Workers. Without this, the dev server has no DB binding.
// See: https://developers.cloudflare.com/pages/framework-guides/nextjs/ssr/local-development/
if (process.env.NODE_ENV === "development") {
  const { setupDevPlatform } = await import("@cloudflare/next-on-pages/next-dev");
  await setupDevPlatform();
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next-on-pages` handles Worker output; no custom output mode needed here.
};

export default nextConfig;
