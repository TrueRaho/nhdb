import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route pulls in lib/titles (→ prisma → DATABASE_URL at import time) and
// next/cache (request-scoped) — both must be mocked before the route loads.
vi.mock("@/lib/titles", () => ({
  upsertScrapedTitle: vi.fn(async () => ({ hashtag: 177013 })),
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));
// Keep ScrapeError (the route does instanceof checks) but stub the actual
// network scrape for the no-proxy-hosts path.
vi.mock("@/lib/scraper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scraper")>()),
  scrapeTitle: vi.fn(),
}));

import { POST } from "./route";
import { revalidateTag } from "next/cache";
import { upsertScrapedTitle } from "@/lib/titles";
import { ScrapeError, scrapeTitle } from "@/lib/scraper";

const SCRAPED = {
  hashtag: 177013,
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
    expect(upsertScrapedTitle).toHaveBeenCalledWith(SCRAPED);
    const tags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(tags).toEqual(
      expect.arrayContaining(["titles-list", "dataset", "stats", "title-177013", "similar-177013", "similar"]),
    );
  });
});

describe("POST /api/scrape — pre-scraped commit path", () => {
  it("saves a client-supplied scrape and invalidates tags", async () => {
    const res = await POST(req({ scraped: SCRAPED }));
    expect(res.status).toBe(200);
    expect(upsertScrapedTitle).toHaveBeenCalledWith(SCRAPED);
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
    vi.stubEnv("SCRAPER_SERVICE_URL", "");
    vi.stubEnv("SCRAPER_SERVICE_URL_FALLBACK", "");
  });

  it("scrapes locally and returns via", async () => {
    vi.mocked(scrapeTitle).mockResolvedValueOnce({ scraped: SCRAPED, via: "impit" });
    const res = await POST(req({ input: "177013", persist: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scraped: SCRAPED, via: "impit" });
  });

  it("maps ScrapeError codes to HTTP statuses", async () => {
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("nope", "NOT_FOUND"));
    expect((await POST(req({ input: "1" }))).status).toBe(404);
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("bad", "BAD_INPUT"));
    expect((await POST(req({ input: "x" }))).status).toBe(400);
    vi.mocked(scrapeTitle).mockRejectedValueOnce(new ScrapeError("cf", "CLOUDFLARE"));
    expect((await POST(req({ input: "1" }))).status).toBe(502);
  });
});
