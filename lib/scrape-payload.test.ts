import { describe, expect, it } from "vitest";
import {
  MAX_ENTITIES_PER_KIND, normalizeEntityName, parseScrapePayload, scrapedRef, ScrapePayloadError,
} from "./scrape-payload";

// A title from a site the app has no special knowledge of: its source is the
// host name, its id the one lib/sources.ts finds in the address.
const SITE = "https://3hentai.net";

function payload(over: Record<string, unknown> = {}) {
  return {
    source: "3hentai.net",
    source_id: "612345",
    url: `${SITE}/d/612345`,
    title_name: "Some Title",
    image_link: "https://s5.3hentai.net/d612345/cover.jpg",
    pages: 24,
    uploaded_at: "2020-05-01",
    tags: [{ name: "big breasts", link: `${SITE}/tags/big-breasts`, total_works: 120 }],
    artists: [{ name: "pendhei", link: `${SITE}/artists/pendhei`, total_works: 0 }],
    groups: [],
    characters: [],
    parodies: [],
    ...over,
  };
}

const rejects = (over: Record<string, unknown>, msg: RegExp) =>
  expect(() => parseScrapePayload(payload(over))).toThrow(msg);

const accepts = (over: Record<string, unknown>) => parseScrapePayload(payload(over));

describe("parseScrapePayload", () => {
  it("passes a clean payload through, keeping only known fields", () => {
    // A stray `hashtag` means nothing for a site other than nhentai.
    const r = parseScrapePayload(payload({ extra: "<script>", hashtag: 5 }));
    expect(r).toEqual({
      source: "3hentai.net",
      source_id: "612345",
      url: "https://3hentai.net/d/612345",
      title_name: "Some Title",
      image_link: "https://s5.3hentai.net/d612345/cover.jpg",
      pages: 24,
      uploaded_at: "2020-05-01",
      tags: [{ name: "big breasts", link: "https://3hentai.net/tags/big-breasts", total_works: 120 }],
      artists: [{ name: "pendhei", link: "https://3hentai.net/artists/pendhei", total_works: 0 }],
      groups: [],
      characters: [],
      parodies: [],
    });
    expect(r).not.toHaveProperty("extra");
    expect(r).not.toHaveProperty("hashtag");
  });

  it("throws a ValidationError the route maps to 400", () => {
    try {
      parseScrapePayload(null);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScrapePayloadError);
      expect((e as Error).name).toBe("ValidationError");
    }
  });

  it.each([undefined, 5, "x", [], [payload()]])("rejects %j as not an object", (raw) => {
    expect(() => parseScrapePayload(raw)).toThrow(/expected an object/);
  });

  describe("older shapes", () => {
    it("reads the legacy nhentai-only shape (older scraper hosts)", () => {
      const legacy = {
        hashtag: 177013,
        title_name: "PenXjbs",
        image_link: "https://t.nhentai.net/galleries/811673/cover.jpg",
        pages: 225,
        uploaded_at: "2016-10-18",
        tags: [], artists: [], groups: [], characters: [], parodies: [],
      };
      const r = parseScrapePayload(legacy);
      expect(r.source).toBe("nhentai");
      expect(r.source_id).toBe("177013");
      // Rebuilt from the id: an older host never sent one.
      expect(r.url).toBe("https://nhentai.net/g/177013/");
      expect(r).not.toHaveProperty("hashtag");
    });

    it("refuses a legacy hashtag that is not an nhentai key", () => {
      rejects({ source: undefined, source_id: undefined, hashtag: 0 }, /hashtag must be a positive integer/);
      rejects({ source: undefined, source_id: undefined, hashtag: 1_000_000_000 }, /hashtag must be a positive integer/);
      rejects({ source: undefined, source_id: undefined, hashtag: "177013" }, /hashtag must be a positive integer/);
      rejects({ source: undefined, source_id: undefined, hashtag: 1.5 }, /hashtag must be a positive integer/);
    });

    // The seven-site shape (a legacy key, no url) — what the previous app
    // version's hosts and browser tabs send. Each lands on the page its old
    // rows were read at, so a re-scrape updates the same row.
    it.each([
      ["nhentai", "177013", "https://nhentai.net/g/177013/"],
      ["ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"],
      ["hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
      ["hentaifox", "98765", "https://hentaifox.com/gallery/98765/"],
      ["imhentai", "1234567", "https://imhentai.xxx/gallery/1234567/"],
      ["pururin", "12345", "https://pururin.me/gallery/12345/x"],
      ["hentai2read", "morningledgerjoregra", "https://hentai2read.com/morningledgerjoregra/"],
    ])("reads a %s payload without a url at its canonical page", (source, id, url) => {
      const r = accepts({ source, source_id: id, url: undefined });
      expect(r).toMatchObject({ source, source_id: id, url });
      expect(scrapedRef(r)).toEqual({ source, id });
    });

    it("keeps a legacy key's own address when one is sent", () => {
      expect(accepts({ source: "hentaifox", source_id: "98765", url: "https://www.hentaifox.com/gallery/98765/" }).url)
        .toBe("https://www.hentaifox.com/gallery/98765/");
      expect(accepts({ source: "ehentai", source_id: "899557/edd545586a", url: "https://e-hentai.org/g/899557/edd545586a/?p=1" }).url)
        .toBe("https://e-hentai.org/g/899557/edd545586a/?p=1");
      // pururin's former domain is still pururin.
      expect(accepts({ source: "pururin", source_id: "12345", url: "https://pururin.to/gallery/12345/some-title" }).source)
        .toBe("pururin");
    });
  });

  describe("a title from any site", () => {
    it("takes a site the app has never heard of, filed under its host name", () => {
      const r = accepts({
        source: "myreadingmanga.info",
        source_id: "some-title-english",
        url: "https://myreadingmanga.info/some-title-english/",
        image_link: "https://i0.wp.com/myreadingmanga.info/wp-content/uploads/2024/05/cover.jpg?ssl=1",
        tags: [{ name: "Yaoi", link: "https://myreadingmanga.info/tag/yaoi/", total_works: 0 }],
        artists: [],
      });
      expect(r).toMatchObject({
        source: "myreadingmanga.info",
        source_id: "some-title-english",
        url: "https://myreadingmanga.info/some-title-english/",
        tags: [{ name: "yaoi", link: "https://myreadingmanga.info/tag/yaoi/", total_works: 0 }],
      });
      expect(scrapedRef(r)).toEqual({ source: "myreadingmanga.info", id: "some-title-english" });
    });

    it("reads the site from the address, whatever subdomain the page was on", () => {
      expect(accepts({ url: "https://www.3hentai.net/d/612345" }).source).toBe("3hentai.net");
      expect(accepts({ url: "http://3hentai.net/d/612345/3" }).url).toBe("http://3hentai.net/d/612345/3");
    });

    it("treats an nhentai mirror as its own site, not as nhentai", () => {
      const r = accepts({ source: "nhentai.xxx", source_id: "830956", url: "https://nhentai.xxx/g/830956/" });
      expect(scrapedRef(r)).toEqual({ source: "nhentai.xxx", id: "830956" });
      rejects({ source: "nhentai", source_id: "830956", url: "https://nhentai.xxx/g/830956/" }, /url is not on nhentai\.net/);
    });

    it("rejects a source that is not a site", () => {
      rejects({ source: "example", source_id: "1" }, /is not a site/); // no dot, not a legacy key
      rejects({ source: "3Hentai.net" }, /is not a site/); // not the canonical lowercase form
      rejects({ source: "127.0.0.1", url: "https://127.0.0.1/d/612345" }, /is not a site/);
      rejects({ source: "" }, /is not a site/);
      rejects({ source: 5 }, /is not a site/);
      rejects({ source: "3hentai.net/d" }, /is not a site/);
      rejects({ source: undefined }, /is not a site/);
      // Neither half: read as the oldest shape, which needs a hashtag.
      rejects({ source: undefined, source_id: undefined }, /hashtag must be a positive integer/);
    });

    it("rejects a malformed id", () => {
      for (const source_id of ["", "612 345", "612345\n", "x".repeat(256), 612345, null, undefined]) {
        rejects({ source_id }, /source_id must be a non-empty string/);
      }
    });

    it("requires the title's own web address", () => {
      // Only a legacy key can be rebuilt into an address.
      rejects({ url: undefined }, /url must be the title's http\(s\) address/);
      for (const url of [
        "", 5, "3hentai.net/d/612345", "ftp://3hentai.net/d/612345", "javascript:alert(1)//3hentai.net/d/612345",
        "https://user:pw@3hentai.net/d/612345", "https://3hentai.net:8443/d/612345",
        `${SITE}/d/612345?${"a".repeat(1024)}`,
      ]) {
        rejects({ url }, /url must be the title's http\(s\) address/);
      }
    });

    it("rejects an address on another site than the source", () => {
      rejects({ url: "https://evil.example/d/612345" }, /url is not on 3hentai\.net/);
      // A subdomain is a different host name, so a different site key.
      rejects({ url: "https://cdn.3hentai.net/d/612345" }, /url is not on 3hentai\.net/);
      rejects({ source: "hentaifox", source_id: "98765", url: "https://evil.example/gallery/98765/" }, /url is not on hentaifox\.com/);
      // A legacy site's title is filed under its legacy key, never twice under
      // its host name as well.
      rejects({ source: "hentaifox.com", source_id: "98765", url: "https://hentaifox.com/gallery/98765/" }, /url is not on/);
    });

    it("rejects an id the address does not name", () => {
      // A payload cannot file one title's data under another title's id.
      rejects({ source_id: "612346" }, /url does not name "612346"/);
      rejects({ source_id: "0612345" }, /url does not name/);
      rejects({ source_id: "612345/../../etc" }, /url does not name/);
      rejects({ source_id: "big-breasts", url: `${SITE}/tags/big-breasts` }, /url does not name/); // a listing
      rejects({ source_id: "1", url: `${SITE}/` }, /url does not name/); // the home page
      // A legacy key's rebuilt address must name the id too.
      rejects({ source: "hentai2read", source_id: "hentai-list", url: undefined }, /url does not name/);
      rejects({ source: "hitomi", source_id: "1234567", url: "https://hitomi.la/galleries/7654321.html" }, /url does not name/);
      rejects({ source: "nhentai", source_id: "5", url: undefined, hashtag: 6, image_link: "" }, /hashtag does not match/);
    });

    // nhentai's key IS the hashtag, which the database keeps below 1e9
    // (migration 9's titles_source_hashtag_check; lib/sources.ts refFromUrl
    // refuses the same ids). The boundary must say so with a 400 instead of
    // handing the insert a key the CHECK (or INT4) then rejects with a 500.
    for (const source_id of ["1000000000", "2147483648", "abc"]) {
      it(`rejects nhentai id ${source_id}, which cannot be its hashtag`, () => {
        expect(() => accepts({ source: "nhentai", source_id, url: undefined })).toThrow(ScrapePayloadError);
      });
    }

    it("keeps nhentai's valid ids", () => {
      expect(accepts({ source: "nhentai", source_id: "999999999", url: undefined }).url).toBe("https://nhentai.net/g/999999999/");
      expect(accepts({ source: "nhentai", source_id: "177013", url: undefined, hashtag: 177013 }).source_id).toBe("177013");
    });
  });

  describe("covers", () => {
    it("accepts a cover on any CDN", () => {
      for (const image_link of [
        "https://cdn.some-other-host.net/x/cover.webp?sig=abc&exp=1",
        "http://i.3hentai.net/cover.jpg",
        "https://i0.wp.com/myreadingmanga.info/wp-content/uploads/cover.jpg?ssl=1",
        `https://cdn.example.com/${"x".repeat(1000)}`, // 1024 characters
      ]) {
        expect(accepts({ image_link }).image_link).toBe(image_link);
      }
    });

    it("keeps a title without a cover", () => {
      expect(accepts({ image_link: "" }).image_link).toBe("");
    });

    it("rejects a cover that is not a web address", () => {
      for (const image_link of [
        "javascript:alert(1)", "data:image/png;base64,AAAA", "/cover.jpg", "cover.jpg",
        "ftp://cdn.example.com/cover.jpg", "https://127.0.0.1/cover.jpg", "https://user:pw@cdn.example.com/c.jpg",
        `https://cdn.example.com/${"x".repeat(1001)}`, // 1025 characters
      ]) {
        rejects({ image_link }, /image_link must be an http\(s\) address/);
      }
      rejects({ image_link: null }, /image_link must be a string/);
      rejects({ image_link: undefined }, /image_link must be a string/);
    });
  });

  describe("entity links", () => {
    const tagLink = (link: unknown, over: Record<string, unknown> = {}) =>
      accepts({ ...over, tags: [{ name: "x", link, total_works: 3 }] }).tags;

    it("keeps a link on the title's site, subdomains included", () => {
      for (const link of [`${SITE}/tags/x`, "https://www.3hentai.net/tags/x", "http://tags.3hentai.net/x"]) {
        expect(tagLink(link)).toEqual([{ name: "x", link, total_works: 3 }]);
      }
      // A legacy key's site is its host, with every domain it went by.
      expect(tagLink("https://hentaifox.com/tag/x/", { source: "hentaifox", source_id: "98765", url: undefined })[0].link)
        .toBe("https://hentaifox.com/tag/x/");
      expect(tagLink("https://pururin.to/tags/x", { source: "pururin", source_id: "12345", url: undefined })[0].link)
        .toBe("https://pururin.to/tags/x");
    });

    it("drops a link that leaves the site, keeping the entity", () => {
      for (const link of [
        "https://evil.example/tags/x", "https://3hentai.net.evil.example/tags/x", "javascript:alert(1)",
        "/tags/x", "", `${SITE}/tags/${"x".repeat(250)}`, "https://user:pw@3hentai.net/tags/x",
      ]) {
        expect(tagLink(link)).toEqual([{ name: "x", link: "", total_works: 3 }]);
      }
      // The same rule for every category.
      const r = accepts({
        artists: [{ name: "a", link: "https://evil.example/a", total_works: 0 }],
        groups: [{ name: "g", link: "https://evil.example/g", total_works: 0 }],
        characters: [{ name: "c", link: "https://evil.example/c", total_works: 0 }],
        parodies: [{ name: "p", link: "https://evil.example/p", total_works: 0 }],
      });
      for (const kind of ["artists", "groups", "characters", "parodies"] as const) expect(r[kind][0].link).toBe("");
    });

    it("still refuses an entity that is not one", () => {
      rejects({ tags: [{ name: "x", link: 5, total_works: 0 }] }, /tags contains an invalid entity/);
      rejects({ artists: [{ name: "x", total_works: 0 }] }, /artists contains an invalid entity/);
    });
  });

  it("rejects malformed fields", () => {
    rejects({ title_name: "   " }, /title_name/);
    rejects({ title_name: "x".repeat(256) }, /title_name/);
    rejects({ title_name: 5 }, /title_name/);
    rejects({ pages: -1 }, /pages/);
    rejects({ pages: 1.5 }, /pages/);
    rejects({ pages: 100_001 }, /pages/);
    rejects({ pages: Infinity }, /pages/);
    rejects({ uploaded_at: "yesterday" }, /uploaded_at/);
    rejects({ uploaded_at: 1_600_000_000 }, /uploaded_at/);
    rejects({ uploaded_at: "1900-01-01" }, /out of range/);
    rejects({ tags: "big breasts" }, /tags must be an array/);
    rejects({ parodies: undefined }, /parodies must be an array/);
    rejects({ tags: [null] }, /invalid entity/);
    rejects({ tags: [{ name: "x", link: `${SITE}/tags/x`, total_works: -1 }] }, /invalid entity/);
    rejects({ tags: [{ name: "x", link: `${SITE}/tags/x`, total_works: 2 ** 31 }] }, /invalid entity/);
    rejects({ tags: [{ name: " ", link: `${SITE}/tags/x`, total_works: 0 }] }, /empty or oversized/);
    rejects({ tags: [{ name: "x".repeat(256), link: `${SITE}/tags/x`, total_works: 0 }] }, /empty or oversized/);
    const many = Array.from({ length: MAX_ENTITIES_PER_KIND + 1 }, (_, i) => ({
      name: `t${i}`, link: `${SITE}/tags/t${i}`, total_works: 0,
    }));
    rejects({ tags: many }, /more than/);
    expect(accepts({ tags: many.slice(1) }).tags).toHaveLength(MAX_ENTITIES_PER_KIND);
  });

  it("keeps an unknown upload date unknown instead of inventing one", () => {
    expect(parseScrapePayload(payload({ uploaded_at: null })).uploaded_at).toBeNull();
    expect(parseScrapePayload(payload({ uploaded_at: undefined })).uploaded_at).toBeNull();
    expect(parseScrapePayload(payload({ uploaded_at: "2016-10-18T12:28:49+00:00" })).uploaded_at).toBe("2016-10-18");
  });

  it("normalizes names into one vocabulary and dedupes them", () => {
    const r = parseScrapePayload(payload({
      title_name: "  Two\n  lines\u0007 ",
      tags: [
        { name: "Big  Breasts", link: `${SITE}/tags/big-breasts`, total_works: 5 },
        { name: "big breasts", link: `${SITE}/tags/big-breasts-2`, total_works: 6 },
        { name: "Ｓｗｉｍｓｕｉｔ", link: `${SITE}/tags/swimsuit`, total_works: 1 },
      ],
    }));
    expect(r.title_name).toBe("Two lines");
    expect(r.tags.map((t) => t.name)).toEqual(["big breasts", "swimsuit"]);
    expect(r.tags[0]).toEqual({ name: "big breasts", link: `${SITE}/tags/big-breasts`, total_works: 5 });
  });
});

describe("scrapedRef", () => {
  it("names the title a payload describes", () => {
    expect(scrapedRef(parseScrapePayload(payload()))).toEqual({ source: "3hentai.net", id: "612345" });
    expect(scrapedRef({ source: "ehentai", source_id: "899557/edd545586a" })).toEqual({ source: "ehentai", id: "899557/edd545586a" });
  });
});

describe("normalizeEntityName", () => {
  it("lowercases, folds width and collapses whitespace", () => {
    expect(normalizeEntityName("  Quill   Tjgk ")).toBe("quill tjgk");
    expect(normalizeEntityName("ＡＢＣ")).toBe("abc");
  });
});
