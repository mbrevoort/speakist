// Auth.js catch-all route handler.
//
// Must be edge-compatible for Cloudflare Pages: `next-on-pages` wraps this
// into a Worker. Drizzle on D1 is edge-compatible; Resend's fetch-based API
// is edge-compatible. Don't import anything that needs Node builtins here.

export const runtime = "edge";

import { getAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const { handlers } = await getAuth();
  return handlers.GET(req);
}

export async function POST(req: Request) {
  const { handlers } = await getAuth();
  return handlers.POST(req);
}
