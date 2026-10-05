import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The network, faked: each test says what "the site" answers, what its host
// name resolves to, and whether a browser is available. No request leaves the
// process and no Chromium is launched.
//   impit              → fetchMock(url, init) answers { status, url, text() }
//   node:dns/promises  → lookup(host) answers the addresses (public by default)
//   playwright-extra   → launch() rejects (no browser) unless a test installs
//                        the fake browser, whose pages answer from browserServe
const { fetchMock, lookup, launch, browserServe } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  lookup: vi.fn<(host: string, opts: unknown) => Promise<{ address: string }[]>>(),
  launch: vi.fn(),
  browserServe: vi.fn<(url: string) => { status?: number; html: string; url?: string }>(),
}));
vi.mock("impit", () => ({
  Impit: class {
    fetch = fetchMock;
  },
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("playwright-extra", () => ({ chromium: { use: vi.fn(), launch } }));
vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: () => ({}) }));
// The real reader, wrapped so one test can hand the orchestrator a reading the
// write boundary must refuse.
vi.mock("./scrapers/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scrapers/extract")>();
  return { ...actual, readPage: vi.fn(actual.readPage) };
});

import { closeScraper, looksLikeChallenge, scrapeTitle, ScrapeError } from "./scraper";
import { readPage } from "./scrapers/extract";

function answer(body: string, { status = 200, url }: { status?: number; url?: string } = {}) {
  return { status, url: url ?? "", text: async () => body };
}

/** Serve these pages by address; anything else is a 404. */
function site(pages: Record<string, string | { body: string; status?: number; url?: string }>) {
  fetchMock.mockImplementation(async (url: string) => {
    const page = pages[url];
    if (page === undefined) return answer("", { status: 404, url });
    return typeof page === "string" ? answer(page, { url }) : answer(page.body, { status: page.status, url: page.url ?? url });
  });
}

// A browser whose pages answer from browserServe.
function installBrowser() {
  launch.mockImplementation(async () => ({
    on: vi.fn(),
    isConnected: () => true,
    close: vi.fn(async () => {}),
    newContext: async () => ({
      route: async () => {},
      newPage: async () => {
        let served: { status?: number; html: string; url?: string } = { html: "" };
        let at = "about:blank";
        return {
          goto: async (url: string) => {
            served = browserServe(url);
            at = served.url ?? url;
            return { status: () => served.status ?? 200 };
          },
          url: () => at,
          title: async () => served.html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "",
          content: async () => served.html,
          waitForLoadState: async () => {},
          close: async () => {},
        };
      },
    }),
  }));
}

const fixture = (name: string) =>
  readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "scrapers", "fixtures", name), "utf8");

// The reader is generic, so one page shape serves every site in these tests.
const galleryPage = (title = "Title") => `<!doctype html><html><head><title>${title}</title></head><body>
  <div class="info">
    <div class="cover"><img src="https://i.some-cdn.net/004/42/cover.jpg"></div>
    <h1>${title}</h1>
    <ul>
      <li>Artists: <a href="/artist/foo/">foo</a></li>
      <li>Tags: <a href="/tag/big-breasts/">big breasts <span class="t_badge">5</span></a></li>
      <li>Pages: 24</li>
    </ul>
  </div></body></html>`;

const warningPage = (to: string) => `<!doctype html><html><head><title>Some Title</title></head><body>
  <h1>Content Warning</h1><p>This gallery has been flagged as Offensive For Everyone.</p>
  <p><a href="${to}">View Gallery</a> <a href="/">Get Me Outta Here</a></p></body></html>`;

const HENTAIFOX = galleryPage();
const SITE = "https://doujin-site.com";

beforeEach(() => {
  fetchMock.mockReset();
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
  launch.mockReset();
  launch.mockRejectedValue(new Error("browserType.launch: Executable doesn't exist"));
  browserServe.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await closeScraper();
  vi.restoreAllMocks();
});

describe("scrapeTitle: what is fetched", () => {
  it("fetches a legacy site's canonical page, not the pasted reader page", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    const { scraped, via } = await scrapeTitle("https://nhentai.net/g/177013/5/?utm_source=x#top");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://nhentai.net/g/177013/");
    expect(via).toBe("impit");
    expect(scraped).toMatchObject({
      source: "nhentai", source_id: "177013", url: "https://nhentai.net/g/177013/", title_name: "Title", pages: 24,
    });
  });

  it("reads E-Hentai's gallery page itself, gid and token in the id", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    const { scraped } = await scrapeTitle("https://e-hentai.org/g/899557/edd545586a/?p=1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://e-hentai.org/g/899557/edd545586a/");
    expect(init?.method).toBeUndefined(); // a plain GET of the page — no API call
    expect(scraped).toMatchObject({ source: "ehentai", source_id: "899557/edd545586a", url: "https://e-hentai.org/g/899557/edd545586a/" });
  });

  it("reads a bare id as nhentai and legacy ref text as its site's canonical page", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    await scrapeTitle("177013");
    await scrapeTitle("hitomi:1234567");
    await scrapeTitle("pururin:88048");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://nhentai.net/g/177013/",
      "https://hitomi.la/galleries/1234567.html",
      "https://pururin.me/gallery/88048/x",
    ]);
  });

  it("fetches any other site's page as pasted, without its fragment and tracking parameters", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    const { scraped } = await scrapeTitle(`${SITE}/gallery/12345/?utm_source=tw&fbclid=abc#comments`);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SITE}/gallery/12345/`);
    expect(scraped).toMatchObject({ source: "doujin-site.com", source_id: "12345", url: `${SITE}/gallery/12345/` });
    // Entity links are stored absolute, on the title's site.
    expect(scraped.artists).toEqual([{ name: "foo", link: `${SITE}/artist/foo/`, total_works: 0 }]);
    expect(scraped.tags).toEqual([{ name: "big breasts", link: `${SITE}/tag/big-breasts/`, total_works: 5 }]);
  });

  it("files a www. address under the bare site", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    const { scraped } = await scrapeTitle("https://www.doujin-site.com/gallery/12345/");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.doujin-site.com/gallery/12345/");
    expect(scraped).toMatchObject({ source: "doujin-site.com", source_id: "12345" });
  });

  it("takes a ref and fetches its url, but refuses one whose url names another title", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    const url = `${SITE}/gallery/12345/`;
    await expect(scrapeTitle({ source: "doujin-site.com", id: "12345", url })).resolves.toMatchObject({ scraped: { source_id: "12345" } });
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    fetchMock.mockClear();
    await expect(scrapeTitle({ source: "doujin-site.com", id: "999", url })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(scrapeTitle({ source: "other-site.com", id: "12345", url })).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses input that is not a title link, without resolving or fetching anything", async () => {
    for (const input of [
      "https://hentaifox.com/search/?q=quill+mfnd",
      "https://hitomi.la/search.html?quill%20mfnd",
      "https://doujin-site.com/tag/big-breasts/",
      "https://doujin-site.com/",
      "http://169.254.169.254/latest/meta-data/",
      "https://[::1]/gallery/1/",
      "https://localhost/gallery/1/",
      "https://doujin-site.com:8443/gallery/12345/",
      "https://user:pw@doujin-site.com/gallery/12345/",
      "file:///etc/passwd",
      "just some words",
      "",
    ]) {
      await expect(scrapeTitle(input), input).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("scrapeTitle: public addresses only", () => {
  it("refuses a host that resolves to a private address, before fetching it", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "::ffff:169.254.169.254", "fd00::1"]) {
      lookup.mockResolvedValueOnce([{ address }]);
      await expect(scrapeTitle(`${SITE}/gallery/12345/`), address).rejects.toMatchObject({
        code: "BAD_INPUT",
        message: expect.stringMatching(/private address/),
      });
    }
    expect(lookup).toHaveBeenCalledWith("doujin-site.com", { all: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host when any one of its addresses is private", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }, { address: "192.168.1.10" }]);
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a site that does not resolve as not found, without fetching", async () => {
    // A dead mirror is a verdict about the title (404), not malformed input —
    // and not the 400 an outdated scraper host answers with.
    lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/Could not resolve doujin-site\.com/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every followed link too", async () => {
    // The warning's link stays on the site, on a subdomain pointed inward.
    lookup.mockImplementation(async (host) => [{ address: host === "internal.doujin-site.com" ? "10.1.2.3" : "93.184.216.34" }]);
    site({ [`${SITE}/gallery/12345/`]: warningPage("https://internal.doujin-site.com/gallery/12345/") });
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenLastCalledWith("internal.doujin-site.com", { all: true });
  });
});

describe("scrapeTitle: where the page landed", () => {
  it("does not read a page that redirected off the site", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://ads.example/landing" }));
    await expect(scrapeTitle("hentaifox:42")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/redirected off the site/),
    });
  });

  it("does not file a successor gallery under the id that redirected to it", async () => {
    // IMHentai answers a replaced gallery with a 301 to its successor.
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://hentaifox.com/gallery/43/" }));
    await expect(scrapeTitle("hentaifox:42")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/now redirects to hentaifox 43 — add that one instead/),
    });
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: `${SITE}/gallery/12346/` }));
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/now redirects to doujin-site 12346/),
    });
  });

  it("reads the site's own canonical form of the same title", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://hentaifox.com/gallery/42" }));
    await expect(scrapeTitle("hentaifox:42")).resolves.toMatchObject({ scraped: { source_id: "42" } });
    // A redirect to the site's mobile host is the same site and the same id;
    // the title keeps the address it was read at.
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://m.doujin-site.com/gallery/12345/" }));
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).resolves.toMatchObject({
      scraped: { source: "doujin-site.com", source_id: "12345", url: "https://m.doujin-site.com/gallery/12345/" },
    });
  });

  it("maps a 404 or 410 to NOT_FOUND without opening a browser", async () => {
    fetchMock.mockResolvedValue(answer("", { status: 404, url: "https://hitomi.la/x" }));
    await expect(scrapeTitle("https://hitomi.la/galleries/9.html")).rejects.toMatchObject({ code: "NOT_FOUND" });
    fetchMock.mockResolvedValue(answer("", { status: 410 }));
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("scrapeTitle: following", () => {
  it("follows a content warning's link to the gallery, and keeps a legacy title's canonical url", async () => {
    const gallery = "https://e-hentai.org/g/8958199/cae9a87857/";
    site({
      [gallery]: warningPage(`${gallery}?nw=session`),
      [`${gallery}?nw=session`]: galleryPage("Some Title"),
    });
    const { scraped, via } = await scrapeTitle(gallery);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([gallery, `${gallery}?nw=session`]);
    expect(via).toBe("impit");
    expect(scraped).toMatchObject({ source: "ehentai", source_id: "8958199/cae9a87857", url: gallery, title_name: "Some Title" });
  });

  it("goes from another site's reader page to its gallery, and keeps the gallery's address", async () => {
    site({
      [`${SITE}/read/12345/3`]: `<!doctype html><html><head><title>Some Title - Page 3</title></head><body>
        <div class="reader-bar"><a href="/gallery/12345/">Some Title</a> <span>3 / 24</span></div>
        <img id="image" src="https://cdn.doujin-site.com/12345/3.jpg"></body></html>`,
      [`${SITE}/gallery/12345/`]: galleryPage("Some Title"),
    });
    const { scraped } = await scrapeTitle(`${SITE}/read/12345/3`);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${SITE}/read/12345/3`, `${SITE}/gallery/12345/`]);
    expect(scraped).toMatchObject({ source: "doujin-site.com", source_id: "12345", url: `${SITE}/gallery/12345/` });
  });

  it("follows at most two links", async () => {
    // Every page is another warning pointing one step further.
    fetchMock.mockImplementation(async (url: string) => {
      const step = Number(new URL(url).searchParams.get("step") ?? 0);
      return answer(warningPage(`${SITE}/gallery/12345/?step=${step + 1}`), { url });
    });
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/is not a title page: it kept redirecting between pages/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("scrapeTitle: the browser layer", () => {
  it("uses the browser when impit is challenged", async () => {
    installBrowser();
    fetchMock.mockResolvedValue(answer("<html><head><title>Just a moment...</title></head><body></body></html>", { status: 403 }));
    browserServe.mockReturnValue({ html: HENTAIFOX });
    const { scraped, via } = await scrapeTitle("hentaifox:42");
    expect(via).toBe("fallback");
    expect(browserServe).toHaveBeenCalledWith("https://hentaifox.com/gallery/42/");
    expect(scraped).toMatchObject({ source: "hentaifox", source_id: "42", title_name: "Title", pages: 24 });
  });

  it("uses the browser when impit's page only becomes a title once its scripts run", async () => {
    // Hitomi serves an empty template and fills it in the browser.
    installBrowser();
    const url = "https://hitomi.la/galleries/8367076.html";
    site({ [url]: fixture("hitomi-shell.html") });
    browserServe.mockReturnValue({ html: fixture("hitomi-gallery.html") });
    const { scraped, via } = await scrapeTitle(url);
    expect(via).toBe("fallback");
    expect(scraped).toMatchObject({
      source: "hitomi", source_id: "8367076", url, title_name: "Morning Ledger Djxieas", uploaded_at: "2024-02-11",
    });
    expect(scraped.artists.map((a) => a.name)).toContain("quill uspn");
  });

  it("reports why a static page is not a title when no browser is available", async () => {
    fetchMock.mockResolvedValue(answer(fixture("hitomi-shell.html")));
    await expect(scrapeTitle("https://hitomi.la/galleries/8367076.html")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/^hitomi 8367076 on hitomi\.la is not a title page: the page has no title data/),
    });
    expect(launch).toHaveBeenCalled();
  });

  it("refuses a listing the browser cannot turn into a title either", async () => {
    installBrowser();
    const listing = `<html><body><div class="list"><h1>Big Breasts Selection</h1>${Array.from({ length: 8 }, (_, i) =>
      `<a href="/gallery/${200 + i}/"><img src="https://cdn.doujin-site.com/${200 + i}/thumb.jpg"></a>`).join("")}</div></body></html>`;
    fetchMock.mockResolvedValue(answer(listing));
    browserServe.mockReturnValue({ html: listing });
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/is not a title page: the page lists other titles/),
    });
  });

  it("says so when impit was blocked and there is no browser to fall back to", async () => {
    fetchMock.mockResolvedValue(answer("Service Unavailable", { status: 503 }));
    await expect(scrapeTitle(`${SITE}/gallery/12345/`)).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringMatching(/impit was blocked and the browser fallback also failed: could not acquire a browser page/),
    });
  });

  it("applies the same rules to what the browser got: 404, a redirect off the site, a challenge it cannot pass", async () => {
    installBrowser();
    fetchMock.mockResolvedValue(answer("", { status: 503 }));

    browserServe.mockReturnValue({ status: 404, html: "" });
    await expect(scrapeTitle("hentaifox:42")).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/not found \(404\)/) });

    browserServe.mockReturnValue({ html: HENTAIFOX, url: "https://ads.example/landing" });
    await expect(scrapeTitle("hentaifox:42")).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/redirected off the site/) });

    browserServe.mockReturnValue({ html: "<html><head><title>Just a moment...</title></head><body></body></html>" });
    await expect(scrapeTitle("hentaifox:42")).rejects.toMatchObject({
      code: "CLOUDFLARE",
      message: expect.stringMatching(/impit was blocked and the browser fallback also failed: Cloudflare challenge detected/),
    });
  });
});

describe("scrapeTitle: the write boundary", () => {
  const reading = (over: Record<string, unknown> = {}) => ({
    kind: "gallery" as const,
    title: {
      title_name: "Title", image_link: "", pages: 24, uploaded_at: null,
      tags: [], artists: [], groups: [], characters: [], parodies: [], ...over,
    },
  });

  it("fails at the scraper, with the reason, when a reading would not be storable", async () => {
    // More pages than the write boundary accepts: the reading itself
    // succeeded, the payload it produced would not be storable.
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    vi.mocked(readPage).mockReturnValueOnce(reading({ pages: 100_001 }));
    const err = await scrapeTitle("hentaifox:42").catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toMatch(/^read an unusable title from hentaifox 42 on hentaifox\.com: Invalid scrape payload: pages/);
  });

  it("hands back what the boundary made of the reading: names folded, off-site links dropped", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX));
    vi.mocked(readPage).mockReturnValueOnce(reading({
      tags: [
        { name: "Big  Breasts", link: "https://hentaifox.com/tag/big-breasts/", total_works: 3 },
        { name: "smuggled", link: "https://evil.example/tag/x/", total_works: 0 },
      ],
    }));
    const { scraped } = await scrapeTitle("hentaifox:42");
    expect(scraped.tags).toEqual([
      { name: "big breasts", link: "https://hentaifox.com/tag/big-breasts/", total_works: 3 },
      { name: "smuggled", link: "", total_works: 0 },
    ]);
  });
});

describe("looksLikeChallenge", () => {
  it("recognizes Cloudflare interstitials", () => {
    expect(looksLikeChallenge("<title>Just a moment...</title>")).toBe(true);
    expect(looksLikeChallenge("<title>Attention Required! | Cloudflare</title>")).toBe(true);
    expect(looksLikeChallenge(`<div id="cf-browser-verification"></div>`)).toBe(true);
    expect(looksLikeChallenge(`<script src="/cdn-cgi/challenge-platform/x.js"></script>`)).toBe(true);
  });

  it("passes a normal gallery page", () => {
    expect(looksLikeChallenge(HENTAIFOX)).toBe(false);
  });

  it("only inspects the head of the document", () => {
    // The marker scan is capped at 4KB — gallery comments mentioning the
    // phrases must not flag a real page.
    const page = HENTAIFOX + " ".repeat(5000) + "just a moment";
    expect(looksLikeChallenge(page)).toBe(false);
  });
});
