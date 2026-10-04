import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import {
  allImageHosts, hostMatches, isAllowedImageUrl, isSourceLink, parseInputs, parseTitleRef,
  readAddParam, refKey, refLabel, sourceUrl, toTitleRef, type TitleRef,
} from "./sources";

const nh = (...ids: number[]): TitleRef[] => ids.map((id) => ({ source: "nhentai", id: String(id) }));

// A realistic iOS Safari "Copy Links" payload: every open tab, page title and
// URL interleaved. This is the input the add box exists for, so it doubles as
// the regression guard for the parser's whole reason to be.
const COPY_LINKS_DUMP = `Morning Ledger Qiifeco | Page 3 of 12
https://nhentai.net/g/177013/
[Artist] 4 Girls, 24 pages - Read Online
https://nhentai.net/g/895243/
Chapter 7 (2019 reprint)
https://nhentai.net/g/820175/`;

describe("parseTitleRef — one title per site", () => {
  it.each([
    ["https://nhentai.net/g/177013/", "nhentai", "177013"],
    ["https://e-hentai.org/g/899557/edd545586a/", "ehentai", "899557/edd545586a"],
    ["https://e-hentai.org/g/899557/EDD545586A/?p=1", "ehentai", "899557/edd545586a"],
    ["https://e-hentai.org/mpv/899557/edd545586a/", "ehentai", "899557/edd545586a"],
    ["https://hitomi.la/galleries/1234567.html", "hitomi", "1234567"],
    ["https://hitomi.la/reader/1234567.html#1", "hitomi", "1234567"],
    ["https://hitomi.la/doujinshi/some-title-english-1234567.html", "hitomi", "1234567"],
    ["https://hitomi.la/manga/%E3%81%82-%E3%81%84-1234567.html", "hitomi", "1234567"],
    ["https://hentaifox.com/gallery/98765/", "hentaifox", "98765"],
    ["https://hentaifox.com/g/98765/3/", "hentaifox", "98765"],
    ["https://imhentai.xxx/gallery/1234567/", "imhentai", "1234567"],
    ["https://imhentai.xxx/view/1234567/1/", "imhentai", "1234567"],
    ["https://pururin.me/gallery/67890/some-title", "pururin", "67890"],
    ["https://pururin.to/gallery/88048/morningledgerotxrlkr-2", "pururin", "88048"],
    ["https://pururin.me/read/67890/01/some-title", "pururin", "67890"],
    ["https://hentai2read.com/trial_note_book/", "hentai2read", "trial_note_book"],
    ["https://hentai2read.com/trial_note_book/1/", "hentai2read", "trial_note_book"],
    ["hentai2read.com/Trial_Note_Book", "hentai2read", "trial_note_book"],
  ])("%s", (input, source, id) => {
    expect(parseTitleRef(input)).toEqual({ source, id });
  });

  it("keeps bare numbers meaning nhentai, as they always did", () => {
    expect(parseTitleRef("177013")).toEqual({ source: "nhentai", id: "177013" });
    expect(parseTitleRef("  #177013 ")).toEqual({ source: "nhentai", id: "177013" });
    expect(parseTitleRef("nhentai.net/g/007")).toEqual({ source: "nhentai", id: "7" });
  });

  it("reads its own source:id form back", () => {
    for (const ref of [
      { source: "hitomi", id: "1234567" },
      { source: "ehentai", id: "899557/edd545586a" },
      { source: "hentai2read", id: "trial_note_book" },
    ] as TitleRef[]) {
      expect(parseTitleRef(refKey(ref))).toEqual(ref);
    }
  });

  // The user-facing promise: only titles. Search, tag and listing pages of the
  // same sites — the very links one copies while browsing — are not titles.
  it.each([
    "https://hentaifox.com/search/?q=quill+mfnd",
    "https://e-hentai.org/?f_search=quill+mfnd",
    "https://hitomi.la/search.html?quill%20mfnd",
    "https://imhentai.xxx/search/?lt=1&pp=0&m=1&d=1&w=1&i=1&a=1&g=1&key=quill+mfnd&apply=Search&en=1&jp=1",
    "https://pururin.me/",
    "https://hentai2read.com/",
    "https://hentai2read.com/hentai-list/category/big-breasts/",
    "https://hentai2read.com/latest/",
    "https://hentai2read.com/search?q=x",
    "https://hentaifox.com/tag/big-breasts/",
    "https://imhentai.xxx/artist/pendhei/",
    "https://hitomi.la/artist/pendhei-all.html",
    "https://e-hentai.org/g/899557/",            // no token: cannot be opened
    "https://e-hentai.org/tag/female:big+breasts",
    "https://exhentai.org/g/899557/edd545586a/", // not a supported site
    "https://example.com/g/177013/",
    "https://nhentai.net/artist/penqech/",
    "javascript:alert(1)",
    "hitomi:abc",
    "unknown:123",
    "",
    "177013 895243",
    "nhentai.net/g/abc",
    "0",
    "12345678901",
  ])("rejects %s", (input) => {
    expect(parseTitleRef(input)).toBeNull();
  });
});

describe("sourceUrl / refLabel", () => {
  it("rebuilds the gallery address from the id alone", () => {
    expect(sourceUrl({ source: "nhentai", id: "177013" })).toBe("https://nhentai.net/g/177013/");
    expect(sourceUrl({ source: "ehentai", id: "899557/edd545586a" })).toBe("https://e-hentai.org/g/899557/edd545586a/");
    expect(sourceUrl({ source: "hitomi", id: "1" })).toBe("https://hitomi.la/galleries/1.html");
    expect(sourceUrl({ source: "hentaifox", id: "1" })).toBe("https://hentaifox.com/gallery/1/");
    expect(sourceUrl({ source: "imhentai", id: "1" })).toBe("https://imhentai.xxx/gallery/1/");
    expect(sourceUrl({ source: "pururin", id: "1" })).toBe("https://pururin.me/gallery/1/x");
    expect(sourceUrl({ source: "hentai2read", id: "a_b" })).toBe("https://hentai2read.com/a_b/");
  });

  it("drops whatever surrounded the id in the pasted link", () => {
    const ref = parseTitleRef("https://evil.example/?u=https://hentaifox.com/gallery/42/&redirect=1")!;
    expect(sourceUrl(ref)).toBe("https://hentaifox.com/gallery/42/");
  });

  it("labels nhentai as it always has and everything else by site", () => {
    expect(refLabel({ source: "nhentai", id: "177013" })).toBe("#177013");
    expect(refLabel({ source: "ehentai", id: "899557/edd545586a" })).toBe("eh 899557");
    expect(refLabel({ source: "hitomi", id: "1234567" })).toBe("hitomi 1234567");
  });
});

describe("toTitleRef", () => {
  it("canonicalizes and refuses non-canonical parts", () => {
    expect(toTitleRef("ehentai", "899557/EDD545586A")).toEqual({ source: "ehentai", id: "899557/edd545586a" });
    expect(toTitleRef("nhentai", "1000000000")).toBeNull(); // the foreign-key range
    expect(toTitleRef("hitomi", "12a")).toBeNull();
    expect(toTitleRef("nope", "1")).toBeNull();
    expect(toTitleRef("hentai2read", "hentai")).toBeNull();
    expect(toTitleRef("hentai2read", "hentai-list")).toBeNull();
  });
});

describe("parseInputs", () => {
  it("reads a single id, with or without the hash", () => {
    expect(parseInputs("177013")).toEqual(nh(177013));
    expect(parseInputs("#177013")).toEqual(nh(177013));
    expect(parseInputs("  177013  ")).toEqual(nh(177013));
  });

  it("splits on commas, spaces and newlines alike", () => {
    expect(parseInputs("820175, 831895 563281\n895243")).toEqual(nh(820175, 831895, 563281, 895243));
  });

  it("reads gallery URLs in any surrounding punctuation", () => {
    expect(parseInputs("https://nhentai.net/g/177013/")).toEqual(nh(177013));
    expect(parseInputs("nhentai.net/g/177013")).toEqual(nh(177013));
    expect(parseInputs("https://www.nhentai.net/g/177013/")).toEqual(nh(177013));
    expect(parseInputs("[A title](https://nhentai.net/g/831895/)")).toEqual(nh(831895));
    expect(parseInputs('"https://nhentai.net/g/831895/"')).toEqual(nh(831895));
    expect(parseInputs("[x](https://hentai2read.com/a_b/)")).toEqual([{ source: "hentai2read", id: "a_b" }]);
  });

  it("splits URLs concatenated with no separator at all", () => {
    // A Shortcuts "Text" action that puts [Clipboard][URL] side by side with no
    // comma produces exactly this — one token, several titles.
    expect(parseInputs("https://nhentai.net/g/837933/https://nhentai.net/g/177013/")).toEqual(nh(837933, 177013));
    expect(parseInputs("nhentai.net/g/1nhentai.net/g/2nhentai.net/g/3")).toEqual(nh(1, 2, 3));
    expect(parseInputs("https://hitomi.la/galleries/5.htmlhttps://hentaifox.com/gallery/6/https://nhentai.net/g/7/"))
      .toEqual([{ source: "hitomi", id: "5" }, { source: "hentaifox", id: "6" }, ...nh(7)]);
  });

  it("mixes sites, bare ids and refs, in paste order", () => {
    expect(parseInputs(
      "177013\nhttps://e-hentai.org/g/899557/edd545586a/ imhentai:42\nhttps://pururin.me/gallery/67890/t 895243",
    )).toEqual([
      ...nh(177013),
      { source: "ehentai", id: "899557/edd545586a" },
      { source: "imhentai", id: "42" },
      { source: "pururin", id: "67890" },
      ...nh(895243),
    ]);
  });

  it("drops the non-title links of a mixed paste and keeps the titles", () => {
    expect(parseInputs(`https://hentaifox.com/search/?q=quill+mfnd
https://hentaifox.com/gallery/98765/
https://hitomi.la/search.html?quill%20mfnd
https://example.com/whatever`)).toEqual([{ source: "hentaifox", id: "98765" }]);
  });

  it("keeps paste order and drops duplicates, URL and bare form alike", () => {
    expect(parseInputs("nhentai.net/g/2222222 111111")).toEqual(nh(2222222, 111111));
    expect(parseInputs("895243, 177013, 895243")).toEqual(nh(895243, 177013));
    expect(parseInputs("177013 https://nhentai.net/g/177013/")).toEqual(nh(177013));
    expect(parseInputs("https://hitomi.la/reader/9.html https://hitomi.la/galleries/9.html hitomi:9"))
      .toEqual([{ source: "hitomi", id: "9" }]);
  });

  it("keeps the same number on different sites apart", () => {
    expect(parseInputs("https://hentaifox.com/gallery/123456/ https://imhentai.xxx/gallery/123456/ 123456"))
      .toEqual([{ source: "hentaifox", id: "123456" }, { source: "imhentai", id: "123456" }, ...nh(123456)]);
  });

  it("pulls only the real ids out of a Copy Links dump", () => {
    // The titles carry 2016, 3, 12, 4, 24, 7 and 2019 — none may survive.
    expect(parseInputs(COPY_LINKS_DUMP)).toEqual(nh(177013, 895243, 820175));
  });

  it("trusts any digit run when the whole input is numbers (typed by hand)", () => {
    expect(parseInputs("1234")).toEqual(nh(1234));
    expect(parseInputs("#42, 7")).toEqual(nh(42, 7));
  });

  it("trusts only id-shaped runs once prose is mixed in", () => {
    expect(parseInputs("read 3 of 12 chapters in 2024")).toEqual([]);
    expect(parseInputs("page 24 · 12345678 · 2019")).toEqual([]);
  });

  it("still takes a short id from a URL inside prose", () => {
    expect(parseInputs("an old one https://nhentai.net/g/42/ from 2013")).toEqual(nh(42));
  });

  it("returns an empty list for nothing usable", () => {
    expect(parseInputs("")).toEqual([]);
    expect(parseInputs("   \n  ")).toEqual([]);
    expect(parseInputs("hello world")).toEqual([]);
  });

  it("normalizes ids", () => {
    expect(parseInputs("nhentai.net/g/007")).toEqual(nh(7));
  });

  // Documented consequences of the "prose means strict" rule — asserted so a
  // future loosening of the heuristic is a deliberate change, not a surprise.
  describe("known limitations", () => {
    it("drops a pre-10000 bare id when prose is present", () => {
      expect(parseInputs("old gallery 4242 from the archive")).toEqual([]);
    });

    it("accepts an id-shaped number that is really part of a title", () => {
      expect(parseInputs("Serial Experiments 123456 - Read Online")).toEqual(nh(123456));
    });
  });
});

describe("readAddParam", () => {
  it("reads one id", () => {
    expect(readAddParam("?add=177013")).toEqual(nh(177013));
    expect(readAddParam("add=177013")).toEqual(nh(177013));
  });

  it("reads a comma separated batch in order", () => {
    expect(readAddParam("?add=177013,895243,820175")).toEqual(nh(177013, 895243, 820175));
  });

  it("reads a percent-encoded gallery URL (what a share sheet hands over)", () => {
    expect(readAddParam("?add=https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F")).toEqual(nh(177013));
    expect(readAddParam("?add=https%3A%2F%2Fhitomi.la%2Fgalleries%2F1234567.html"))
      .toEqual([{ source: "hitomi", id: "1234567" }]);
  });

  it("reads a comma-joined clipboard of raw URLs (the accumulator shortcut)", () => {
    // What "share each tab, append to clipboard" produces: full URLs, unencoded,
    // separated by whatever the shortcut joins them with.
    expect(readAddParam("?add=https://nhentai.net/g/837933/,https://nhentai.net/g/177013/"))
      .toEqual(nh(837933, 177013));
    // A leading separator (first share onto an empty clipboard) must not matter.
    expect(readAddParam("?add=,837933,177013")).toEqual(nh(837933, 177013));
    // Newline-joined survives too, in case the shortcut uses line breaks.
    expect(readAddParam("?add=https://nhentai.net/g/837933/%0Ahttps://nhentai.net/g/177013/"))
      .toEqual(nh(837933, 177013));
  });

  it("ignores leftover junk sitting in the clipboard accumulator", () => {
    // The accumulator starts from whatever was already copied, so the list
    // routinely begins with unrelated text. Only id-shaped tokens may survive.
    expect(readAddParam("?add=gg,837933,641937")).toEqual(nh(837933, 641937));
    expect(readAddParam("?add=some note,837933")).toEqual(nh(837933));
  });

  it("survives an accumulator-style dump: leading comma, an encoded page title, a line break", () => {
    // Shaped like a share-sheet accumulator dump that let a page title through.
    // The title carries a stray "4" and punctuation; only id-shaped tokens count.
    const dump =
      ",246813,259134,318452,Sample%20Story%20Hero-chan%20~%20Surely%20Not%20Defeated!?" +
      "%20Hero-chan%20Big%20Trouble!!%20%7C%20Sample%20Story%20Hero%204:" +
      "%20Hero's%20Unlucky%20Losing%20Streak?!%20%C2%BB%20nhentai%0A364571,342687";
    expect(readAddParam(`?add=${dump}`)).toEqual(nh(246813, 259134, 318452, 364571, 342687));
  });

  it("accepts a fully URL-encoded list (the shortcut runs the value through URL Encode)", () => {
    // Encoding the accumulator turns every separator into %2C and any stray
    // space into %20 — the decode has to happen before parsing, not after.
    expect(readAddParam("?add=%2C837933%2C641937")).toEqual(nh(837933, 641937));
    expect(readAddParam("?add=gg%2C837933%2C641937")).toEqual(nh(837933, 641937));
    expect(readAddParam("?add=old%20note%2C837933")).toEqual(nh(837933));
  });

  it("joins repeated params instead of dropping all but the first", () => {
    expect(readAddParam("?add=177013&add=895243")).toEqual(nh(177013, 895243));
  });

  it("ignores unrelated params", () => {
    expect(readAddParam("?utm_source=shortcut&add=177013&view=stats")).toEqual(nh(177013));
  });

  it("returns an empty list when there is nothing to add", () => {
    expect(readAddParam("")).toEqual([]);
    expect(readAddParam("?view=stats")).toEqual([]);
    expect(readAddParam("?add=")).toEqual([]);
    expect(readAddParam("?add=not-an-id")).toEqual([]);
  });
});

describe("host allow-lists", () => {
  it("matches next/image wildcard semantics", () => {
    expect(hostMatches("*.nhentai.net", "t3.nhentai.net")).toBe(true);
    expect(hostMatches("*.nhentai.net", "nhentai.net")).toBe(false);
    expect(hostMatches("*.nhentai.net", "a.b.nhentai.net")).toBe(false);
    expect(hostMatches("*.nhentai.net", "evilnhentai.net")).toBe(false);
    expect(hostMatches("**.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatches("ehgt.org", "ehgt.org")).toBe(true);
    expect(hostMatches("ehgt.org", "xehgt.org")).toBe(false);
  });

  it("accepts a cover only from the title's own image hosts, over plain https", () => {
    expect(isAllowedImageUrl("nhentai", "https://t3.nhentai.net/galleries/1/cover.jpg")).toBe(true);
    expect(isAllowedImageUrl("ehentai", "https://ehgt.org/14/63/x_l.jpg")).toBe(true);
    expect(isAllowedImageUrl("hitomi", "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/x.webp")).toBe(true);
    expect(isAllowedImageUrl("hentaifox", "https://i2.hentaifox.com/004/1/cover.jpg")).toBe(true);
    expect(isAllowedImageUrl("imhentai", "https://m7.imhentai.xxx/021/x/cover.jpg")).toBe(true);
    expect(isAllowedImageUrl("pururin", "https://cdn.pururin.me/assets/images/data/1/cover.jpg")).toBe(true);
    expect(isAllowedImageUrl("hentai2read", "https://static.hentaicdn.com/hentai/cover/_S1.jpg")).toBe(true);

    // Another site's CDN, a lookalike, http, credentials, a port, junk.
    expect(isAllowedImageUrl("hentaifox", "https://t3.nhentai.net/galleries/1/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "https://t.nhentai.net.evil.com/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "http://t.nhentai.net/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "https://u:p@t.nhentai.net/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "https://t.nhentai.net:8443/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedImageUrl("nhentai", "/galleries/1/cover.jpg")).toBe(false);
    expect(isAllowedImageUrl("nhentai", `https://t.nhentai.net/${"a".repeat(260)}`)).toBe(false);
  });

  it("accepts entity links only on the title's own site", () => {
    expect(isSourceLink("nhentai", "https://nhentai.net/tag/ahegao/")).toBe(true);
    expect(isSourceLink("hentaifox", "https://www.hentaifox.com/tag/x/")).toBe(true);
    expect(isSourceLink("hentaifox", "https://nhentai.net/tag/x/")).toBe(false);
    expect(isSourceLink("nhentai", "https://evil.com/?nhentai.net")).toBe(false);
    expect(isSourceLink("nhentai", "javascript:alert(1)")).toBe(false);
  });

  it("next.config.ts serves exactly the cover hosts a title may store", () => {
    const patterns = nextConfig.images?.remotePatterns ?? [];
    expect(patterns.map((p) => (p instanceof URL ? p.hostname : p.hostname)).sort()).toEqual(allImageHosts().sort());
    for (const p of patterns) {
      if (p instanceof URL) continue;
      expect(p.protocol).toBe("https");
      expect(p.port).toBe("");
    }
  });
});
