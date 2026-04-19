// Next.js middleware. Runs before each request match to handle coarse route
// protection. The real authz work (membership, role, super-admin) happens
// per-route inside the page/action via src/lib/authz.ts.
//
// For /dashboard/* we only check cookie-presence to avoid a DB lookup at
// the edge. A forged cookie would fail downstream when the page calls
// requireUser(). This keeps the middleware cheap + the security boundary
// correct.

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIE_CANDIDATES.some((name) => req.cookies.has(name));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/dashboard") && !hasSessionCookie(req)) {
    const signIn = new URL("/auth/signin", req.url);
    signIn.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
