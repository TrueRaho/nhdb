// Neon Managed Better Auth — the single server-side auth instance.
//
// Everything server-side goes through this object: `auth.handler()` backs the
// catch-all route that proxies the browser's auth calls, `auth.middleware()`
// backs proxy.ts, and `auth.getSession()` is what lib/session.ts reads.
//
// Constructed at module load on purpose: a missing NEON_AUTH_BASE_URL or a
// too-short cookie secret should take the deployment down loudly rather than
// leave an app that silently treats everyone as a guest. lib/env.ts does the
// checking (see the notes there).
//
// NOTE: sessions live in a signed HTTP-only cookie whose payload the SDK caches
// for `sessionDataTtl` seconds (default 300) to avoid calling the Auth server on
// every request. That cache is why a *revoked* session can still read for up to
// five minutes. 60s trades a few more Auth round trips for a much shorter
// window, which is the right side of that trade for an app where the session is
// the only thing separating two people's collections.
import { cookies, headers } from "next/headers";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { createAuthServer, extractNeonAuthCookies, type RequestContext } from "@neondatabase/auth/server";
import { env } from "../env";

const config = {
  baseUrl: env.NEON_AUTH_BASE_URL,
  cookies: {
    secret: env.NEON_AUTH_COOKIE_SECRET,
    sessionDataTtl: 60,
  },
};

/**
 * The SDK's own Next.js request context, except that a cookie write Next
 * forbids is skipped instead of thrown.
 *
 * Once the 60s cache has lapsed, `getSession()` asks Neon Auth, and once Neon
 * Auth's own cache cookie has lapsed too (minutes after sign-in — the SDK never
 * refreshes that one in the browser) it answers with refreshed cookies, which
 * the SDK writes back. From a Server Component that write throws ("Cookies can
 * only be modified in a Server Action or Route Handler"): the page crashed on
 * the first load after a minute idle although the session was valid. Skipping
 * the write loses nothing — proxy.ts re-issues the cache cookie on navigation,
 * and Server Actions and Route Handlers still write normally.
 */
async function requestContext(): Promise<RequestContext> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return {
    getCookies: () => extractNeonAuthCookies(headerStore),
    setCookie(name, value, options) {
      try {
        cookieStore.set(name, value, options);
      } catch {
        // Rendering a Server Component: cookies are read-only here.
      }
    },
    getHeader: (name) => headerStore.get(name),
    getOrigin: () => headerStore.get("origin") || headerStore.get("referer")?.split("/").slice(0, 3).join("/") || "",
    getFramework: () => "nextjs",
  };
}

const { handler, middleware } = createNeonAuth(config);

export const auth = Object.assign(
  createAuthServer({
    baseUrl: config.baseUrl,
    context: requestContext,
    cookieSecret: config.cookies.secret,
    sessionDataTtl: config.cookies.sessionDataTtl,
  }),
  { handler, middleware },
);
