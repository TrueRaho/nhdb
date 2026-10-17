import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts: unknown) => Promise<{ address: string }[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));

import { fetchCover, MAX_COVER_BYTES, sniffImageType } from "./cover-proxy";
import { publicDispatcher } from "./public-fetch";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const HITOMI = "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/abc.webp";
const NH = "https://t3.nhentai.net/galleries/1/cover.jpg";
// A site the app has never heard of, its cover on a CDN that shares nothing
// with the site's own name — the case there is no host list for any more.
const ANY_PAGE = "https://www.some-gallery.net/g/4242/?utm_source=share#page-3";
const ANY_COVER = "https://cdn.unrelated-images.example/covers/4242.jpg";

const fetchMock = vi.fn<typeof fetch>();
const image = (bytes: Uint8Array = JPEG, headers: Record<string, string> = {}) =>
  new Response(bytes.slice(), { status: 200, headers });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const headersOf = (call: number) => (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sniffImageType", () => {
  it("caps a cover at exactly 1 MiB", () => {
    expect(MAX_COVER_BYTES).toBe(1024 * 1024);
  });
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  it.each([
    [JPEG, "image/jpeg"],
    [ascii("\x89PNG\r\n\x1a\n...."), "image/png"],
    [ascii("GIF89a......"), "image/gif"],
    [ascii("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
    [ascii("\0\0\0\x20ftypavif...."), "image/avif"],
  ])("reads %#", (bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it.each([
    ["svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ["html", "<!doctype html><script>alert(1)</script>"],
    ["empty", ""],
  ])("refuses %s", (_, text) => {
    expect(sniffImageType(new TextEncoder().encode(text))).toBeNull();
  });
});

describe("fetchCover — Referer", () => {
  it("fetches the cover with the title page's origin as Referer", async () => {
    fetchMock.mockResolvedValue(image());
    const r = await fetchCover(HITOMI, "https://hitomi.la/galleries/1234567.html");
    expect(r).toEqual({ ok: true, body: JPEG, contentType: "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(HITOMI);
    expect(headersOf(0).Referer).toBe("https://hitomi.la/");
    expect(init?.redirect).toBe("manual");
    expect(init).toHaveProperty("dispatcher", publicDispatcher);
    expect(lookup).toHaveBeenCalledWith("tn.gold-usergeneratedcontent.net", { all: true });
  });

  it("reduces the page to its origin — no path, query or fragment leaks upstream", async () => {
    fetchMock.mockResolvedValue(image());
    await fetchCover(ANY_COVER, ANY_PAGE);
    expect(headersOf(0).Referer).toBe("https://www.some-gallery.net/");
  });

  it("sends no Referer at all without a page", async () => {
    fetchMock.mockImplementation(async () => image());
    expect(await fetchCover(NH)).toMatchObject({ ok: true });
    expect(await fetchCover(NH, null)).toMatchObject({ ok: true });
    expect(await fetchCover(NH, "")).toMatchObject({ ok: true });
    for (const call of [0, 1, 2]) expect(headersOf(call)).not.toHaveProperty("Referer");
  });

  it.each([
    ["not an address", "hello"],
    ["a script", "javascript:alert(1)"],
    ["an IP literal", "http://169.254.169.254/"],
    ["credentials", "https://u:p@hitomi.la/"],
  ])("sends no Referer for a page that is %s, and still fetches the cover", async (_, page) => {
    fetchMock.mockResolvedValue(image());
    expect(await fetchCover(NH, page)).toMatchObject({ ok: true });
    expect(headersOf(0)).not.toHaveProperty("Referer");
  });
});

describe("fetchCover — which addresses", () => {
  // There is no list of image hosts: a title from any site keeps its cover on
  // whatever CDN that site uses.
  it.each([
    ["a CDN unrelated to the page's site", ANY_COVER],
    ["a known site's CDN", NH],
    ["plain http, which old sites still serve", "http://img.old-gallery.example/c/1.jpg"],
    ["the scheme's own port, spelled out", "https://t3.nhentai.net:443/galleries/1/cover.jpg"],
  ])("fetches a cover on %s", async (_, src) => {
    fetchMock.mockResolvedValue(image());
    expect(await fetchCover(src, ANY_PAGE)).toMatchObject({ ok: true, contentType: "image/jpeg" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(new URL(src).hostname, { all: true });
  });

  it.each([
    ["the metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["a loopback literal", "http://127.0.0.1/x.jpg"],
    ["a decimal IPv4", "https://2852039166/latest/meta-data/"],
    ["a hex IPv4", "https://0xA9FEA9FE/x.jpg"],
    ["an IPv6 literal", "https://[::1]/x.jpg"],
    ["an IPv4-mapped IPv6 literal", "https://[::ffff:169.254.169.254]/x.jpg"],
    ["a dotless host", "https://localhost/x.jpg"],
    ["a custom port", "https://t.nhentai.net:8443/cover.jpg"],
    ["credentials", "https://u:p@t.nhentai.net/cover.jpg"],
    ["ftp", "ftp://t.nhentai.net/cover.jpg"],
    ["a file", "file:///etc/passwd"],
    ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
    ["a script", "javascript:alert(1)"],
    ["a relative path", "/api/cover?src=x"],
    ["an address past the column width", `https://cdn.example.com/${"a".repeat(1100)}.jpg`],
    ["nothing", ""],
  ])("never asks DNS or the network for %s", async (_, raw) => {
    expect(await fetchCover(raw, ANY_PAGE)).toMatchObject({ ok: false, status: 400, reason: "not a web address" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address, without fetching", async () => {
    // Any name can point anywhere: the GCP metadata host is a perfectly good
    // DNS name, and so is one whose records were set to the metadata address.
    lookup.mockResolvedValue([{ address: "169.254.169.254" }]);
    expect(await fetchCover("https://metadata.google.internal/computeMetadata/v1/")).toMatchObject({ ok: false, status: 502 });
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "::ffff:10.0.0.1" }]);
    expect(await fetchCover(ANY_COVER)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a name that does not resolve, without fetching", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await fetchCover(ANY_COVER)).toMatchObject({ ok: false, status: 502 });
    lookup.mockResolvedValue([]);
    expect(await fetchCover(ANY_COVER)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchCover — redirects", () => {
  it.each([301, 302, 303, 307, 308])("follows a %i to any public web address, checking the new host", async (status) => {
    fetchMock.mockResolvedValueOnce(redirect(ANY_COVER, status)).mockResolvedValueOnce(image());
    expect(await fetchCover(NH, ANY_PAGE)).toMatchObject({ ok: true });
    expect(String(fetchMock.mock.calls[1][0])).toBe(ANY_COVER);
    expect(fetchMock.mock.calls[1][1]?.redirect).toBe("manual");
    // The Referer names the title's page on every hop, not the previous hop.
    expect(headersOf(1).Referer).toBe("https://www.some-gallery.net/");
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(["t3.nhentai.net", "cdn.unrelated-images.example"]);
  });

  it("resolves a relative Location against the hop it came from", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/galleries/1/thumb.jpg")).mockResolvedValueOnce(image());
    expect(await fetchCover(NH)).toMatchObject({ ok: true });
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://t3.nhentai.net/galleries/1/thumb.jpg");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/x.jpg",
    "https://[::1]/x.jpg",
    "https://localhost/x.jpg",
    "https://cdn.example.com:8080/x.jpg",
    "https://u:p@cdn.example.com/x.jpg",
    "ftp://cdn.example.com/x.jpg",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("refuses a redirect to %s without dialling it", async (location) => {
    fetchMock.mockResolvedValueOnce(redirect(location));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1); // the first hop only
  });

  it("refuses a hop whose host resolves to a private address", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]).mockResolvedValueOnce([{ address: "10.0.0.5" }]);
    fetchMock.mockResolvedValueOnce(redirect("https://rebind.example.net/x.jpg"));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenLastCalledWith("rebind.example.net", { all: true });
  });

  it("re-checks DNS even when a redirect stays on the same host", async () => {
    // The name answered public a moment ago; that proves nothing about now.
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]).mockResolvedValueOnce([{ address: "127.0.0.1" }]);
    fetchMock.mockResolvedValueOnce(redirect("/other.jpg"));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that goes nowhere", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect loop after three hops", async () => {
    fetchMock.mockImplementation(async () => redirect(NH));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("follows exactly three redirects", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://a.cdn.example/1.jpg"))
      .mockResolvedValueOnce(redirect("https://b.cdn.example/2.jpg"))
      .mockResolvedValueOnce(redirect("https://c.cdn.example/3.jpg"))
      .mockResolvedValueOnce(image());
    expect(await fetchCover(NH)).toMatchObject({ ok: true });
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(["t3.nhentai.net", "a.cdn.example", "b.cdn.example", "c.cdn.example"]);
  });
});

describe("fetchCover — the answer", () => {
  it("types the answer by its bytes, not by what upstream claims", async () => {
    fetchMock.mockResolvedValue(image(JPEG, { "Content-Type": "text/html" }));
    expect(await fetchCover(NH)).toMatchObject({ ok: true, contentType: "image/jpeg" });

    fetchMock.mockResolvedValue(new Response("<svg onload=alert(1)>", { headers: { "Content-Type": "image/svg+xml" } }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502, reason: "upstream did not answer with an image" });

    // Whatever a name happens to serve — a JSON API, an HTML page — is never relayed.
    fetchMock.mockResolvedValue(new Response('{"secret":1}', { headers: { "Content-Type": "image/jpeg" } }));
    expect(await fetchCover(ANY_COVER)).toMatchObject({ ok: false, status: 502 });
  });

  it("passes a missing cover on as 404 and anything else as 502", async () => {
    fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 404 });
    fetchMock.mockResolvedValue(new Response("gone", { status: 410 }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 404 });
    fetchMock.mockResolvedValue(new Response("hotlink", { status: 403 }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502, reason: "upstream answered 403" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502 });
  });

  it("refuses a body over the cap, declared or not", async () => {
    fetchMock.mockResolvedValue(image(JPEG, { "Content-Length": String(MAX_COVER_BYTES + 1) }));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502, reason: "cover is too large" });

    const big = new Uint8Array(MAX_COVER_BYTES + 1);
    big.set(JPEG);
    fetchMock.mockResolvedValue(new Response(big));
    expect(await fetchCover(NH)).toMatchObject({ ok: false, status: 502, reason: "cover is too large" });
  });

  it("answers 504 when upstream never answers", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = fetchCover(NH);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, status: 504, reason: "upstream timed out" });
  });

  it("keeps the timeout active while reading a slowly streamed body", async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementation(async (_, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(JPEG);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    })));
    const pending = fetchCover(NH);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, status: 504, reason: "upstream timed out" });
    expect(aborted).toBe(true);
  });
});
