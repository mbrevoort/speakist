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

// Security response headers, applied to every route on every env.
//
//   * CSP is scoped to what the app actually loads — broaden only when
//     adding a third-party service that genuinely needs it. `'unsafe-inline'`
//     + `'unsafe-eval'` on script-src are required for Next.js's bootstrap
//     + RSC hydration; nonce-based hardening is doable but invasive (every
//     server component would need to thread the nonce through), and the
//     residual risk is acceptable for a logged-in dashboard product.
//   * `frame-ancestors 'none'` blocks anyone iframing us — both
//     clickjacking defense and the modern replacement for
//     `X-Frame-Options: DENY` (kept too for legacy clients).
//   * `connect-src https:` is intentionally permissive — the dashboard
//     fans out to a handful of HTTPS endpoints (Stripe, Deepgram, Groq
//     via the Worker, possible future analytics) and enumerating each
//     is fragile. Blanket HTTPS-only blocks mixed content while not
//     blocking sub-resources.
//
// HSTS = 2y + includeSubDomains + preload. Only honored over HTTPS;
// HTTP responses ignore the directive by spec. `includeSubDomains`
// covers `downloads.speakist.ai` too — both endpoints are HTTPS-only
// so it's safe to lock them in.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // Deny powerful Web APIs the app doesn't use. Every entry left
    // unset would default to "self" — explicit denials make the
    // permission posture auditable and shut down feature-detection
    // exfiltration vectors.
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
