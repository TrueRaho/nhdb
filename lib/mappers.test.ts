import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbTitleToItem, scrapedToItem, type DbTitle } from "./mappers";
import { coverSeed, itemLabel, itemUrl, scrapeInputOf } from "./data";
import { parseTitleRef } from "./sources";
import type { ScrapeResult } from "./scrape-payload";

// DbTitle is the full Prisma payload type; tests only exercise the fields the
// mapper reads, so the fixture is built loose and cast once here.
function row(overrides: Record<string, unknown> = {}): DbTitle {
  return {
    hashtag: 177013,
    source: "nhentai",
    sourceId: "177013",
    url: "https://nhentai.net/g/177013/",
    titleName: "PenXjbs",
    alterName: null,
    imageLink: "https://t.nhentai.net/x/cover.jpg",
    pages: 225,
    uploadedAt: new Date("2016-10-18T00:00:00Z"),
    createdAt: new Date("2026-08-10T00:00:00Z"),
    readCount: 3,
    lastReadAt: new Date("2026-08-14T00:00:00Z"),
    avgTagValue: null,
    tags: [{ tag: { tagName: "ahegao" } }, { tag: { tagName: "dark skin" } }],
    artists: [{ artist: { artistName: "penqech" } }],
    groups: [],
    characters: [{ character: { characterName: "quill imco" } }],
    parodies: [{ parody: { parodieName: "original" } }],
    ...overrides,
  } as unknown as DbTitle;
}

describe("dbTitleToItem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts dates to whole-day 'days ago' integers", () => {
    const item = dbTitleToItem(row());
    expect(item.addedAt).toBe(6); // 2026-08-10 → 6 days
    expect(item.lastReadAt).toBe(2); // 2026-08-14 → 2 days
    expect(item.uploadedAt).toBe(Math.floor((Date.now() - new Date("2016-10-18T00:00:00Z").getTime()) / 86400000));
  });

  it("keeps null lastReadAt as null, never 'today'", () => {
    expect(dbTitleToItem(row({ lastReadAt: null })).lastReadAt).toBeNull();
  });

  it("maps a null alterName to the empty string the client expects", () => {
    expect(dbTitleToItem(row()).alterName).toBe("");
    expect(dbTitleToItem(row({ alterName: "PenEbir" })).alterName).toBe("PenEbir");
  });

  it("flattens relation rows to plain name arrays in order", () => {
    const item = dbTitleToItem(row());
    expect(item.tags).toEqual(["ahegao", "dark skin"]);
    expect(item.artists).toEqual(["penqech"]);
    expect(item.groups).toEqual([]);
    expect(item.characters).toEqual(["quill imco"]);
    expect(item.parodies).toEqual(["original"]);
  });

  it("floors partial days rather than rounding up", () => {
    // 23h59m ago is still day 0 — the UI renders 0 as "today".
    const item = dbTitleToItem(row({ createdAt: new Date("2026-08-15T12:01:00Z") }));
    expect(item.addedAt).toBe(0);
  });

  it("keeps an unknown upload date unknown", () => {
    expect(dbTitleToItem(row({ uploadedAt: null })).uploadedAt).toBeNull();
  });

  it("carries where the title comes from, and the page it is read at", () => {
    const item = dbTitleToItem(row({
      hashtag: 1_000_000_007,
      source: "myreadingmanga.info",
      sourceId: "some-title-english",
      url: "https://myreadingmanga.info/some-title-english/",
    }));
    expect(item).toMatchObject({
      hashtag: 1_000_000_007,
      source: "myreadingmanga.info",
      sourceId: "some-title-english",
      url: "https://myreadingmanga.info/some-title-english/",
    });
    expect(itemLabel(item)).toBe("myreadingmanga some-title-english");
    expect(itemUrl(item)).toBe("https://myreadingmanga.info/some-title-english/");
    expect(dbTitleToItem(row()).url).toBe("https://nhentai.net/g/177013/");
  });

  it("rebuilds the page of a legacy row saved before titles kept their address", () => {
    const hitomi = dbTitleToItem(row({ hashtag: 1_000_000_007, source: "hitomi", sourceId: "1234567", url: null }));
    expect(hitomi).toMatchObject({ source: "hitomi", sourceId: "1234567" });
    expect(itemLabel(hitomi)).toBe("hitomi 1234567");
    expect(itemUrl(hitomi)).toBe("https://hitomi.la/galleries/1234567.html");
    expect(dbTitleToItem(row({ url: null })).url).toBe("https://nhentai.net/g/177013/");
    expect(dbTitleToItem(row({ source: "ehentai", sourceId: "899557/edd545586a", url: null })).url)
      .toBe("https://e-hentai.org/g/899557/edd545586a/");
    // A stored address wins over the rebuilt one.
    expect(dbTitleToItem(row({ source: "hitomi", sourceId: "1234567", url: "https://hitomi.la/doujinshi/x-1234567.html" })).url)
      .toBe("https://hitomi.la/doujinshi/x-1234567.html");
  });

  it("still links a row of another site that lost its address to that site", () => {
    expect(dbTitleToItem(row({ source: "3hentai.net", sourceId: "612345", url: null })).url).toBe("https://3hentai.net/");
    expect(dbTitleToItem(row({ source: "3hentai.net", sourceId: "612345", url: "" })).url).toBe("https://3hentai.net/");
  });

  it("never hands the client a source it cannot render", () => {
    expect(dbTitleToItem(row({ source: "Not A Site" })).source).toBe("nhentai");
    expect(dbTitleToItem(row({ source: "3hentai.net", sourceId: "612345" })).source).toBe("3hentai.net");
  });
});

describe("scrapedToItem", () => {
  const scraped: ScrapeResult = {
    source: "3hentai.net",
    source_id: "612345",
    url: "https://3hentai.net/d/612345",
    title_name: "T",
    image_link: "",
    pages: 3,
    uploaded_at: null,
    tags: [{ name: "a", link: "https://3hentai.net/tags/a", total_works: 0 }],
    artists: [], groups: [], characters: [], parodies: [],
  };

  it("has no key yet for another site's title, and keeps nhentai's", () => {
    expect(scrapedToItem(scraped).hashtag).toBe(0);
    expect(scrapedToItem({ ...scraped, source: "nhentai", source_id: "177013", url: "https://nhentai.net/g/177013/" }).hashtag)
      .toBe(177013);
    // An nhentai mirror is another site: no key until the save hands one out.
    expect(scrapedToItem({ ...scraped, source: "nhentai.xxx", source_id: "830956", url: "https://nhentai.xxx/g/830956/" }).hashtag)
      .toBe(0);
    expect(scrapedToItem(scraped).uploadedAt).toBeNull();
    expect(scrapedToItem(scraped).tags).toEqual(["a"]);
  });

  it("links the preview to the page it was scraped from", () => {
    const item = scrapedToItem(scraped);
    expect(item).toMatchObject({ source: "3hentai.net", sourceId: "612345", url: "https://3hentai.net/d/612345" });
    expect(itemUrl(item)).toBe("https://3hentai.net/d/612345");
    expect(itemLabel(item)).toBe("3hentai 612345");
  });

  it("paints the same cover art before and after the first save", () => {
    const preview = scrapedToItem(scraped);
    const saved = { ...preview, hashtag: 1_000_000_009 };
    expect(coverSeed(preview)).toBe(coverSeed(saved));
    // nhentai keeps the seed every existing cover was drawn from.
    expect(coverSeed({ hashtag: 177013, source: "nhentai", sourceId: "177013" })).toBe(177013);
  });

  it("previews and saves one title the same way", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
    try {
      const preview = scrapedToItem({ ...scraped, uploaded_at: "2026-08-10" });
      const saved = dbTitleToItem(row({
        hashtag: 1_000_000_009, source: scraped.source, sourceId: scraped.source_id, url: scraped.url,
        uploadedAt: new Date("2026-08-10T00:00:00Z"),
      }));
      expect(preview.url).toBe(saved.url);
      expect(preview.uploadedAt).toBe(saved.uploadedAt);
      expect(coverSeed(preview)).toBe(coverSeed(saved));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scrapeInputOf", () => {
  // The detail modal's re-scrape sends this to /api/scrape, which reads it
  // with parseTitleRef — so it must parse back to the same title, any site.
  it.each([
    ["nhentai", "177013", "https://nhentai.net/g/177013/"],
    ["3hentai.net", "612345", "https://3hentai.net/d/612345"],
    ["hentaixcomic.com", "morning-ledger-pzngxsq", "https://hentaixcomic.com/manga/morning-ledger-pzngxsq/"],
    ["simply-hentai.com", "quill-rrsu/morning-ledger-celutsx", "https://simply-hentai.com/quill-rrsu/morning-ledger-celutsx"],
  ])("re-scrapes a %s title as itself", (source, sourceId, url) => {
    const item = dbTitleToItem(row({ hashtag: 1_000_000_001, source, sourceId, url }));
    expect(parseTitleRef(scrapeInputOf(item))).toMatchObject({ source, id: sourceId });
  });
});

