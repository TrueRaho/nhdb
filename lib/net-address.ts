// Which network addresses a server may connect to, for every place that fetches
// a URL it did not choose: the app's scraper-host calls and cover proxy
// (lib/net-guard.ts, lib/cover-proxy.ts) and the scraper itself, which runs as
// plain Node on a user's own machine — so, unlike net-guard, no "server-only".

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UnsafeUrlError extends Error {
  name = "UnsafeUrlError";
}

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
 * The DNS half of the check, for a host name that has already passed some
 * allow-list (the scraper URL rules above, a site's cover hosts). ALL resolved
 * addresses must be public.
 */
export async function assertPublicHostname(host: string): Promise<void> {
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("That address is not routable from the server");
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
