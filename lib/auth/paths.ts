export const SIGN_IN_PATH = "/auth/sign-in";
export const SIGN_UP_PATH = "/auth/sign-up";
export const VERIFY_PATH = "/auth/verify-email";

/**
 * Document titles of the auth screens. Distinct titles are what makes switching
 * between them audible (Next's route announcer speaks on a title change), and
 * the form sets them itself when it switches sign-in/sign-up without a navigation.
 */
export const AUTH_TITLES: Record<string, string> = {
  "sign-in": "Sign in · nhdb",
  "sign-up": "Create account · nhdb",
  "verify-email": "Verify email · nhdb",
};

/** Only application navigations may be used as post-auth destinations. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\x00-\x20\x7f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://nhdb.invalid");
    const pathname = decodeURIComponent(url.pathname);
    if (url.origin !== "https://nhdb.invalid" || pathname.startsWith("//") || pathname.includes("\\")) return "/";
    if (/^\/(?:auth|api)(?:\/|$)/.test(pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function authPath(path: string, next: unknown): string {
  return `${path}?next=${encodeURIComponent(safeReturnPath(next))}`;
}
