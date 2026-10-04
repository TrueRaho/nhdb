import { describe, expect, it } from "vitest";
import { MAX_ENTITIES_PER_KIND, normalizeEntityName, parseScrapePayload, ScrapePayloadError } from "./scrape-payload";

function payload(over: Record<string, unknown> = {}) {
  return {
    source: "hentaifox",
    source_id: "98765",
    title_name: "Some Title",
    image_link: "https://i2.hentaifox.com/004/1/cover.jpg",
    pages: 24,
    uploaded_at: "2020-05-01",
    tags: [{ name: "big breasts", link: "https://hentaifox.com/tag/big-breasts/", total_works: 120 }],
    artists: [{ name: "pendhei", link: "https://hentaifox.com/artist/pendhei/", total_works: 0 }],
    groups: [],
    characters: [],
    parodies: [],
    ...over,
  };
}

const rejects = (over: Record<string, unknown>, msg: RegExp) =>
  expect(() => parseScrapePayload(payload(over))).toThrow(msg);

describe("parseScrapePayload", () => {
  it("passes a clean payload through, keeping only known fields", () => {
    const r = parseScrapePayload(payload({ extra: "<script>", hashtag: 5 }));
    expect(r).toEqual({
      source: "hentaifox",
      source_id: "98765",
      title_name: "Some Title",
      image_link: "https://i2.hentaifox.com/004/1/cover.jpg",
      pages: 24,
      uploaded_at: "2020-05-01",
      tags: [{ name: "big breasts", link: "https://hentaifox.com/tag/big-breasts/", total_works: 120 }],
      artists: [{ name: "pendhei", link: "https://hentaifox.com/artist/pendhei/", total_works: 0 }],
      groups: [],
      characters: [],
      parodies: [],
    });
    expect(r).not.toHaveProperty("extra");
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
  });

  describe("only titles from supported sites", () => {
    it("rejects an unknown or missing source", () => {
      rejects({ source: "example", source_id: "1" }, /unsupported source/);
      rejects({ source: undefined, source_id: undefined }, /hashtag must be a positive integer/);
    });

    it("rejects an id that is not the site's canonical id", () => {
      rejects({ source_id: "98765/../../etc" }, /not a HentaiFox title id/);
      rejects({ source_id: "0098765" }, /not a HentaiFox title id/);
      rejects({ source: "hentai2read", source_id: "hentai-list" }, /not a Hentai2Read title id/);
      rejects({ source: "nhentai", source_id: "1000000000", image_link: "" }, /not a nhentai title id/);
      rejects({ source: "nhentai", source_id: "5", hashtag: 6, image_link: "" }, /hashtag does not match/);
    });

    it("rejects a cover anywhere but the site's own image hosts", () => {
      rejects({ image_link: "https://evil.example/cover.jpg" }, /image host/);
      rejects({ image_link: "https://t.nhentai.net/galleries/1/cover.jpg" }, /image host/);
      rejects({ image_link: "javascript:alert(1)" }, /image host/);
      rejects({ image_link: "http://i.hentaifox.com/cover.jpg" }, /image host/);
      expect(parseScrapePayload(payload({ image_link: "" })).image_link).toBe("");
    });

    it("rejects entity links that leave the site", () => {
      rejects(
        { tags: [{ name: "x", link: "https://evil.example/tag/x", total_works: 0 }] },
        /tags link .* is not a HentaiFox page/,
      );
      rejects({ artists: [{ name: "x", link: "", total_works: 0 }] }, /is not a HentaiFox page/);
    });

    it("rejects malformed fields", () => {
      rejects({ title_name: "   " }, /title_name/);
      rejects({ title_name: "x".repeat(256) }, /title_name/);
      rejects({ title_name: 5 }, /title_name/);
      rejects({ pages: -1 }, /pages/);
      rejects({ pages: 1.5 }, /pages/);
      rejects({ pages: 100_001 }, /pages/);
      rejects({ uploaded_at: "yesterday" }, /uploaded_at/);
      rejects({ uploaded_at: "1900-01-01" }, /out of range/);
      rejects({ tags: "big breasts" }, /tags must be an array/);
      rejects({ tags: [{ name: "x", link: "https://hentaifox.com/tag/x/", total_works: -1 }] }, /invalid entity/);
      rejects({ tags: [{ name: " ", link: "https://hentaifox.com/tag/x/", total_works: 0 }] }, /empty or oversized/);
      const many = Array.from({ length: MAX_ENTITIES_PER_KIND + 1 }, (_, i) => ({
        name: `t${i}`, link: `https://hentaifox.com/tag/t${i}/`, total_works: 0,
      }));
      rejects({ tags: many }, /more than/);
    });
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
        { name: "Big  Breasts", link: "https://hentaifox.com/tag/big-breasts/", total_works: 5 },
        { name: "big breasts", link: "https://hentaifox.com/tag/big-breasts-2/", total_works: 6 },
        { name: "Ｓｗｉｍｓｕｉｔ", link: "https://hentaifox.com/tag/swimsuit/", total_works: 1 },
      ],
    }));
    expect(r.title_name).toBe("Two lines");
    expect(r.tags.map((t) => t.name)).toEqual(["big breasts", "swimsuit"]);
    expect(r.tags[0].total_works).toBe(5);
  });
});

describe("normalizeEntityName", () => {
  it("lowercases, folds width and collapses whitespace", () => {
    expect(normalizeEntityName("  Quill   Tjgk ")).toBe("quill tjgk");
    expect(normalizeEntityName("ＡＢＣ")).toBe("abc");
  });
});
