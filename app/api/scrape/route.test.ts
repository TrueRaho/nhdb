import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route pulls in lib/titles (→ prisma → DATABASE_URL at import time) and
// next/cache (request-scoped) — both must be mocked before the route loads.
vi.mock("@/lib/titles", () => ({
  upsertScrapedTitle: vi.fn(async () => ({ hashtag: 177013 })),
}));
vi.mock("@/lib/session", () => ({
  requireUserId: vi.fn(async () => "user-a"),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));
// The budget reaches Postgres. Allowed by default so the existing cases exercise
// the scrape paths; the throttling cases below override it per test.
vi.mock("@/lib/rate-limit", () => ({
  consumeScrapeBudget: vi.fn(async () => ({ allowed: true, used: 1, limit: 120 })),
}));
// Scraper hosts are per user and live in the database now. The default pair
// mirrors the old SCRAPER_SERVICE_URL / _FALLBACK env setup so the existing
// fallthrough cases still describe the same topology.
const { DEFAULT_HOSTS } = vi.hoisted(() => ({
  DEFAULT_HOSTS: [
    { url: "http://primary.test", secret: "s3cret", label: "primary" },
    { url: "http://fallback.test", secret: "s3cret", label: "fallback" },
  ],
}));
vi.mock("@/lib/scraper-endpoints", () => ({
  resolveScraperTargets: vi.fn(async () => DEFAULT_HOSTS),
}));
// The DNS/address check has its own suite (lib/net-guard.test.ts); here it is
// stubbed to pass so these cases exercise the routing, not the guard.
vi.mock("@/lib/net-guard", () => ({
  assertReachableHost: vi.fn(async () => {}),
  UnsafeUrlError: class UnsafeUrlError extends Error {},
}));
// Keep ScrapeError (the route does instanceof checks) but stub the actual
// network scrape for the no-proxy-hosts path.
vi.mock("@/lib/scraper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scraper")>()),
  scrapeTitle: vi.fn(),
}));

import { POST } from "./route";
import { consumeScrapeBudget } from "@/lib/rate-limit";
import { resolveScraperTargets } from "@/lib/scraper-endpoints";
import { assertReachableHost } from "@/lib/net-guard";
import { requireUserId, UnauthorizedError } from "@/lib/session";
import { revalidateTag } from "next/cache";
import { upsertScrapedTitle } from "@/lib/titles";
import { ScrapeError, scrapeTitle } from "@/lib/scraper";

const SCRAPED = {
  source: "nhentai",
  source_id: "177013",
  url: "https://nhentai.net/g/177013/",
  title_name: "PenXjbs",
  image_link: "https://t.nhentai.net/x/cover.jpg",
  pages: 225,
  uploaded_at: "2016-10-18",
  tags: [],
  artists: [],
  groups: [],
  characters: [],
  parodies: [],
};

// What an older host sends: the same title, from before payloads named their page.
function withoutUrl<T extends { url: string }>(payload: T): Omit<T, "url"> {
  const copy: Partial<T> = { ...payload };
  delete copy.url;
  return copy as Omit<T, "url">;
}

function req(body: unknown): Request {
  return new Request("http://app.test/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// One upstream scraper-host response. `json` rejecting simulates an ngrok HTML
// error page (invalid JSON); `reject` simulates the host being unreachable.
type Upstream =
  | { reject: true }
  | { status: number; body?: unknown; invalidJson?: boolean };

function stubHosts(...responses: Upstream[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)];
      if ("reject" in r) throw new TypeError("fetch failed");
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: String(r.status),
        json: async () => {
          if (r.invalidJson) throw new SyntaxError("Unexpected token <");
          return r.body;
        },
      } as unknown as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(requireUserId).mockResolvedValue("user-a");
  // Reset per test: clearAllMocks keeps implementations, so a suite that sets
  // "no hosts" would otherwise leak into every later one, which then quietly
  // runs against the dev env hosts instead of the topology it describes.
  vi.mocked(resolveScraperTargets).mockReset().mockResolvedValue(DEFAULT_HOSTS);
  vi.stubEnv("SCRAPER_SERVICE_URL", "http://primary.test");
  vi.stubEnv("SCRAPER_SERVICE_URL_FALLBACK", "http://fallback.test");
  vi.stubEnv("SCRAPER_SECRET", "s3cret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/scrape — input validation", () => {
  it("400s on unparseable JSON", async () => {
    const res = await POST(req("{not json"));
    expect(res.status).toBe(400);
  });

  it("400s on a missing input field", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/scrape — proxy host fallthrough", () => {
  it("uses the primary and forwards the bearer secret", async () => {
    const calls = stubHosts({ status: 200, body: { scraped: SCRAPED, via: "impit" } });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scraped: SCRAPED, via: "impit" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://primary.test/scrape");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(upsertScrapedTitle).not.toHaveBeenCalled(); // persist: false
  });

  it("treats a primary 404 as authoritative — no fallback call", async () => {
    const calls = stubHosts({ status: 404, body: { error: "not found" } });
    const res = await POST(req({ input: "999999999", persist: false }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(calls).toHaveLength(1);
  });

  it("falls through to the fallback when the primary is unreachable", async () => {
    const calls = stubHosts({ reject: true }, { status: 200, body: { scraped: SCRAPED, via: "fallback" } });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).via).toBe("fallback");
    expect(calls.map((c) => c.url)).toEqual(["http://primary.test/scrape", "http://fallback.test/scrape"]);
  });

  it("falls through when the primary returns an HTML error page (invalid JSON)", async () => {
    const calls = stubHosts(
      { status: 200, invalidJson: true },
      { status: 200, body: { scraped: SCRAPED, via: "fallback" } },
    );
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("returns the last error when every host is unreachable", async () => {
    stubHosts({ reject: true }, { reject: true });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(503);
  });

  it("persists and invalidates cache tags on the default persist path", async () => {
    stubHosts({ status: 200, body: { scraped: SCRAPED, via: "impit" } });
    const res = await POST(req({ input: "177013" }));
    expect(res.status).toBe(200);
    expect(upsertScrapedTitle).toHaveBeenCalledWith("user-a", SCRAPED);
    const tags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(tags).toEqual(
      expect.arrayContaining(["titles-list:user-a", "dataset:user-a", "stats:user-a", "title:user-a:177013", "similar:user-a:177013", "similar:user-a"]),
    );
  });
});

describe("POST /api/scrape — pre-scraped commit path", () => {
  it("saves a client-supplied scrape and invalidates tags", async () => {
    const res = await POST(req({ scraped: SCRAPED }));
    expect(res.status).toBe(200);
    expect(upsertScrapedTitle).toHaveBeenCalledWith("user-a", SCRAPED);
    expect(vi.mocked(revalidateTag).mock.calls.length).toBeGreaterThan(0);
  });

  it("maps a validation error to 400, not 500", async () => {
    const err = new Error("Invalid scrape payload: pages must be a non-negative number");
    err.name = "ValidationError";
    vi.mocked(upsertScrapedTitle).mockRejectedValueOnce(err);
    const res = await POST(req({ scraped: { ...SCRAPED, pages: -1 } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/scrape — direct scrape (no proxy hosts)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SCRAPER_SERVICE_URL", "");
    vi.stubEnv("SCRAPER_SERVICE_URL_FALLBACK", "");
    vi.mocked(resolveScraperTargets).mockResolvedValue([]);
  });

  it("scrapes locally and returns via", async () => {
    vi.mocked(scrapeTitle).mockResolvedValueOnce({ scraped: SCRAPED, via: "impit" });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scraped: SCRAPED, via: "impit" });
    expect(scrapeTitle).toHaveBeenCalledWith({ source: "nhentai", id: "177013", url: "https://nhentai.net/g/177013/" });
  });

  it("hands the in-process scraper the parsed title, not the pasted text", async () => {
    vi.mocked(scrapeTitle).mockResolvedValueOnce({ scraped: SCRAPED, via: "impit" });
    await POST(req({ input: "look https://www.some-gallery.net/g/4242/?utm_source=share#page-3", persist: false }));
    expect(scrapeTitle).toHaveBeenCalledExactlyOnceWith({
      source: "some-gallery.net", id: "4242", url: "https://www.some-gallery.net/g/4242/",
    });
  });

  it("maps ScrapeError codes to HTTP statuses", async () => {
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("nope", "NOT_FOUND"));
    expect((await POST(req({ input: "1" }))).status).toBe(404);
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("bad", "BAD_INPUT"));
    expect((await POST(req({ input: "hitomi:1" }))).status).toBe(400);
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("cf", "CLOUDFLARE"));
    expect((await POST(req({ input: "1" }))).status).toBe(502);
  });
});


describe("POST /api/scrape — session boundary", () => {
  it.each([{ input: "177013", persist: false }, { scraped: SCRAPED }])(
    "rejects guests before any scrape or write: %o", async (body) => {
      vi.mocked(requireUserId).mockRejectedValueOnce(new UnauthorizedError("Unauthorized"));
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const response = await POST(req(body));
      expect(response.status).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
      expect(scrapeTitle).not.toHaveBeenCalled();
      expect(upsertScrapedTitle).not.toHaveBeenCalled();
      expect(revalidateTag).not.toHaveBeenCalled();
    },
  );

  it("ignores a forged owner in the request body", async () => {
    const response = await POST(req({ scraped: SCRAPED, userId: "user-b" }));
    expect(response.status).toBe(200);
    expect(upsertScrapedTitle).toHaveBeenCalledWith("user-a", SCRAPED);
  });

  it.each([null, [], 1, { input: 123 }, { input: "1", persist: "false" }])(
    "returns 400 for malformed JSON shape: %j", async (body) => {
      expect((await POST(req(body))).status).toBe(400);
      expect(upsertScrapedTitle).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/scrape — scrape budget", () => {
  it("returns 429 with Retry-After and never reaches a scraper host", async () => {
    vi.mocked(consumeScrapeBudget).mockResolvedValueOnce({
      allowed: false, limit: 120, retryAfterSeconds: 1800,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await POST(req({ input: "177013", persist: false }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1800");
    expect(await response.json()).toEqual({ error: "Scrape limit reached (120/hour). Try again later." });
    expect(fetch).not.toHaveBeenCalled();
    expect(scrapeTitle).not.toHaveBeenCalled();
  });

  it("charges the authenticated user, once, before scraping", async () => {
    stubHosts({ status: 200, body: { scraped: SCRAPED, via: "impit" } });
    await POST(req({ input: "177013", persist: false }));
    expect(consumeScrapeBudget).toHaveBeenCalledExactlyOnceWith("user-a");
  });

  it("does not spend budget on a commit of an already-scraped payload", async () => {
    // That path writes the caller's own rows and never touches the shared
    // scraper, so it must not consume a scrape the user could have spent.
    const response = await POST(req({ scraped: SCRAPED }));
    expect(response.status).toBe(200);
    expect(consumeScrapeBudget).not.toHaveBeenCalled();
  });

  it("does not spend budget when the request is rejected as malformed", async () => {
    expect((await POST(req({ persist: false }))).status).toBe(400);
    expect(consumeScrapeBudget).not.toHaveBeenCalled();
  });
});

describe("POST /api/scrape — per-user scraper hosts", () => {
  it("resolves the caller's own hosts and sends each host's own secret", async () => {
    vi.mocked(resolveScraperTargets).mockResolvedValueOnce([
      { url: "https://alice-1.test", secret: "alice-token", label: "mac" },
      { url: "https://alice-2.test", secret: null, label: "render" },
    ]);
    const calls = stubHosts({ reject: true }, { status: 200, body: { scraped: SCRAPED, via: "fallback" } });

    const res = await POST(req({ input: "177013", persist: false }));

    expect(res.status).toBe(200);
    expect(resolveScraperTargets).toHaveBeenCalledWith("user-a");
    expect(calls.map((c) => c.url)).toEqual(["https://alice-1.test/scrape", "https://alice-2.test/scrape"]);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer alice-token");
    // A host stored without a secret is called without the header — never with
    // some other host's, and never with a leftover global one.
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refuses to follow redirects, so a 302 cannot escape the address checks", async () => {
    const calls = stubHosts({ status: 200, body: { scraped: SCRAPED, via: "impit" } });
    await POST(req({ input: "177013", persist: false }));
    expect(calls[0].init.redirect).toBe("error");
  });

  it("skips a host the address guard rejects, without fetching it", async () => {
    vi.mocked(assertReachableHost)
      .mockRejectedValueOnce(new Error("resolves to a private address"))
      .mockResolvedValueOnce(undefined);
    const calls = stubHosts({ status: 200, body: { scraped: SCRAPED, via: "fallback" } });

    const res = await POST(req({ input: "177013", persist: false }));

    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://fallback.test/scrape"]);
  });

  it("answers 409 in production when nothing is configured, and spends no budget", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(resolveScraperTargets).mockResolvedValueOnce([]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const res = await POST(req({ input: "177013", persist: false }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Account settings/);
    expect(consumeScrapeBudget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores the env hosts in production", async () => {
    // A shared fallback would quietly put everyone's scraping back on one
    // person's box, which is what per-user endpoints exist to prevent.
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(resolveScraperTargets).mockResolvedValueOnce([]);
    expect((await POST(req({ input: "177013", persist: false }))).status).toBe(409);
  });
});

describe("POST /api/scrape — only titles", () => {
  // Any site may be added, so what stops here is no longer "a site we do not
  // know" but "an address that does not look like ONE title's" — and anything
  // that is not a web address at all.
  it.each([
    "https://hentaifox.com/search/?q=quill+mfnd",
    "https://e-hentai.org/?f_search=quill+mfnd",
    "https://hitomi.la/search.html?quill%20mfnd",
    "https://imhentai.xxx/search/?key=quill+mfnd",
    "https://some-gallery.net/",
    "https://some-gallery.net/tag/big-breasts/",
    "https://some-gallery.net/artist/penqech/",
    "https://nhentai.net/g/1000000001/",
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/g/177013/",
    "https://[::1]/g/177013/",
    "https://user:pw@some-gallery.net/g/4242/",
    "https://some-gallery.net:8080/g/4242/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "hello",
  ])("400s %s before charging the budget or contacting a host", async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await POST(req({ input, persist: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a link to a title", code: "BAD_INPUT" });
    expect(consumeScrapeBudget).not.toHaveBeenCalled();
    expect(resolveScraperTargets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(scrapeTitle).not.toHaveBeenCalled();
  });

  const HITOMI = {
    ...SCRAPED,
    source: "hitomi",
    source_id: "1234567",
    url: "https://hitomi.la/galleries/1234567.html",
    image_link: "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/x.webp",
  };
  // A site no list ever named, with its cover on a CDN that shares nothing
  // with the site's own host.
  const ANY = {
    ...SCRAPED,
    source: "some-gallery.net",
    source_id: "4242",
    url: "https://www.some-gallery.net/g/4242/",
    image_link: "https://cdn.unrelated-images.example/covers/4242.jpg",
  };

  it("asks the host for a known site's own gallery page, not the pasted text", async () => {
    const calls = stubHosts({ status: 200, body: { scraped: HITOMI, via: "impit" } });
    const res = await POST(req({ input: "see https://hitomi.la/reader/1234567.html#5?evil=1", persist: false }));
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ input: "https://hitomi.la/galleries/1234567.html" });
  });

  it("asks the host for any other site's link, tidied of tracking and fragment", async () => {
    const calls = stubHosts({ status: 200, body: { scraped: ANY, via: "impit" } });
    const res = await POST(req({
      input: "look at this https://www.some-gallery.net/g/4242/?utm_source=share&fbclid=abc#page-3",
      persist: false,
    }));
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ input: "https://www.some-gallery.net/g/4242/" });
    expect(consumeScrapeBudget).toHaveBeenCalledExactlyOnceWith("user-a");
  });

  it("keeps asking for nhentai by the bare id every host version understands", async () => {
    const calls = stubHosts({ status: 200, body: { scraped: SCRAPED, via: "impit" } });
    await POST(req({ input: "https://nhentai.net/g/177013/", persist: false }));
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ input: "177013" });
  });

  it("passes on and stores a title from any site, its cover on any CDN", async () => {
    stubHosts({ status: 200, body: { scraped: ANY, via: "impit" } });
    const res = await POST(req({ input: "https://www.some-gallery.net/g/4242/" }));
    expect(res.status).toBe(200);
    expect((await res.json()).scraped).toEqual(ANY);
    expect(upsertScrapedTitle).toHaveBeenCalledExactlyOnceWith("user-a", ANY);
  });

  it("reads an older host's nhentai-only answer", async () => {
    const legacy = { ...withoutUrl(SCRAPED), source: undefined, source_id: undefined, hashtag: 177013 };
    stubHosts({ status: 200, body: { scraped: legacy, via: "impit" } });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).scraped).toEqual(SCRAPED);
  });

  it("reads a seven-site host's answer, which carries no url, at the site's own page", async () => {
    stubHosts({ status: 200, body: { scraped: withoutUrl(HITOMI), via: "impit" } });
    const res = await POST(req({ input: "hitomi:1234567", persist: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).scraped).toEqual(HITOMI);
  });

  it.each([
    ["a cover that is not a web address", { image_link: "javascript:alert(1)" }],
    ["a page on another site", { url: "https://evil.example/galleries/1234567.html" }],
    ["a page that names another gallery", { url: "https://hitomi.la/galleries/7.html" }],
    ["a site that is not a host name", { source: "not a site" }],
    ["no title", { title_name: "  " }],
    ["a negative page count", { pages: -1 }],
  ])("does not pass on or store an answer with %s, and tries the next host", async (_, lie) => {
    const calls = stubHosts(
      { status: 200, body: { scraped: { ...HITOMI, ...lie }, via: "impit" } },
      { status: 200, body: { scraped: HITOMI, via: "fallback" } },
    );
    const res = await POST(req({ input: "hitomi:1234567" }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(upsertScrapedTitle).toHaveBeenCalledExactlyOnceWith("user-a", HITOMI);
  });

  it("says why when every host's answer was unusable", async () => {
    stubHosts({ status: 200, body: { scraped: { ...HITOMI, image_link: "javascript:alert(1)" }, via: "impit" } });
    const res = await POST(req({ input: "hitomi:1234567" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/^Scraper host returned an unusable title: .*image_link/);
    expect(upsertScrapedTitle).not.toHaveBeenCalled();
  });

  it("keeps an entity whose link leaves the site, without the link", async () => {
    const offSite = {
      ...ANY,
      artists: [
        { name: "PenQech", link: "https://evil.example/artist/penqech/", total_works: 3 },
        { name: "Bob", link: "https://www.some-gallery.net/artist/bob/", total_works: 1 },
      ],
    };
    const calls = stubHosts({ status: 200, body: { scraped: offSite, via: "impit" } });
    const res = await POST(req({ input: "https://www.some-gallery.net/g/4242/" }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(upsertScrapedTitle).toHaveBeenCalledExactlyOnceWith("user-a", {
      ...ANY,
      artists: [
        { name: "penqech", link: "", total_works: 3 },
        { name: "bob", link: "https://www.some-gallery.net/artist/bob/", total_works: 1 },
      ],
    });
  });

  it.each([
    ["another gallery on the same site", {
      ...HITOMI, source_id: "7", url: "https://hitomi.la/galleries/7.html",
    }],
    ["the same id on another site", {
      ...HITOMI, source: "other-gallery.net", url: "https://other-gallery.net/galleries/1234567.html",
    }],
  ])("refuses a host's answer about %s", async (_, other) => {
    stubHosts({ status: 200, body: { scraped: other, via: "impit" } });
    const res = await POST(req({ input: "hitomi:1234567" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Scraper host returned a different title");
    expect(upsertScrapedTitle).not.toHaveBeenCalled();
  });

  it("explains an outdated host by the site's name and lets a newer one try", async () => {
    const calls = stubHosts(
      { status: 400, body: { error: "Could not parse hashtag", code: "BAD_INPUT" } },
      { status: 200, body: { scraped: HITOMI, via: "fallback" } },
    );
    const res = await POST(req({ input: "hitomi:1234567", persist: false }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);

    stubHosts({ status: 400, body: { error: "Could not parse hashtag" } }, { status: 400, body: {} });
    const both = await POST(req({ input: "hitomi:1234567", persist: false }));
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({
      error: "Your scraper host (fallback) could not read this hitomi.la link — it is probably running an " +
        "older version. Update it and try again.",
      code: "BAD_INPUT",
    });
  });

  it("names any other site by its host in the outdated-host message", async () => {
    vi.mocked(resolveScraperTargets).mockResolvedValueOnce([{ url: "https://old.test", secret: null, label: "" }]);
    stubHosts({ status: 400, body: { error: "Not a title link from a supported site", code: "BAD_INPUT" } });
    const res = await POST(req({ input: "https://www.some-gallery.net/g/4242/", persist: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Your scraper host (host) could not read this some-gallery.net link — it is probably running an " +
        "older version. Update it and try again.",
    );
  });

  it("takes a current host's 400 about any site as its verdict", async () => {
    // A host that reads any site says so; its 400 (a site resolving into a
    // private network) is about the link, so it is not called outdated and the
    // next host is not asked.
    const calls = stubHosts(
      { status: 400, body: { error: "dead-mirror.net resolves to a private address", code: "BAD_INPUT", reads: "any-site" } },
      { status: 200, body: { scraped: ANY, via: "impit" } },
    );
    const res = await POST(req({ input: "https://www.some-gallery.net/g/4242/", persist: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("dead-mirror.net resolves to a private address");
    expect(calls).toHaveLength(1);
  });

  it("takes a host's 400 about an nhentai title as its verdict", async () => {
    // Every host version reads nhentai, so a 400 there is about the input, not
    // the host's age — no next host, no "update it" message.
    const calls = stubHosts({ status: 400, body: { error: "bad id", code: "BAD_INPUT" } });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad id", code: "BAD_INPUT" });
    expect(calls).toHaveLength(1);
  });

  it("invalidates the key the database filed the title under", async () => {
    vi.mocked(upsertScrapedTitle).mockResolvedValueOnce({ hashtag: 1_000_000_003 } as never);
    stubHosts({ status: 200, body: { scraped: ANY, via: "impit" } });
    await POST(req({ input: "https://www.some-gallery.net/g/4242/" }));
    const tags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(tags).toContain("title:user-a:1000000003");
    expect(tags).toContain("similar:user-a:1000000003");
  });
});
