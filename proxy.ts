// Route protection, first layer. Turns unauthenticated navigations around
// before a page renders; it is NOT the authorization boundary — every Server
// Action, Route Handler and page re-checks the session itself through
// lib/session.ts, because a proxy matcher is a configuration file and
// authorization must not depend on one staying right.
//
// Wrapping auth.middleware() instead of exporting it directly, for one reason:
// the SDK's login redirect carries the request's query string over but not its
// path, so a share-sheet tap on /add/177013 while signed out would land in the
// library instead of on the title it was asked about. Passing the path as
// `next` lets the sign-in action send the user back where they were going.
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";
import { authPath, SIGN_IN_PATH, VERIFY_PATH } from "@/lib/auth/paths";

export default async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // API handlers own their authorization and return JSON 401s, never HTML.
  // Verification must also work before sign-up has issued a session.
  if ((pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) || pathname === VERIFY_PATH) {
    return NextResponse.next();
  }
  const next = `${pathname}${search}`;
  const loginUrl = authPath(SIGN_IN_PATH, next);
  return auth.middleware({ loginUrl })(request);
}

export const config = {
  // Everything except static assets and the icon route. /api/auth and the
  // sign-in/sign-up screens are skipped by the SDK (DEFAULT_AUTH_SKIP_ROUTES),
  // so they do not need to be excluded here — but the icon does, or the
  // sign-in page would render with a broken one.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon).*)"],
};
