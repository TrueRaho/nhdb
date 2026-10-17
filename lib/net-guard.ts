// SSRF guard for user-supplied scraper hosts.
//
// Every user registers their own scraper URL and the *server* fetches it. That
// is a request forgery primitive by construction: without this module, a signed
// -in user could point the deployment at anything it can reach and read the
// reply through the scrape response. The rules below are the whole defence, so
// each one says what it is for.

import "server-only";
import { isIP } from "node:net";
import { assertPublicHostname, isPublicAddress, UnsafeUrlError } from "./net-address";

export { assertPublicHostname, isPublicAddress, UnsafeUrlError };

/** Longest URL we will store; also the scraper_endpoints.url column width. */
export const MAX_URL_LENGTH = 255;

/**
 * Syntactic checks only — no DNS. Used to give the settings form immediate
 * feedback and to normalise what gets stored.
 *
 * `http:` is rejected outright except against a loopback host outside
 * production, which is the `pnpm scraper` case (DISABLE_NGROK=1 on :3333). In
 * production loopback IS the deployment, so that exemption would be the SSRF.
 */
export function normalizeScraperUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new UnsafeUrlError("Enter a scraper URL");
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new UnsafeUrlError(`URL must be ${MAX_URL_LENGTH} characters or fewer`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL — include https://");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Remove the username/password from the URL");
  }
  if (url.search || url.hash) {
    throw new UnsafeUrlError("Remove the query string and fragment from the URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || (isIP(host) !== 0 && !isPublicAddress(host) && /^(127\.|::1$)/.test(host));
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV === "production" || !loopback) {
      throw new UnsafeUrlError("Use https:// — plain http is only allowed for a local scraper in development");
    }
  } else if (url.protocol !== "https:") {
    throw new UnsafeUrlError("Use an https:// URL");
  }
  // The route appends "/scrape", so keep the stored value a bare origin+path.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Full check, including DNS. Run immediately before connecting, not only when
 * the URL is saved: a name that resolved to a public address at save time can
 * resolve to 127.0.0.1 later, and only the check next to the request sees that.
 *
 * ALL resolved addresses must pass. A host that answers with one public and one
 * private address is a rebinding attempt, not a misconfiguration.
 * This is a preflight, not connection pinning: fetches must also use fetchPublic
 * (lib/public-fetch.ts), whose socket lookup returns only checked addresses.
 */
export async function assertReachableHost(rawUrl: string): Promise<void> {
  const url = new URL(normalizeScraperUrl(rawUrl));
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("That address is not routable from the server");
    return;
  }
  if (host === "localhost") {
    // Only reachable here at all because normalizeScraperUrl allows loopback
    // http outside production.
    if (process.env.NODE_ENV === "production") throw new UnsafeUrlError("localhost is not reachable from the server");
    return;
  }
  await assertPublicHostname(host);
}
