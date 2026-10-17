import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  requireUserId: vi.fn(async () => "user-a"),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
// The fetch rules have their own suite (lib/cover-proxy.test.ts); here they are
// stubbed so these cases pin the gate, what reaches the proxy, and the headers.
vi.mock("@/lib/cover-proxy", () => ({ fetchCover: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeCoverBudget: vi.fn(), consumeCoverRequestBudget: vi.fn(), checkCoverByteBudget: vi.fn(),
}));

import { GET } from "./route";
import { requireUserId, UnauthorizedError } from "@/lib/session";
import { fetchCover } from "@/lib/cover-proxy";
import { coverSrc } from "@/lib/sources";
import { checkCoverByteBudget, consumeCoverBudget, consumeCoverRequestBudget } from "@/lib/rate-limit";

const SRC = "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/abc.webp";
const PAGE = "https://hitomi.la/galleries/1234567.html";
const get = (src = SRC) => GET(new Request(`http://localhost/api/cover?src=${encodeURIComponent(src)}`));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

beforeEach(() => {
  vi.mocked(requireUserId).mockReset().mockResolvedValue("user-a");
  vi.mocked(fetchCover).mockReset().mockResolvedValue({ ok: true, body: JPEG, contentType: "image/jpeg" });
  vi.mocked(consumeCoverBudget).mockReset().mockResolvedValue({ allowed: true, used: 4, limit: 100 });
  vi.mocked(consumeCoverRequestBudget).mockReset().mockResolvedValue({ allowed: true, used: 1, limit: 10_000 });
  vi.mocked(checkCoverByteBudget).mockReset().mockResolvedValue({ allowed: true, used: 0, limit: 100 });
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/cover", () => {
  it("serves the cover as an image only this origin may use", async () => {
    const res = await get();
    expect(fetchCover).toHaveBeenCalledWith(SRC, null);
    expect(consumeCoverBudget).toHaveBeenCalledWith("user-a", JPEG.byteLength);
    expect(consumeCoverRequestBudget).toHaveBeenCalledExactlyOnceWith("user-a");
    expect(checkCoverByteBudget).toHaveBeenCalledExactlyOnceWith("user-a");
    expect(consumeCoverRequestBudget).toHaveBeenCalledBefore(vi.mocked(checkCoverByteBudget));
    expect(checkCoverByteBudget).toHaveBeenCalledBefore(vi.mocked(fetchCover));
    expect(fetchCover).toHaveBeenCalledBefore(vi.mocked(consumeCoverBudget));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(JPEG.byteLength));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // Gated content: the browser may keep it, a shared cache may not.
    expect(res.headers.get("cache-control")).toMatch(/^private,/);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("passes the title page's origin through as the referer to send", async () => {
    await GET(new Request(
      `http://localhost/api/cover?src=${encodeURIComponent(SRC)}&ref=${encodeURIComponent("https://hitomi.la")}`,
    ));
    expect(fetchCover).toHaveBeenCalledWith(SRC, "https://hitomi.la");
  });

  it("reads exactly what coverSrc builds for an <img>", async () => {
    // The client and the route agree on the address: a cover on any CDN, its
    // page on any site, both percent-encoded into one same-origin URL.
    const cover = "https://cdn.unrelated-images.example/covers/4242.jpg?w=350&h=500";
    const page = "https://www.some-gallery.net/g/4242/?utm_source=x#page-3";
    const src = coverSrc(cover, page);
    expect(src.startsWith("/api/cover?")).toBe(true);
    await GET(new Request(`http://localhost${src}`));
    expect(fetchCover).toHaveBeenCalledWith(cover, "https://www.some-gallery.net");

    vi.mocked(fetchCover).mockClear();
    await GET(new Request(`http://localhost${coverSrc(SRC, PAGE)}`));
    expect(fetchCover).toHaveBeenCalledWith(SRC, "https://hitomi.la");

    vi.mocked(fetchCover).mockClear();
    await GET(new Request(`http://localhost${coverSrc(SRC)}`));
    expect(fetchCover).toHaveBeenCalledWith(SRC, null);
  });

  it("fetches nothing for a signed-out request", async () => {
    vi.mocked(requireUserId).mockRejectedValue(new UnauthorizedError("Unauthorized"));
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchCover).not.toHaveBeenCalled();
    expect(consumeCoverBudget).not.toHaveBeenCalled();
    expect(consumeCoverRequestBudget).not.toHaveBeenCalled();
    expect(checkCoverByteBudget).not.toHaveBeenCalled();
  });

  it("answers 503 and fetches nothing when the session cannot be checked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireUserId).mockRejectedValue(new Error("auth backend down"));
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchCover).not.toHaveBeenCalled();
  });

  it("says why a cover could not be served, and does not cache the failure", async () => {
    vi.mocked(fetchCover).mockResolvedValue({ ok: false, status: 502, reason: "upstream answered 403" });
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("upstream answered 403");
    expect(consumeCoverBudget).not.toHaveBeenCalled();
    expect(consumeCoverRequestBudget).toHaveBeenCalledOnce(); // Failed fetches still spend a request.
  });

  it("remembers a missing cover briefly", async () => {
    vi.mocked(fetchCover).mockResolvedValue({ ok: false, status: 404, reason: "upstream answered 404" });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("hands a missing src to the proxy as empty, which refuses it", async () => {
    vi.mocked(fetchCover).mockResolvedValue({ ok: false, status: 400, reason: "not a web address" });
    const res = await GET(new Request("http://localhost/api/cover"));
    expect(fetchCover).toHaveBeenCalledWith("", null);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([3_221_225_472, 4_000_000_000])("returns uncached 429 with Retry-After for a byte ceiling of %s", async (limit) => {
    vi.mocked(consumeCoverBudget).mockResolvedValue({ allowed: false, limit, retryAfterSeconds: 1000 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1000");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("budget reached");
  });

  it("serves no image when the budget store is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(consumeCoverBudget).mockRejectedValue(new Error("db down"));
    expect((await get()).status).toBe(503);
  });

  it.each([10_000, 500_000])("denies an exhausted request ceiling of %s before fetching", async (limit) => {
    vi.mocked(consumeCoverRequestBudget).mockResolvedValue({ allowed: false, limit, retryAfterSeconds: 300 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchCover).not.toHaveBeenCalled();
    expect(checkCoverByteBudget).not.toHaveBeenCalled();
    expect(consumeCoverBudget).not.toHaveBeenCalled();
  });

  it.each([3_221_225_472, 4_000_000_000])("pre-check denies an exhausted byte ceiling of %s before fetching", async (limit) => {
    vi.mocked(checkCoverByteBudget).mockResolvedValue({ allowed: false, limit, retryAfterSeconds: 1000 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1000");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchCover).not.toHaveBeenCalled();
    expect(consumeCoverBudget).not.toHaveBeenCalled();
  });

  it.each([consumeCoverRequestBudget, checkCoverByteBudget])("fails closed before fetching when a preflight store fails (%#)", async (gate) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(gate).mockRejectedValue(new Error("db down"));
    expect((await get()).status).toBe(503);
    expect(fetchCover).not.toHaveBeenCalled();
    expect(consumeCoverBudget).not.toHaveBeenCalled();
  });
});
