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
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { env } from "../env";

export const auth = createNeonAuth({
  baseUrl: env.NEON_AUTH_BASE_URL,
  cookies: {
    secret: env.NEON_AUTH_COOKIE_SECRET,
    sessionDataTtl: 60,
  },
});
