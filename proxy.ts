// Route protection, first layer. Turns unauthenticated navigations around
// before a page renders; it is NOT the authorization boundary — every Server
// Action, Route Handler and page re-checks the session itself through
// lib/session.ts, because a proxy matcher is a configuration file and
// authorization must not depend on one staying right.
//
// Wrapping auth.middleware() instead of exporting it directly, for two reasons.
// The SDK's login redirect carries the request's query string over but not its
// path, so a share-sheet tap on /add/177013 while signed out would land in the
// library instead of on the title it was asked about. Passing the path as
// `next` lets the sign-in action send the user back where they were going. And
// the session cookie it refreshes has to reach this request's render too — see
// withIssuedCookies.
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";
import { authPath, SIGN_IN_PATH, VERIFY_PATH } from "@/lib/auth/paths";

export default async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // API handlers own their authorization and return JSON 401s, never HTML.
  // Verification must also work before sign-up has issued a session.
  if ((pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) || pathname === VERIFY_PATH || pathname.startsWith("/design-preview")) {
    return NextResponse.next();
  }
  const next = `${pathname}${search}`;
  const loginUrl = authPath(SIGN_IN_PATH, next);
  return withIssuedCookies(request, await auth.middleware({ loginUrl })(request));
}

/**
 * Lets the page rendered for this request read the cookies the SDK just issued.
 *
 * When the 60s session cache has lapsed, the SDK re-checks the session with
 * Neon Auth and re-issues the cache cookie — on the *response*. The page,
 * though, reads the *request's* cookie header, so without this it missed the
 * fresh cache and asked Neon Auth a second time, on the render's critical path.
 * Only a pass-through is rendered here; redirects (sign-in, OAuth) go as-is.
 */
function withIssuedCookies(request: NextRequest, response: NextResponse): NextResponse {
  const issued = response.headers.getSetCookie();
  if (issued.length === 0 || !response.headers.has("x-middleware-next")) return response;

  const jar = new Map<string, string>();
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  for (const cookie of issued) {
    const [pair, ...attributes] = cookie.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    // The SDK expires a cookie with Max-Age=0 (see its serializeSetCookie).
    if (attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) jar.delete(name);
    else jar.set(name, pair.slice(at + 1).trim());
  }

  const headers = new Headers(request.headers);
  headers.set("cookie", Array.from(jar, ([name, value]) => `${name}=${value}`).join("; "));
  const forwarded = NextResponse.next({ request: { headers } });
  for (const cookie of issued) forwarded.headers.append("set-cookie", cookie);
  return forwarded;
}

export const config = {
  // Everything except static assets and the icon route. /api/auth and the
  // sign-in/sign-up screens are skipped by the SDK (DEFAULT_AUTH_SKIP_ROUTES),
  // so they do not need to be excluded here — but the icon does, or the
  // sign-in page would render with a broken one.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon).*)"],
};
