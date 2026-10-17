// Fetches one stored cover for the /api/cover route.
//
// Why a proxy at all: an image host that refuses hotlinks only serves a
// request whose Referer is the gallery's own site, and neither a browser on
// this origin nor the Next image optimizer (it forwards no headers) can send
// that. Hitomi's thumbnail host is one such CDN; any site can become one, so
// every cover goes through here, with the title page's origin as Referer.
//
// The URL comes from the browser and titles come from any site, so this is a
// server-side fetch of arbitrary client input — SSRF, by construction. There
// is no list of image hosts to hide behind any more; these rules are the whole
// defence, and each one matters on its own:
//   * a web address only (lib/sources.ts parseWebUrl): http(s), a DNS name (no
//     IP literal), no credentials, the scheme's own port — so nothing but a
//     web server's port 80/443 is ever dialled;
//   * every resolved address must be public (lib/net-address.ts), checked again
//     before each hop — a name can point anywhere, including 169.254.169.254;
//   * redirects are followed by hand, at most three, each hop re-checked;
//   * the answer must BE an image — the type is sniffed from the bytes and set
//     by us, never echoed, so an SVG or an HTML page cannot pass for a cover and
//     run on this origin, and a JSON/HTML answer from some internal-looking
//     service is never relayed — and it is size-capped.
// What is left is what a signed-in user can do with it: fetch a public image
// through the deployment, within the byte budgets enforced by the route.

import "server-only";
import { assertPublicHostname } from "./net-address";
import { parseWebUrl } from "./sources";

// Covers are thumbnails, typically well under 500 KB.
export const MAX_COVER_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type CoverResult =
  | { ok: true; body: Uint8Array<ArrayBuffer>; contentType: string }
  | { ok: false; status: 400 | 404 | 502 | 504; reason: string };

const fail = (status: 400 | 404 | 502 | 504, reason: string): CoverResult => ({ ok: false, status, reason });

const startsWith = (b: Uint8Array, at: number, ascii: string) =>
  b.length >= at + ascii.length && [...ascii].every((c, i) => b[at + i] === c.charCodeAt(0));

/** The raster type these bytes are, or null. SVG is deliberately not one. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (startsWith(b, 0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (startsWith(b, 0, "GIF87a") || startsWith(b, 0, "GIF89a")) return "image/gif";
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "image/webp";
  if (startsWith(b, 4, "ftyp") && (startsWith(b, 8, "avif") || startsWith(b, 8, "avis"))) return "image/avif";
  return null;
}

// The whole body, or null once it passes the cap (the rest is not downloaded).
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The cover at `raw`, fetched as a browser on `referer`'s site would. The
 * referer is reduced to an origin (what browsers send cross-site anyway); a
 * missing or unusable one means no Referer at all.
 */
export async function fetchCover(raw: string, referer?: string | null): Promise<CoverResult> {
  const first = parseWebUrl(raw);
  if (!first) return fail(400, "not a web address");
  const ref = referer ? parseWebUrl(referer) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let url = first;
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHostname(url.hostname);
      const res = await fetch(url, {
        headers: {
          ...(ref ? { Referer: `${ref.origin}/` } : {}),
          "User-Agent": USER_AGENT,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS) return fail(502, `upstream redirected (${res.status}) too often or nowhere`);
        let next: URL | null;
        try {
          next = parseWebUrl(new URL(location, url).toString());
        } catch {
          next = null;
        }
        if (!next) return fail(502, "upstream redirected to an address that is not a web address");
        url = next;
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        return fail(404, `upstream answered ${res.status}`);
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return fail(502, `upstream answered ${res.status}`);
      }
      if (Number(res.headers.get("content-length")) > MAX_COVER_BYTES) {
        await res.body?.cancel().catch(() => {});
        return fail(502, "cover is too large");
      }
      const body = await readCapped(res, MAX_COVER_BYTES);
      if (!body) return fail(502, "cover is too large");
      const contentType = sniffImageType(body);
      if (!contentType) return fail(502, "upstream did not answer with an image");
      return { ok: true, body, contentType };
    }
  } catch (e) {
    if (controller.signal.aborted) return fail(504, "upstream timed out");
    // UnsafeUrlError (a private address), a DNS failure, a reset connection.
    return fail(502, e instanceof Error ? e.message : "upstream fetch failed");
  } finally {
    clearTimeout(timer);
  }
}
