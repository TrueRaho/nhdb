// The authorization gate. Every path that reaches the database goes through one
// of these, and `userId` is only ever produced here — never accepted from a
// client. A Server Action is a public POST endpoint (see
// node_modules/next/dist/docs/01-app/02-guides/data-security.md), so a hashtag
// arriving from the browser says nothing about who owns it.
//
// The three entry points differ only in how they refuse:
//   requireUserId()           — throws; for Server Actions and Route Handlers.
//   requireUserIdOrRedirect() — redirects; for Server Components.
//   getUserId()               — returns null; for the rare "logged in?" branch.
//
// `server-only` makes importing this from a client component a build error.
import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "./auth/server";
import { authPath, SIGN_IN_PATH, VERIFY_PATH } from "./auth/paths";

/**
 * Re-exported so callers gate and redirect from one import. SIGN_IN_PATH is
 * where an unauthenticated visitor is sent, VERIFY_PATH where a signed-in but
 * unverified one goes; proxy.ts reads the same constants.
 */
export { SIGN_IN_PATH, VERIFY_PATH } from "./auth/paths";

/**
 * Thrown by requireUserId() when there is no usable session.
 *
 * `name` is what callers match on: the /api/scrape route maps it to HTTP 401,
 * and matching the name (not the message) keeps that from misfiring on an
 * unrelated error that happens to mention authorization.
 */
export class UnauthorizedError extends Error {
  name = "UnauthorizedError";
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

/**
 * The current user, or null.
 *
 * Wrapped in React's `cache` so a render that gates a page and then runs three
 * data reads pays for one session lookup. (The SDK also caches the session
 * payload in a signed cookie, so even a miss here is usually not a network
 * call.)
 *
 * Never call this from inside a `"use cache"` function — reading cookies there
 * is prohibited, which is exactly why lib/titles.ts takes `userId` as an
 * argument instead of reaching for the session itself.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const { data, error } = await auth.getSession();
  const user = data?.user;
  if (error || !data?.session || !user?.id) return null;
  return {
    id: user.id,
    email: user.email ?? "",
    name: user.name ?? "",
    emailVerified: user.emailVerified === true,
  };
});

/** The current user's id, or null when nobody is signed in. */
export async function getUserId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

/**
 * The current user's id, or throw.
 *
 * For Server Actions and Route Handlers: both are reachable by direct POST
 * regardless of which page rendered, so neither may lean on a page-level check.
 */
export async function requireUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  if (!user.emailVerified) throw new UnauthorizedError("Email not verified");
  return user.id;
}

/**
 * The current user's id, or redirect to sign-in.
 *
 * For Server Components. proxy.ts already turns away unauthenticated
 * navigations, so this is the second of the two checks the docs ask for —
 * it is what makes the page correct on its own if the proxy matcher ever stops
 * covering it.
 */
export async function requireUserIdOrRedirect(next = "/"): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect(authPath(SIGN_IN_PATH, next));
  if (!user.emailVerified) redirect(authPath(VERIFY_PATH, next));
  return user.id;
}
