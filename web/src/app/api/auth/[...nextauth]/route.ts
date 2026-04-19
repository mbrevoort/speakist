// Auth.js catch-all route handler.
//
// OpenNext Cloudflare deploys this to a Worker with nodejs_compat enabled, so
// we use the default Node.js runtime — Auth.js + Drizzle + Resend all run
// unmodified. No `export const runtime = "edge"` needed (or wanted).

import { getAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const { handlers } = await getAuth();
  return handlers.GET(req);
}

export async function POST(req: Request) {
  const { handlers } = await getAuth();
  return handlers.POST(req);
}
