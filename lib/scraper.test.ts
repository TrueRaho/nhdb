import { beforeEach, describe, expect, it, vi } from "vitest";

// The network layer, faked: each test says what "the site" answers. The
// browser layer is never reached in these tests (every site here either
// answers impit or has no browser layer), and playwright is not installed
// with browsers in CI anyway.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("impit", () => ({
  Impit: class {
    fetch = fetchMock;
  },
}));

import { looksLikeChallenge, scrapeTitle, ScrapeError } from "./scraper";

function answer(body: string, { status = 200, url }: { status?: number; url?: string } = {}) {
  return { status, url: url ?? "", text: async () => body };
}

const HENTAIFOX = `<html><body><div class="info">
  <div class="cover"><img src="https://i.hentaifox.com/004/42/cover.jpg"></div>
  <h1>Title</h1><ul><li><a href="/tag/big-breasts/">big breasts <span class="t_badge">5</span></a></li></ul>
  <span>Pages: 24</span></div></body></html>`;

describe("scrapeTitle", () => {
  beforeEach(() => fetchMock.mockReset());

  it("fetches the address rebuilt from the id, never the pasted one", async () => {
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://hentaifox.com/gallery/42/" }));
    const { scraped, via } = await scrapeTitle(
      "https://evil.example/redirect?to=https://hentaifox.com/gallery/42/&x=https://127.0.0.1/",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hentaifox.com/gallery/42/");
    expect(via).toBe("impit");
    expect(scraped).toMatchObject({ source: "hentaifox", source_id: "42", title_name: "Title", pages: 24 });
  });

  it("refuses input that is not a title link, without fetching anything", async () => {
    for (const input of [
      "https://hentaifox.com/search/?q=quill+mfnd",
      "https://hitomi.la/search.html?quill%20mfnd",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "",
    ]) {
      await expect(scrapeTitle(input)).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
      message: expect.stringMatching(/redirects to hfox 43/),
    });
    // The site's own canonical form of the same title is fine.
    fetchMock.mockResolvedValue(answer(HENTAIFOX, { url: "https://hentaifox.com/gallery/42" }));
    await expect(scrapeTitle("hentaifox:42")).resolves.toMatchObject({ scraped: { source_id: "42" } });
  });

  it("maps a 404 to NOT_FOUND", async () => {
    fetchMock.mockResolvedValue(answer("", { status: 404, url: "https://hitomi.la/x" }));
    await expect(scrapeTitle("https://hitomi.la/galleries/9.html")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("asks E-Hentai's API with the gid and token, and nothing else", async () => {
    fetchMock.mockResolvedValue(answer(JSON.stringify({
      gmetadata: [{
        gid: 899557, token: "edd545586a", title: "A Title", thumb: "https://ehgt.org/a/b.jpg",
        posted: "1376143500", filecount: "20", tags: ["female:big breasts"],
      }],
    }), { url: "https://api.e-hentai.org/api.php" }));
    const { scraped } = await scrapeTitle("https://e-hentai.org/g/899557/edd545586a/");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.e-hentai.org/api.php");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ method: "gdata", gidlist: [[899557, "edd545586a"]], namespace: 1 });
    expect(scraped.source_id).toBe("899557/edd545586a");
  });

  it("gives up on a JSON site that did not answer instead of opening a browser", async () => {
    fetchMock.mockResolvedValue(answer("Service Unavailable", {
      status: 503,
      url: "https://ltn.gold-usergeneratedcontent.net/galleries/9.js",
    }));
    await expect(scrapeTitle("hitomi:9")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Hitomi did not answer for hitomi 9",
    });
  });

  it("fails at the scraper, with the reason, when a parse would not be storable", async () => {
    // More pages than the write boundary accepts: the parse itself succeeds,
    // the payload it produced would not be storable.
    const hitomi = "var galleryinfo = " + JSON.stringify({ id: "9", title: "x", files: new Array(100_001).fill({}) });
    fetchMock.mockResolvedValue(answer(hitomi, { url: "https://ltn.gold-usergeneratedcontent.net/galleries/9.js" }));
    const err = await scrapeTitle("hitomi:9").catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.message).toMatch(/markup drift\? Invalid scrape payload: pages/);
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
