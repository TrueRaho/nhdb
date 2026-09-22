// SSRF guard for user-supplied scraper hosts.
//
// Every user registers their own scraper URL and the *server* fetches it. That
// is a request forgery primitive by construction: without this module, a signed
// -in user could point the deployment at anything it can reach and read the
// reply through the scrape response. The rules below are the whole defence, so
// each one says what it is for.

import "server-only";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UnsafeUrlError extends Error {
  name = "UnsafeUrlError";
}

/** Longest URL we will store; also the scraper_endpoints.url column width. */
export const MAX_URL_LENGTH = 255;

// IPv4 ranges that must never be reached from the server. 169.254.0.0/16 is the
// one people forget and the one that matters most — it carries the cloud
// instance-metadata endpoint (169.254.169.254).
const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8],  // "this network"
  [0x0a000000, 8],  // 10/8 private
  [0x64400000, 10], // 100.64/10 carrier-grade NAT
  [0x7f000000, 8],  // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local + metadata
  [0xac100000, 12], // 172.16/12 private
  [0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99/24 6to4 relay anycast
  [0xc0a80000, 16], // 192.168/16 private
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xc6336400, 24], // 198.51.100/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113/24 TEST-NET-3
  [0xe0000000, 4],  // 224/4 multicast
  [0xf0000000, 4],  // 240/4 reserved, incl. 255.255.255.255
];

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Expand any valid IPv6 text form to its 8 groups, or null. */
function v6Groups(address: string): number[] | null {
  let text = address;
  // An IPv4-mapped/embedded tail ("::ffff:1.2.3.4") becomes two groups.
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const value = v4ToInt(tail[1]);
    if (value === null) return null;
    text = text.slice(0, -tail[1].length) +
      ((value >>> 16) & 0xffff).toString(16) + ":" + (value & 0xffff).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = back === null
    ? head
    : [...head, ...Array(8 - head.length - back.length).fill("0"), ...back];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

/**
 * Is this address one the server may connect to?
 *
 * IPv4-mapped and NAT64-embedded IPv6 addresses are unwrapped and judged as the
 * IPv4 address they carry — otherwise `::ffff:169.254.169.254` walks straight
 * past an IPv4-only block list.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = v4ToInt(address);
    if (value === null) return false;
    return !V4_BLOCKED.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (version !== 6) return false;
  const groups = v6Groups(address);
  if (groups === null) return false;

  const isZero = groups.every((g) => g === 0);
  if (isZero) return false;                                   // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return false;          // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return false;          // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return false;          // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // 2001:db8::/32 docs

  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64) embed an IPv4 address.
  const embedsV4 =
    (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) ||
    (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0));
  if (embedsV4) {
    const value = ((groups[6] << 16) | groups[7]) >>> 0;
    const dotted = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
    return isPublicAddress(dotted);
  }
  return true;
}

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

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve ${host}`);
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new UnsafeUrlError(`${host} resolves to a private address the server may not reach`);
    }
  }
}
