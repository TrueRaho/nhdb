import { requireUserId, UnauthorizedError } from "@/lib/session";
import { fetchCover } from "@/lib/cover-proxy";
import { checkCoverByteBudget, consumeCoverBudget, consumeCoverRequestBudget } from "@/lib/rate-limit";

// GET /api/cover?src=<cover URL>&ref=<title page origin> — the cover, fetched
// with the title's site as Referer. Every <img> of a cover points here
// (lib/sources.ts `coverSrc`); the rules for what may be fetched live in
// lib/cover-proxy.ts.
//
// Signed-in users only: an open endpoint would hand anyone a fetcher that
// spoofs these sites' Referer. The <img> is same-origin, so its request carries
// the session cookie. For the same reason the answer is cached `private` — in
// the browser, never by a shared cache that would serve it without the check.

// What a response from here may be used as: an image on this origin's pages,
// and nothing else — no sniffing it into another type, no scripts if it is
// opened directly, no embedding by other sites.
const LOCKED_DOWN = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// A cover URL is content-addressed or at least never re-pointed, so a copy
// stays good. A missing one is remembered briefly; anything else is retried.
const CACHE_OK = "private, max-age=2592000, immutable";
const CACHE_MISSING = "private, max-age=3600";

function refuse(status: number, reason: string, cache = "no-store"): Response {
  return new Response(reason, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": cache, ...LOCKED_DOWN },
  });
}

function overBudget(reason: string, retryAfterSeconds: number) {
  const response = refuse(429, reason);
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (error) {
    if (error instanceof UnauthorizedError) return refuse(401, error.message);
    console.error("session lookup failed:", error);
    return refuse(503, "Authentication unavailable");
  }

  try {
    const requests = await consumeCoverRequestBudget(userId);
    if (!requests.allowed) return overBudget("Cover request limit reached. Try again later.", requests.retryAfterSeconds);
    const bytes = await checkCoverByteBudget(userId);
    if (!bytes.allowed) return overBudget("Monthly cover budget reached. Try again later.", bytes.retryAfterSeconds);
  } catch (error) {
    console.error("cover budget unavailable:", error);
    return refuse(503, "Cover budget unavailable");
  }

  const params = new URL(request.url).searchParams;
  const cover = await fetchCover(params.get("src") ?? "", params.get("ref"));
  if (!cover.ok) {
    return refuse(cover.status, cover.reason, cover.status === 404 ? CACHE_MISSING : "no-store");
  }
  try {
    const budget = await consumeCoverBudget(userId, cover.body.byteLength);
    if (!budget.allowed) {
      return overBudget("Monthly cover budget reached. Try again later.", budget.retryAfterSeconds);
    }
  } catch (error) {
    console.error("cover budget unavailable:", error);
    return refuse(503, "Cover budget unavailable");
  }
  return new Response(cover.body, {
    headers: {
      "Content-Type": cover.contentType,
      "Content-Length": String(cover.body.byteLength),
      "Cache-Control": CACHE_OK,
      ...LOCKED_DOWN,
    },
  });
}
