// Auth.js catch-all route handler.
//
// OpenNext Cloudflare deploys this to a Worker with nodejs_compat enabled, so
// we use the default Node.js runtime — Auth.js + Drizzle + Resend all run
// unmodified. No `export const runtime = "edge"` needed (or wanted).
//
// We build the Auth.js config lazily (via getAuth) so the Drizzle adapter
// has a D1 binding — which only exists inside a request scope. Typing req
// as NextRequest matches what Auth.js's handlers expect; the Cloudflare
// workers-types global `Request` is a different shape.

import type { NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { handlers } = await getAuth();
  return handlers.GET(req);
}

export async function POST(req: NextRequest) {
  const { handlers } = await getAuth();
  return handlers.POST(req);
}
