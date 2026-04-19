// Next.js middleware. Kept tiny on purpose — the heavy lifting happens per
// route via the authz helpers in src/lib/authz.ts.
//
// For Phase 1 we don't redirect unauthenticated users anywhere — the
// placeholder landing page is public. Phase 3 introduces /dashboard and
// /admin path guards here.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
