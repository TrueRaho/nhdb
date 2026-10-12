import { describe, expect, it } from "vitest";
import {
  ADD_PARAM, COVER_PATH, coverSrc, galleryIdOf, isLegacySource, isSameSite, isSourceKey, legacyUrl, MAX_URL,
  parseInputs, parseRefKey, parseTitleRef, parseWebUrl, quickAddInput, quickAddPath, readAddParam, refFromUrl,
  refKey, refLabel, siteHost,
  siteKey, siteName, titleUrl, toTitleKey, urlsIn, type TitleKey, type TitleRef,
} from "./sources";

describe("R3.8: calendar archive tails versus reader numbers", () => {
  it.each(["https://blog.example/archive/2024/05", "https://blog.example/archives/2024/05/"])("refuses date-shaped archive %s", (raw) => {
    expect(galleryIdOf(new URL(raw))).toBeNull();
  });
  it("keeps a reader's chapter and page after its title slug", () => {
    expect(galleryIdOf(new URL("https://hentai2read.com/trial_note_book/1/5/"))).toBe("trial_note_book");
  });
});

const nh = (...ids: number[]): TitleRef[] =>
  ids.map((id) => ({ source: "nhentai", id: String(id), url: `https://nhentai.net/g/${id}/` }));

it("skips oversized dotted paste fragments without repeatedly scanning their suffixes", () => {
  const text = `${"a.".repeat(30_000)} https://nhentai.net/g/177013/`;
  const start = performance.now();
  expect(parseInputs(text)).toEqual(nh(177013));
  expect(performance.now() - start).toBeLessThan(500);
});

const ref = (source: string, id: string, url: string): TitleRef => ({ source, id, url });

/** The gallery id of an address that must itself be a valid web address. */
function idOf(raw: string): string | null {
  const url = parseWebUrl(raw);
  if (!url) throw new Error(`not a web address: ${raw}`);
  return galleryIdOf(url);
}

// A realistic iOS Safari "Copy Links" payload: every open tab, page title and
// URL interleaved. This is the input the add box exists for, so it doubles as
// the regression guard for the parser's whole reason to be.
const COPY_LINKS_DUMP = `Morning Ledger Qiifeco | Page 3 of 12
https://nhentai.net/g/177013/
[Artist] 4 Girls, 24 pages - Read Online
https://nhentai.net/g/895243/
Chapter 7 (2019 reprint)
https://nhentai.net/g/820175/`;

// The same kind of dump, from sites nobody listed anywhere: galleries, a
// search, a home page, a reader page of a gallery already in the dump.
const OTHER_SITES_DUMP = `Some Title (C97) [Circle] | 3Hentai
https://3hentai.net/d/612345
Another One - 24 pages - AsmHentai
https://asmhentai.com/g/321456/
Search results for "big breasts" 2019
https://3hentai.net/search?q=big+breasts
Luscious - Home
https://www.luscious.net/
Some Album 2 | Luscious
https://www.luscious.net/albums/some-album-title_456789/
Chapter 1 - Madara Reader
https://manhwa.example.org/manga/some-title/chapter-1/
Some Title (C97) [Circle] | 3Hentai, page 3
https://3hentai.net/d/612345/3`;

// ---------------------------------------------------------------------------
// The seven legacy sites: every old address shape, every old id
// ---------------------------------------------------------------------------

describe("galleryIdOf — the seven legacy sites keep their old ids", () => {
  // Rows saved under the old per-site registry carry exactly these ids; a new
  // scrape of the same title must land on the same (source, id) or it becomes
  // a duplicate. The url is the site's canonical page, as `sourceUrl` built it.
  it.each([
    // nhentai: the number after /g/; a reader page belongs to its gallery.
    ["https://nhentai.net/g/177013/", "nhentai", "177013", "https://nhentai.net/g/177013/"],
    ["https://nhentai.net/g/177013/1/", "nhentai", "177013", "https://nhentai.net/g/177013/"],
    ["https://nhentai.net/g/007", "nhentai", "7", "https://nhentai.net/g/7/"],
    // E-Hentai: gid AND token, lowercased; /mpv/ and the lofi view are the same gallery.
    ["https://e-hentai.org/g/899557/edd545586a/", "ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"],
    ["https://e-hentai.org/g/899557/EDD545586A/?p=1", "ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"],
    ["https://e-hentai.org/mpv/899557/edd545586a/", "ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"],
    ["https://e-hentai.org/lofi/g/899557/edd545586a/", "ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"],
    // ~1% of tokens are all digits, and are tokens all the same.
    ["https://e-hentai.org/g/899557/0123456789/", "ehentai", "899557/0123456789", "https://e-hentai.org/g/899557/0123456789/"],
    // Hitomi: /galleries/, /reader/ and the slugged type pages all end in the id.
    ["https://hitomi.la/galleries/1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/reader/1234567.html#1", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/doujinshi/some-title-english-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/manga/%E3%81%82-%E3%81%84-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/cg/some-cg-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/gamecg/x-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/imageset/x-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    ["https://hitomi.la/anime/x-1234567.html", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html"],
    // HentaiFox: /gallery/<id>/ and its reader /g/<id>/<page>/.
    ["https://hentaifox.com/gallery/98765/", "hentaifox", "98765", "https://hentaifox.com/gallery/98765/"],
    ["https://hentaifox.com/g/98765/3/", "hentaifox", "98765", "https://hentaifox.com/gallery/98765/"],
    // IMHentai: /gallery/<id>/ and its reader /view/<id>/<page>/.
    ["https://imhentai.xxx/gallery/1234567/", "imhentai", "1234567", "https://imhentai.xxx/gallery/1234567/"],
    ["https://imhentai.xxx/view/1234567/1/", "imhentai", "1234567", "https://imhentai.xxx/gallery/1234567/"],
    // Pururin, on its current and former domains, gallery and reader.
    ["https://pururin.me/gallery/67890/some-title", "pururin", "67890", "https://pururin.me/gallery/67890/x"],
    ["https://pururin.to/gallery/88048/morningledgerotxrlkr-2", "pururin", "88048", "https://pururin.me/gallery/88048/x"],
    ["https://pururin.me/read/67890/01/some-title", "pururin", "67890", "https://pururin.me/gallery/67890/x"],
    // A one-word slug spelt in hex letters is a word, not a token glued to the id.
    ["https://pururin.me/gallery/86334/facade", "pururin", "86334", "https://pururin.me/gallery/86334/x"],
    ["https://pururin.to/gallery/86334/decade/", "pururin", "86334", "https://pururin.me/gallery/86334/x"],
    ["https://pururin.me/gallery/86334/beaded", "pururin", "86334", "https://pururin.me/gallery/86334/x"],
    // Hentai2Read: the slug, lowercased; a chapter page belongs to its title.
    ["https://hentai2read.com/trial_note_book/", "hentai2read", "trial_note_book", "https://hentai2read.com/trial_note_book/"],
    ["https://hentai2read.com/trial_note_book/1/", "hentai2read", "trial_note_book", "https://hentai2read.com/trial_note_book/"],
    // …and so does a page of a chapter.
    ["https://hentai2read.com/trial_note_book/1/5/", "hentai2read", "trial_note_book", "https://hentai2read.com/trial_note_book/"],
    ["https://hentai2read.com/trial_note_book/12/34", "hentai2read", "trial_note_book", "https://hentai2read.com/trial_note_book/"],
    ["hentai2read.com/Trial_Note_Book", "hentai2read", "trial_note_book", "https://hentai2read.com/trial_note_book/"],
    // A slug that ends in a number is still the whole slug.
    ["https://hentai2read.com/morningledgerhhxtbzk_2019/", "hentai2read", "morningledgerhhxtbzk_2019", "https://hentai2read.com/morningledgerhhxtbzk_2019/"],
    ["https://hentai2read.com/sister_1234/2/", "hentai2read", "sister_1234", "https://hentai2read.com/sister_1234/"],
  ])("%s", (input, source, id, url) => {
    expect(parseTitleRef(input)).toEqual({ source, id, url });
    expect(refFromUrl(/^https?:/.test(input) ? input : `https://${input}`)).toEqual({ source, id, url });
  });

  it("finds the same id on the www./m. hosts of a legacy site", () => {
    expect(parseTitleRef("https://www.nhentai.net/g/177013/")).toEqual(nh(177013)[0]);
    expect(parseTitleRef("https://m.hentaifox.com/gallery/42/")).toEqual(ref("hentaifox", "42", "https://hentaifox.com/gallery/42/"));
    expect(parseTitleRef("https://www.pururin.to/gallery/88048/x")).toEqual(ref("pururin", "88048", "https://pururin.me/gallery/88048/x"));
  });

  it("keeps bare numbers meaning nhentai, as they always did", () => {
    expect(parseTitleRef("177013")).toEqual(nh(177013)[0]);
    expect(parseTitleRef("  #177013 ")).toEqual(nh(177013)[0]);
    expect(parseTitleRef("nhentai.net/g/007")).toEqual(nh(7)[0]);
    expect(parseTitleRef("999999999")).toEqual(nh(999999999)[0]);
  });

  it("reads a legacy source:id form back", () => {
    for (const key of [
      { source: "nhentai", id: "177013" },
      { source: "hitomi", id: "1234567" },
      { source: "ehentai", id: "899557/edd545586a" },
      { source: "hentaifox", id: "1" },
      { source: "imhentai", id: "42" },
      { source: "pururin", id: "88048" },
      { source: "hentai2read", id: "trial_note_book" },
    ] as TitleKey[]) {
      const back = parseTitleRef(refKey(key));
      expect(back).toEqual({ ...key, url: legacyUrl(key.source, key.id) });
    }
    // ...normalized the same way as the address it stands for.
    expect(parseTitleRef("ehentai:899557/EDD545586A")?.id).toBe("899557/edd545586a");
  });

  it("drops whatever surrounded the id in the pasted link", () => {
    // A legacy title is read at its canonical page, never at the pasted address.
    expect(parseTitleRef("https://evil.example/?u=https://hentaifox.com/gallery/42/&redirect=1"))
      .toEqual(ref("hentaifox", "42", "https://hentaifox.com/gallery/42/"));
  });
});

// ---------------------------------------------------------------------------
// Any other site
// ---------------------------------------------------------------------------

describe("galleryIdOf — any other site, by the shape of its address", () => {
  it.each([
    // a gallery word, then a number
    ["https://3hentai.net/d/612345", "612345"],
    ["https://3hentai.net/d/612345/1", "612345"],
    ["https://asmhentai.com/g/321456/", "321456"],
    ["https://example.com/gallery/12345/", "12345"],
    ["HTTPS://WWW.Example.ORG/G/123/", "123"],
    // a slug that ends in a long number
    ["https://luscious.net/albums/some-album-title_456789/", "456789"],
    // a slug after a gallery word (Madara-style manga sites), with or without a chapter
    ["https://manhwa.example.org/manga/some-title/", "some-title"],
    ["https://manhwa.example.org/manga/some-title/chapter-1/", "some-title"],
    // a letter-prefixed number (HentaiHere), reader pages included
    ["https://hentaihere.com/m/S12345", "s12345"],
    ["https://hentaihere.com/m/S12345/1/1/", "s12345"],
    // a hex token right after a number is part of the id (E-Hentai's mirrors)...
    ["https://exhentai.org/g/899557/edd545586a/", "899557/edd545586a"],
    ["https://example.org/g/899557/a1b2c3", "899557/a1b2c3"],
    ["https://example.org/g/899557/0123456789", "899557/0123456789"],
    ["https://example.org/g/899557/abcdefabcd", "899557/abcdefabcd"],
    // ...but a page number, something too short to be a token, or a word spelt
    // in hex letters (a slug: "/gallery/86334/facade") is not
    ["https://example.org/g/899557/1234567", "899557"],
    ["https://example.org/g/899557/abcde", "899557"],
    ["https://example.org/g/899557/abcdef", "899557"],
    ["https://example.org/gallery/86334/facade", "86334"],
    // an id query parameter
    ["https://site.example.org/view.php?id=123", "123"],
    ["https://site.example.org/view.php?id=007", "7"],
    ["https://site.example.org/gallery.php?gid=987", "987"],
    ["https://blog.example.org/?p=123", "123"],
    // a long number anywhere, or a slug ending in one
    ["https://example.com/12345/some-slug", "12345"],
    ["https://example.com/some-title-123456/", "123456"],
    // ...but a year, or an underscore tail outside a gallery word, is part of the name
    ["https://hentaixcomic.com/manga/summer-story-2019/", "summer-story-2019"],
    ["https://example.org/some-title-2021/", "some-title-2021"],
    ["https://example.org/some_title_1234/", "some_title_1234"],
    // a WordPress ?p= is the post only on the front script, elsewhere it is a page
    ["https://blog.example.org/index.php?p=123", "123"],
    ["https://example.com/some-title-slug/?p=2", "some-title-slug"],
    // a blog post filed under its date names the post, not the date
    ["https://blog.example.org/2024/05/some-post-title/", "some-post-title"],
    ["https://blog.example.org/2024/05/12/some-post-title/", "some-post-title"],
    ["https://blog.example.org/2024/05/some-post-title-123456/", "123456"],
    // a lone slug, optionally followed by a chapter number
    ["https://example.org/some-title/", "some-title"],
    ["https://example.org/some-title/3/", "some-title"],
  ])("%s → %s", (input, id) => {
    expect(idOf(input)).toBe(id);
  });

  it("never gives two titles one id because their slugs end alike", () => {
    // An upsert on a shared (source, id) would overwrite one title with the other.
    const pairs = [
      ["https://hentaixcomic.com/manga/summer-story-2019/", "https://hentaixcomic.com/manga/morningledgerspmefad-2019/"],
      ["https://myreadingmanga.info/circle-summer-vacation-2021/", "https://myreadingmanga.info/other-circle-winter-story-2021/"],
      ["https://somesite.com/some-title-slug/?p=2", "https://somesite.com/another-title/?p=2"],
    ];
    for (const [a, b] of pairs) {
      expect(idOf(a)).not.toBeNull();
      expect(idOf(a)).not.toBe(idOf(b));
    }
  });

  it("files a title under its site's host, read at the address that was pasted", () => {
    expect(parseTitleRef("https://3hentai.net/d/612345")).toEqual(ref("3hentai.net", "612345", "https://3hentai.net/d/612345"));
    expect(parseTitleRef("https://exhentai.org/g/899557/edd545586a/"))
      .toEqual(ref("exhentai.org", "899557/edd545586a", "https://exhentai.org/g/899557/edd545586a/"));
    // No host list: a site nobody has heard of is a site like any other.
    expect(parseTitleRef("https://example.com/g/177013/")).toEqual(ref("example.com", "177013", "https://example.com/g/177013/"));
  });

  it("tidies the kept address: no fragment, no tracking parameters; the rest stays", () => {
    expect(parseTitleRef("https://3hentai.net/d/42?utm_source=a&utm_medium=b&fbclid=c&gclid=d&page=2#comments"))
      .toEqual(ref("3hentai.net", "42", "https://3hentai.net/d/42?page=2"));
    // The source drops "www."; the address keeps the host it was pasted with.
    expect(parseTitleRef("https://www.3hentai.net/d/42/")).toEqual(ref("3hentai.net", "42", "https://www.3hentai.net/d/42/"));
  });

  it("finds a link inside prose, with or without its scheme", () => {
    expect(parseTitleRef("check this out https://3hentai.net/d/612345 lol")).toEqual(ref("3hentai.net", "612345", "https://3hentai.net/d/612345"));
    expect(parseTitleRef("3hentai.net/d/612345")).toEqual(ref("3hentai.net", "612345", "https://3hentai.net/d/612345"));
    expect(parseTitleRef("www.asmhentai.com/g/321456/"))
      .toEqual(ref("asmhentai.com", "321456", "https://www.asmhentai.com/g/321456/"));
  });

  // A gallery word introduces the id (GALLERY_WORDS: "what follows them names
  // it"); standing alone it is the site's section index. Taking the word itself
  // as the id files every such page under ONE key per site, so two different
  // galleries collide. The old registry refused these (H2R_RESERVED, and
  // `toTitleRef("hentai2read", "hentai")` was pinned null in this file).
  it("never takes a bare gallery word as the id", () => {
    expect(idOf("https://hentai2read.com/hentai/")).toBeNull();
    expect(idOf("https://hentai2read.com/manga/")).toBeNull();
    expect(idOf("https://example.org/manga/")).toBeNull();
    expect(idOf("https://example.org/albums/")).toBeNull();
    expect(idOf("https://example.org/read/")).toBeNull();
  });

  it("does not give two galleries behind one script the same id", () => {
    // An opaque ?id= value is the id, kept as written — not the script's name.
    const a = idOf("https://example.org/gallery?id=abc");
    const b = idOf("https://example.org/gallery?id=def");
    expect(a === null || a !== b).toBe(true);
    expect(a).toBe("abc");
    expect(idOf("https://example.org/watch?v=f09248")).toBe("f09248");
  });
});

// ---------------------------------------------------------------------------
// What is not a title
// ---------------------------------------------------------------------------

describe("galleryIdOf — listings are not titles", () => {
  // The user-facing promise: only titles. Search, tag and listing pages — the
  // very links one copies while browsing — are not titles, on any site.
  it.each([
    "https://nhentai.net/",
    "https://nhentai.net/?page=2",
    "https://nhentai.net/search/?q=177013",
    "https://nhentai.net/artist/penqech/",
    "https://nhentai.net/tag/big-breasts/",
    "https://nhentai.net/parody/penvxcz/",
    "https://nhentai.net/character/x/",
    "https://nhentai.net/group/x/",
    "https://nhentai.net/language/english/popular",
    "https://e-hentai.org/",
    "https://e-hentai.org/?f_search=quill+mfnd",
    "https://e-hentai.org/tag/female:big+breasts",
    "https://e-hentai.org/s/100d258bf7/899557-1",
    "https://hitomi.la/search.html?quill%20mfnd",
    "https://hitomi.la/artist/pendhei-all.html",
    "https://hitomi.la/tag/big%20breasts-all.html",
    "https://hitomi.la/type/doujinshi-all.html",
    "https://hentaifox.com/search/?q=quill+mfnd",
    "https://hentaifox.com/tag/big-breasts/",
    "https://imhentai.xxx/artist/pendhei/",
    "https://imhentai.xxx/search/?lt=1&pp=0&m=1&d=1&w=1&i=1&a=1&g=1&key=quill+mfnd&apply=Search&en=1&jp=1",
    "https://pururin.me/",
    "https://hentai2read.com/",
    "https://hentai2read.com/hentai-list/",
    "https://hentai2read.com/hentai-list/category/big-breasts/",
    "https://hentai2read.com/latest/",
    "https://hentai2read.com/search?q=x",
    // the same words on any other site
    "https://example.com/",
    "https://example.com/tag/x/",
    "https://example.com/tags/x/",
    "https://example.com/artist/x/",
    "https://example.com/search?q=x",
    "https://example.com/category/big-breasts/",
    "https://example.com/genres/x/",
    "https://example.com/hentai-list/",
    "https://example.com/manga-list/",
    "https://example.com/page/2/",
    "https://example.com/popular/",
    "https://example.com/random/",
    "https://example.com/favorites/",
    "https://example.com/users/bob",
    "https://example.com/login",
    "https://example.com/g/",
    "https://example.com/x/y/z",
    "https://blog.example.org/2024/05/",
    "https://example.org/ab",
  ])("%s", (input) => {
    expect(idOf(input)).toBeNull();
    expect(parseTitleRef(input)).toBeNull();
  });
});

describe("parseWebUrl — what may be stored or fetched at all", () => {
  it("accepts http(s) on a named host", () => {
    expect(parseWebUrl("https://example.org/g/1/")?.toString()).toBe("https://example.org/g/1/");
    expect(parseWebUrl("http://example.org/g/1/")?.toString()).toBe("http://example.org/g/1/");
    expect(parseWebUrl(" https://example.org/g/1/ ")?.toString()).toBe("https://example.org/g/1/");
    expect(parseWebUrl("https://xn--80ak6aa92e.com/g/1/")).not.toBeNull();
    // The scheme's own port, spelled out, is the same address.
    expect(parseWebUrl("https://example.org:443/g/1/")?.toString()).toBe("https://example.org/g/1/");
  });

  it.each([
    // IP literals: a gallery site has a name
    "https://127.0.0.1/g/177013/",
    "https://10.0.0.1/g/1",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/g/177013/",
    "https://[::ffff:7f00:1]/g/1",
    "https://0x7f000001/g/1",
    "https://2130706433/g/1",
    // an explicit port, credentials
    "https://nhentai.net:8443/g/177013/",
    "https://example.org:8080/g/1/",
    "https://u:p@nhentai.net/g/177013/",
    "https://user@example.org/g/1/",
    // other schemes
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "ftp://nhentai.net/g/177013/",
    "mailto:a@b.co",
    // single-label hosts, no scheme, too long, empty
    "https://localhost/g/177013/",
    "https://example/g/1/",
    "//example.org/g/1",
    "example.org/g/1",
    `https://example.org/${"a".repeat(MAX_URL)}`,
    "",
  ])("rejects %s", (input) => {
    expect(parseWebUrl(input)).toBeNull();
    if (/^(?:https?|javascript|data|file|mailto):/.test(input)) expect(parseTitleRef(input)).toBeNull();
  });

  it("rejects anything that is not a string", () => {
    for (const v of [undefined, null, 42, {}, new URL("https://example.org/g/1/")]) expect(parseWebUrl(v)).toBeNull();
  });
});

describe("parseTitleRef — rejects", () => {
  it.each([
    "javascript:alert(1)",
    "unknown:123",           // only a legacy key can be rebuilt into an address
    "hentaifox.com:42",      // a host key is a lookup key, not something to paste
    "",
    "177013 895243",
    "nhentai.net/g/abc",
    "nhentai:abc",
    "0",
    "12345678901",
    "1000000000",            // nhentai's id IS the hashtag, kept below 1e9
    "https://nhentai.net/g/1000000000/",
    "https://127.0.0.1/g/177013/",
    "https://nhentai.net:8443/g/177013/",
    "https://u:p@nhentai.net/g/177013/",
    "https://localhost/g/177013/",
    "hello world",
  ])("%s", (input) => {
    expect(parseTitleRef(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

describe("siteKey", () => {
  it("maps every legacy host back to its old key, former domains included", () => {
    expect(siteKey("nhentai.net")).toBe("nhentai");
    expect(siteKey("e-hentai.org")).toBe("ehentai");
    expect(siteKey("hitomi.la")).toBe("hitomi");
    expect(siteKey("hentaifox.com")).toBe("hentaifox");
    expect(siteKey("imhentai.xxx")).toBe("imhentai");
    expect(siteKey("pururin.me")).toBe("pururin");
    expect(siteKey("pururin.to")).toBe("pururin");
    expect(siteKey("pururin.io")).toBe("pururin");
    expect(siteKey("hentai2read.com")).toBe("hentai2read");
  });

  it("strips www./m. and case before mapping", () => {
    expect(siteKey("www.nhentai.net")).toBe("nhentai");
    expect(siteKey("m.nhentai.net")).toBe("nhentai");
    expect(siteKey("NHENTAI.NET")).toBe("nhentai");
    expect(siteKey("nhentai.net.")).toBe("nhentai");
    expect(siteKey("www.HentaiFox.com")).toBe("hentaifox");
    expect(siteKey("m.hentaifox.com")).toBe("hentaifox");
    expect(siteKey("www.pururin.to")).toBe("pururin");
  });

  it("names any other site by its host, minus www./m.", () => {
    expect(siteKey("3hentai.net")).toBe("3hentai.net");
    expect(siteKey("www.3hentai.net")).toBe("3hentai.net");
    expect(siteKey("www2.example.com")).toBe("example.com");
    expect(siteKey("mobile.example.com")).toBe("example.com");
    expect(siteKey("m.Example.com")).toBe("example.com");
  });

  it("keeps a subdomain that is a different host", () => {
    expect(siteKey("manhwa.example.org")).toBe("manhwa.example.org");
    expect(siteKey("g.e-hentai.org")).toBe("g.e-hentai.org");
    expect(siteKey("t3.nhentai.net")).toBe("t3.nhentai.net");
  });

  it("does not collapse lookalike mirrors into a legacy site", () => {
    expect(siteKey("nhentai.to")).toBe("nhentai.to");
    expect(siteKey("nhentai.xxx")).toBe("nhentai.xxx");
    expect(siteKey("exhentai.org")).toBe("exhentai.org");
    expect(siteKey("evilnhentai.net")).toBe("evilnhentai.net");
  });

  it("never strips a host down to a bare top-level domain", () => {
    expect(siteKey("www.com")).toBe("www.com");
    expect(siteKey("m.example")).toBe("m.example");
  });
});

describe("site helpers", () => {
  const LEGACY = [
    ["nhentai", "nhentai.net", "https://nhentai.net/g/1/"],
    ["ehentai", "e-hentai.org", "https://e-hentai.org/g/1/"],
    ["hitomi", "hitomi.la", "https://hitomi.la/galleries/1.html"],
    ["hentaifox", "hentaifox.com", "https://hentaifox.com/gallery/1/"],
    ["imhentai", "imhentai.xxx", "https://imhentai.xxx/gallery/1/"],
    ["pururin", "pururin.me", "https://pururin.me/gallery/1/x"],
    ["hentai2read", "hentai2read.com", "https://hentai2read.com/1/"],
  ] as const;

  it.each(LEGACY)("%s: host %s, page %s", (key, host, page) => {
    expect(isLegacySource(key)).toBe(true);
    expect(isSourceKey(key)).toBe(true);
    expect(siteHost(key)).toBe(host);
    expect(siteName(key)).toBe(host);
    expect(legacyUrl(key, "1")).toBe(page);
    // a legacy key's host round-trips to the key
    expect(siteKey(host)).toBe(key);
  });

  it("treats any other source as its own host, with no rebuilt page", () => {
    expect(isLegacySource("3hentai.net")).toBe(false);
    expect(siteHost("3hentai.net")).toBe("3hentai.net");
    expect(siteName("3hentai.net")).toBe("3hentai.net");
    expect(legacyUrl("3hentai.net", "1")).toBeNull();
    // Object.prototype is not a table of sites.
    for (const k of ["toString", "__proto__", "hasOwnProperty", "constructor"]) {
      expect(isLegacySource(k)).toBe(false);
      expect(isSourceKey(k)).toBe(false);
    }
  });

  it("accepts as a source only what siteKey could produce", () => {
    for (const k of ["nhentai", "hentai2read", "hentaifox.com", "3hentai.net", "manhwa.example.org", "xn--80ak6aa92e.com"]) {
      expect(isSourceKey(k), k).toBe(true);
    }
    for (const k of ["", "foo", "localhost", "127.0.0.1", "HentaiFox.com", "a..b", "-a.com", "a.b-", "a.123", "a b.com", 1, null, undefined]) {
      expect(isSourceKey(k), String(k)).toBe(false);
    }
  });

  it("tells one site's hosts from another's", () => {
    expect(isSameSite("nhentai.net", "www.nhentai.net")).toBe(true);
    expect(isSameSite("i.nhentai.net", "nhentai.net")).toBe(true);
    expect(isSameSite("pururin.to", "pururin.me")).toBe(true);
    expect(isSameSite("hentaifox.com", "nhentai.net")).toBe(false);
    expect(isSameSite("evilnhentai.net", "nhentai.net")).toBe(false);
    expect(isSameSite("e-hentai.org", "exhentai.org")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pastes
// ---------------------------------------------------------------------------

describe("urlsIn", () => {
  it("finds every address, scheme-less ones as https, trailing punctuation trimmed", () => {
    expect(urlsIn("[A](https://nhentai.net/g/831895/).")).toEqual(["https://nhentai.net/g/831895/"]);
    expect(urlsIn("see (3hentai.net/d/612345), ok")).toEqual(["https://3hentai.net/d/612345"]);
    expect(urlsIn("https://nhentai.net/g/837933/https://nhentai.net/g/177013/"))
      .toEqual(["https://nhentai.net/g/837933/", "https://nhentai.net/g/177013/"]);
    expect(urlsIn("no links here, a.b")).toEqual([]);
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
    expect(parseInputs("[x](https://hentai2read.com/a_b/)")).toEqual([ref("hentai2read", "a_b", "https://hentai2read.com/a_b/")]);
    expect(parseInputs("(https://3hentai.net/d/612345),")).toEqual([ref("3hentai.net", "612345", "https://3hentai.net/d/612345")]);
  });

  it("splits URLs concatenated with no separator at all", () => {
    // A Shortcuts "Text" action that puts [Clipboard][URL] side by side with no
    // comma produces exactly this — one token, several titles.
    expect(parseInputs("https://nhentai.net/g/837933/https://nhentai.net/g/177013/")).toEqual(nh(837933, 177013));
    expect(parseInputs("https://hitomi.la/galleries/5.htmlhttps://hentaifox.com/gallery/6/https://nhentai.net/g/7/"))
      .toEqual([ref("hitomi", "5", "https://hitomi.la/galleries/5.html"), ref("hentaifox", "6", "https://hentaifox.com/gallery/6/"), ...nh(7)]);
    expect(parseInputs("https://3hentai.net/d/612345https://asmhentai.com/g/321456/"))
      .toEqual([ref("3hentai.net", "612345", "https://3hentai.net/d/612345"), ref("asmhentai.com", "321456", "https://asmhentai.com/g/321456/")]);
  });

  it("mixes sites, bare ids and refs, in paste order", () => {
    expect(parseInputs(
      "177013\nhttps://e-hentai.org/g/899557/edd545586a/ imhentai:42\nhttps://pururin.me/gallery/67890/t 895243 https://3hentai.net/d/612345",
    )).toEqual([
      ...nh(177013),
      ref("ehentai", "899557/edd545586a", "https://e-hentai.org/g/899557/edd545586a/"),
      ref("imhentai", "42", "https://imhentai.xxx/gallery/42/"),
      ref("pururin", "67890", "https://pururin.me/gallery/67890/x"),
      ...nh(895243),
      ref("3hentai.net", "612345", "https://3hentai.net/d/612345"),
    ]);
  });

  it("drops the non-title links of a mixed paste and keeps the titles", () => {
    expect(parseInputs(`https://hentaifox.com/search/?q=quill+mfnd
https://hentaifox.com/gallery/98765/
https://hitomi.la/search.html?quill%20mfnd
https://example.com/
https://example.com/tag/whatever/`)).toEqual([ref("hentaifox", "98765", "https://hentaifox.com/gallery/98765/")]);
  });

  it("drops links the app could never fetch", () => {
    expect(parseInputs(
      "https://127.0.0.1/g/177013/ https://nhentai.net:8443/g/1/ https://u:p@x.example/g/1/ javascript:alert(1) https://localhost/g/2/",
    )).toEqual([]);
  });

  it("keeps paste order and drops duplicates, URL and bare form alike", () => {
    expect(parseInputs("nhentai.net/g/2222222 111111")).toEqual(nh(2222222, 111111));
    expect(parseInputs("895243, 177013, 895243")).toEqual(nh(895243, 177013));
    expect(parseInputs("177013 https://nhentai.net/g/177013/")).toEqual(nh(177013));
    expect(parseInputs("https://hitomi.la/reader/9.html https://hitomi.la/galleries/9.html hitomi:9"))
      .toEqual([ref("hitomi", "9", "https://hitomi.la/galleries/9.html")]);
    // On any site: a reader page, a www. host and a tracking link are the title already seen.
    expect(parseInputs("https://3hentai.net/d/42 https://3hentai.net/d/42/1 https://www.3hentai.net/d/42/ https://3hentai.net/d/42?utm_source=x"))
      .toEqual([ref("3hentai.net", "42", "https://3hentai.net/d/42")]);
  });

  it("keeps the same number on different sites apart", () => {
    expect(parseInputs("https://hentaifox.com/gallery/123456/ https://imhentai.xxx/gallery/123456/ 123456"))
      .toEqual([
        ref("hentaifox", "123456", "https://hentaifox.com/gallery/123456/"),
        ref("imhentai", "123456", "https://imhentai.xxx/gallery/123456/"),
        ...nh(123456),
      ]);
    expect(parseInputs("https://3hentai.net/d/123456 https://asmhentai.com/g/123456/ https://nhentai.to/g/123456").map(refKey))
      .toEqual(["3hentai.net:123456", "asmhentai.com:123456", "nhentai.to:123456"]);
  });

  it("pulls only the real ids out of a Copy Links dump", () => {
    // The titles carry 2016, 3, 12, 4, 24, 7 and 2019 — none may survive.
    expect(parseInputs(COPY_LINKS_DUMP)).toEqual(nh(177013, 895243, 820175));
  });

  it("pulls the titles out of a Copy Links dump from sites nobody listed", () => {
    // The page titles carry C97, 24, 2019, 2, 1 and 3; the search and the home
    // page are not titles; the last link is a reader page of the first title.
    expect(parseInputs(OTHER_SITES_DUMP)).toEqual([
      ref("3hentai.net", "612345", "https://3hentai.net/d/612345"),
      ref("asmhentai.com", "321456", "https://asmhentai.com/g/321456/"),
      ref("luscious.net", "456789", "https://www.luscious.net/albums/some-album-title_456789/"),
      ref("manhwa.example.org", "some-title", "https://manhwa.example.org/manga/some-title/chapter-1/"),
    ]);
  });

  it("reads both dumps pasted together, nhentai and the rest in order", () => {
    expect(parseInputs(`${COPY_LINKS_DUMP}\n${OTHER_SITES_DUMP}`).map(refKey)).toEqual([
      "nhentai:177013", "nhentai:895243", "nhentai:820175",
      "3hentai.net:612345", "asmhentai.com:321456", "luscious.net:456789", "manhwa.example.org:some-title",
    ]);
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

  it("reads only legacy keys as source:id text", () => {
    expect(parseInputs("imhentai:42 hentaifox.com:42 3hentai.net:42 unknown:1").map(refKey)).toEqual(["imhentai:42"]);
  });

  it("returns an empty list for nothing usable", () => {
    expect(parseInputs("")).toEqual([]);
    expect(parseInputs("   \n  ")).toEqual([]);
    expect(parseInputs("hello world")).toEqual([]);
  });

  it("normalizes ids", () => {
    expect(parseInputs("nhentai.net/g/007")).toEqual(nh(7));
    expect(parseInputs("https://site.example.org/view.php?id=007").map(refKey)).toEqual(["site.example.org:7"]);
  });

  // Documented consequences of the "prose means strict" rule and of reading
  // addresses by shape — asserted so a future change to the heuristic is a
  // deliberate change, not a surprise.
  describe("known limitations", () => {
    it("drops a pre-10000 bare id when prose is present", () => {
      expect(parseInputs("old gallery 4242 from the archive")).toEqual([]);
    });

    it("accepts an id-shaped number that is really part of a title", () => {
      expect(parseInputs("Serial Experiments 123456 - Read Online")).toEqual(nh(123456));
    });

    // The per-site regexes could find "nhentai.net/g/1" inside "…/g/1nhentai.net/…";
    // with no host list there is nowhere to cut a scheme-less run. Glued links
    // WITH a scheme still split (above). Nothing wrong comes out for nhentai,
    // whose ids must be numbers.
    it("does not split scheme-less links glued together", () => {
      expect(parseInputs("nhentai.net/g/1nhentai.net/g/2nhentai.net/g/3")).toEqual([]);
    });

    // The address alone can only say "this could be a gallery"; the scraper,
    // reading the page, is what refuses one that is not.
    it("keeps a lone slug on an unknown site for the scraper to judge", () => {
      expect(parseInputs("https://example.com/whatever")).toEqual([ref("example.com", "whatever", "https://example.com/whatever")]);
    });

    it("no longer checks a legacy site's id shape; the site refuses what it cannot open", () => {
      // E-Hentai will not open a gallery without its token, and Hitomi ids are
      // numbers — but neither lands on an existing title's key.
      expect(parseTitleRef("https://e-hentai.org/g/899557/")).toEqual(ref("ehentai", "899557", "https://e-hentai.org/g/899557/"));
      expect(refKey(parseTitleRef("https://e-hentai.org/g/899557/")!)).not.toBe("ehentai:899557/edd545586a");
      expect(parseTitleRef("hitomi:abc")).toEqual(ref("hitomi", "abc", "https://hitomi.la/galleries/abc.html"));
    });
  });
});

describe("readAddParam", () => {
  it("reads one id", () => {
    expect(ADD_PARAM).toBe("add");
    expect(readAddParam("?add=177013")).toEqual(nh(177013));
    expect(readAddParam("add=177013")).toEqual(nh(177013));
  });

  it("reads a comma separated batch in order", () => {
    expect(readAddParam("?add=177013,895243,820175")).toEqual(nh(177013, 895243, 820175));
  });

  it("reads a percent-encoded gallery URL (what a share sheet hands over)", () => {
    expect(readAddParam("?add=https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F")).toEqual(nh(177013));
    expect(readAddParam("?add=https%3A%2F%2Fhitomi.la%2Fgalleries%2F1234567.html"))
      .toEqual([ref("hitomi", "1234567", "https://hitomi.la/galleries/1234567.html")]);
    expect(readAddParam("?add=https%3A%2F%2F3hentai.net%2Fd%2F612345"))
      .toEqual([ref("3hentai.net", "612345", "https://3hentai.net/d/612345")]);
  });

  it("reads a comma-joined clipboard of raw URLs (the accumulator shortcut)", () => {
    // What "share each tab, append to clipboard" produces: full URLs, unencoded,
    // separated by whatever the shortcut joins them with.
    expect(readAddParam("?add=https://nhentai.net/g/837933/,https://nhentai.net/g/177013/"))
      .toEqual(nh(837933, 177013));
    expect(readAddParam("?add=https://nhentai.net/g/837933/,https://3hentai.net/d/612345").map(refKey))
      .toEqual(["nhentai:837933", "3hentai.net:612345"]);
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

describe("quickAddInput / quickAddPath — /add/<link>", () => {
  it.each(["%20", "%2F", "%3F", "%23"])("R3.9: preserves the raw URL's own %s separator", (escape) => {
    const segments = ["https%3A", "site.example", `Some${escape}Title-123456`];
    expect(quickAddInput(segments)).toBe(`https://site.example/Some${escape}Title-123456`);
    expect(parseTitleRef(quickAddInput(segments))).toMatchObject({ source: "site.example", id: "123456" });
  });

  it("R3.9: gives encoded-space title slugs distinct identities", () => {
    const refs = ["Love%20Story", "Love%20Hina", "Love-Story", "Love%2520Story"].map((slug) => parseTitleRef(quickAddInput(["https%3A", "site.example", "manga", slug])));
    expect(refs.map((ref) => ref?.id)).toEqual(["love%20story", "love%20hina", "love-story", "love%2520story"]);
    expect(new Set(refs.map((ref) => refKey(ref!))).size).toBe(4);
  });
  // What Next 16 hands the page, observed on a dev server: segments stay
  // percent-encoded, "//" is merged into one, a trailing "/" is redirected
  // away (308), and the query goes to searchParams.
  //   /add/https:/site.example/view.php?id=7 → ["https%3A", "site.example", "view.php"], { id: "7" }
  //   /add/https://blog.example/?p=123       → ["https%3A", "blog.example"], { p: "123" }
  //   /add/https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F → ["https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F"], {}
  it("puts back the query a raw link left on the /add page", () => {
    const segments = ["https%3A", "site.example", "view.php"];
    // What the page used to read: the path alone, which is no title.
    expect(parseTitleRef(segments.map(decodeURIComponent).join("/"))).toBeNull();
    expect(quickAddInput(segments, { id: "7" })).toBe("https://site.example/view.php?id=7");
    expect(parseTitleRef(quickAddInput(segments, { id: "7" }))).toMatchObject({ source: "site.example", id: "7" });
    expect(parseTitleRef(quickAddInput(["https%3A", "blog.example"], { p: "123" })))
      .toMatchObject({ source: "blog.example", id: "123" });
    expect(parseTitleRef(quickAddInput(["https%3A", "g.example", "gallery.php"], { gid: "42", page: "3" })))
      .toMatchObject({ source: "g.example", id: "42" });
  });

  it("reads the links it always read", () => {
    expect(quickAddInput(["https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F"])).toBe("https://nhentai.net/g/177013/");
    expect(quickAddInput(["https%3A", "hitomi.la", "galleries", "1234567.html"])).toBe("https://hitomi.la/galleries/1234567.html");
    expect(quickAddInput(["https:", "hitomi.la", "galleries", "1234567.html"])).toBe("https://hitomi.la/galleries/1234567.html");
    expect(quickAddInput(["177013"])).toBe("177013");
    expect(quickAddInput(["100%25"])).toBe("100%");
    expect(quickAddInput(["100%"])).toBe("100%"); // a malformed escape is kept, not a 500
  });

  it("joins a query to the one an encoded link already has", () => {
    expect(quickAddInput(["https%3A%2F%2Fsite.example%2Fview.php%3Fid%3D7"])).toBe("https://site.example/view.php?id=7");
    expect(quickAddInput(["https%3A%2F%2Fsite.example%2Fview.php"], { id: "7" })).toBe("https://site.example/view.php?id=7");
    expect(quickAddInput(["https%3A%2F%2Fsite.example%2Fview.php%3Fa%3D1"], { id: "7" }))
      .toBe("https://site.example/view.php?a=1&id=7");
  });

  it("gives an id no query, so a tracking tag cannot spoil it", () => {
    expect(quickAddInput(["177013"], { utm_source: "share" })).toBe("177013");
    expect(parseTitleRef(quickAddInput(["177013"], { utm_source: "share" }))).toMatchObject({ source: "nhentai", id: "177013" });
  });

  it("keeps every value of a repeated parameter", () => {
    expect(quickAddInput(["https%3A", "x.example", "v"], { a: ["1", "2"], b: undefined })).toBe("https://x.example/v?a=1&a=2");
  });

  it("comes back to the same link after signing in, escaped once", () => {
    expect(quickAddPath(["177013"])).toBe("/add/177013");
    expect(quickAddPath(["https%3A", "site.example", "view.php"], { id: "7" })).toBe("/add/https%3A/site.example/view.php?id=7");
    // Encoding Next's already-encoded segment again gave "https%253A%252F…",
    // which reads back as "https%3A%2F…" — no link at all.
    expect(quickAddPath(["https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F"])).toBe("/add/https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F");
    expect(parseTitleRef(decodeURIComponent("https%253A%252F%252Fnhentai.net%252Fg%252F177013%252F"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keys, labels, addresses
// ---------------------------------------------------------------------------

describe("refKey / parseRefKey", () => {
  it("round-trips every kind of key", () => {
    for (const key of [
      { source: "nhentai", id: "177013" },
      { source: "ehentai", id: "899557/edd545586a" },
      { source: "hentai2read", id: "trial_note_book" },
      { source: "3hentai.net", id: "612345" },
      { source: "exhentai.org", id: "899557/edd545586a" },
      { source: "manhwa.example.org", id: "some-title" },
      { source: "hentaihere.com", id: "s12345" },
      { source: "example.com", id: "a:b" }, // only the first colon separates
    ] as TitleKey[]) {
      expect(parseRefKey(refKey(key))).toEqual(key);
    }
    expect(refKey({ source: "3hentai.net", id: "612345" })).toBe("3hentai.net:612345");
  });

  it("is what reads a host key back — parseTitleRef only rebuilds legacy keys", () => {
    // findExistingTitlesAction tries parseRefKey, then parseTitleRef.
    expect(parseTitleRef("3hentai.net:612345")).toBeNull();
    expect(parseTitleRef("exhentai.org:899557/edd545586a")).toBeNull();
    expect(parseRefKey("3hentai.net:612345")).toEqual({ source: "3hentai.net", id: "612345" });
  });

  it("refuses what is not a key", () => {
    for (const v of ["", "177013", ":1", "nhentai:", "nope:1", "localhost:1", "https://x", "HentaiFox.com:1", 5, null, undefined, {}]) {
      expect(parseRefKey(v), String(v)).toBeNull();
    }
  });
});

describe("toTitleKey", () => {
  it("takes stored parts as they are", () => {
    expect(toTitleKey("nhentai", "177013")).toEqual({ source: "nhentai", id: "177013" });
    expect(toTitleKey("ehentai", "899557/edd545586a")).toEqual({ source: "ehentai", id: "899557/edd545586a" });
    expect(toTitleKey("3hentai.net", "612345")).toEqual({ source: "3hentai.net", id: "612345" });
  });

  it("refuses parts that could not have been written", () => {
    expect(toTitleKey("nope", "1")).toBeNull();
    expect(toTitleKey("localhost", "1")).toBeNull();
    expect(toTitleKey("nhentai", "")).toBeNull();
    expect(toTitleKey("nhentai", 1)).toBeNull();
    expect(toTitleKey(null, "1")).toBeNull();
    expect(toTitleKey(undefined, undefined)).toBeNull();
  });
});

describe("refLabel", () => {
  it("labels nhentai as it always has and everything else by its host", () => {
    expect(refLabel({ source: "nhentai", id: "177013" })).toBe("#177013");
    expect(refLabel({ source: "ehentai", id: "899557/edd545586a" })).toBe("e-hentai 899557");
    expect(refLabel({ source: "hitomi", id: "1234567" })).toBe("hitomi 1234567");
    expect(refLabel({ source: "hentaifox", id: "42" })).toBe("hentaifox 42");
    expect(refLabel({ source: "imhentai", id: "42" })).toBe("imhentai 42");
    expect(refLabel({ source: "pururin", id: "1" })).toBe("pururin 1");
    expect(refLabel({ source: "hentai2read", id: "trial_note_book" })).toBe("hentai2read trial_note_book");
    expect(refLabel({ source: "3hentai.net", id: "612345" })).toBe("3hentai 612345");
    expect(refLabel({ source: "exhentai.org", id: "899557/edd545586a" })).toBe("exhentai 899557");
    expect(refLabel({ source: "manhwa.example.org", id: "some-title" })).toBe("manhwa.example some-title");
  });

  it("gives a host key the same label as the legacy key for that host", () => {
    expect(refLabel({ source: "hentaifox.com", id: "42" })).toBe(refLabel({ source: "hentaifox", id: "42" }));
  });

  it("shortens a long id", () => {
    const label = refLabel({ source: "example.com", id: "a".repeat(30) });
    expect(label).toBe(`example ${"a".repeat(23)}…`);
    expect(refLabel({ source: "example.com", id: "a".repeat(24) })).toBe(`example ${"a".repeat(24)}`);
  });
});

describe("titleUrl", () => {
  it("opens a title at its saved address", () => {
    expect(titleUrl("3hentai.net", "1", "https://3hentai.net/d/1")).toBe("https://3hentai.net/d/1");
    expect(titleUrl("nhentai", "177013", "https://nhentai.net/g/177013/1/")).toBe("https://nhentai.net/g/177013/1/");
  });

  it("rebuilds a legacy row's address when none was saved", () => {
    expect(titleUrl("nhentai", "177013", null)).toBe("https://nhentai.net/g/177013/");
    expect(titleUrl("ehentai", "899557/edd545586a", "")).toBe("https://e-hentai.org/g/899557/edd545586a/");
    expect(titleUrl("hitomi", "5", undefined)).toBe("https://hitomi.la/galleries/5.html");
    expect(titleUrl("pururin", "1", null)).toBe("https://pururin.me/gallery/1/x");
    expect(titleUrl("hentai2read", "a_b", null)).toBe("https://hentai2read.com/a_b/");
  });

  it("falls back to the site's front page for any other row without one", () => {
    expect(titleUrl("3hentai.net", "1", null)).toBe("https://3hentai.net/");
  });
});

describe("coverSrc", () => {
  it("routes a stored cover through the same-origin proxy", () => {
    const link = "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/abc.webp";
    expect(COVER_PATH).toBe("/api/cover");
    expect(coverSrc(link)).toBe(`${COVER_PATH}?src=${encodeURIComponent(link)}`);
    expect(new URLSearchParams(coverSrc(link).split("?")[1]).get("src")).toBe(link);
    expect(new URLSearchParams(coverSrc(link).split("?")[1]).has("ref")).toBe(false);
  });

  it("sends the title page's origin along as the Referer to use", () => {
    const link = "https://t3.nhentai.net/galleries/1/cover.jpg";
    const src = coverSrc(link, "https://nhentai.net/g/1/");
    expect(src).toBe(`/api/cover?src=${encodeURIComponent(link)}&ref=${encodeURIComponent("https://nhentai.net")}`);
    const params = new URLSearchParams(src.split("?")[1]);
    expect(params.get("src")).toBe(link);
    expect(params.get("ref")).toBe("https://nhentai.net");
    // only the origin: no path, query or fragment of the page leaks into it
    expect(new URLSearchParams(coverSrc(link, "https://www.3hentai.net/d/1?x=1#y").split("?")[1]).get("ref"))
      .toBe("https://www.3hentai.net");
  });

  it("leaves the Referer out when the page is not a web address", () => {
    const link = "https://t3.nhentai.net/c.jpg";
    const plain = `/api/cover?src=${encodeURIComponent(link)}`;
    expect(coverSrc(link, null)).toBe(plain);
    expect(coverSrc(link, undefined)).toBe(plain);
    expect(coverSrc(link, "")).toBe(plain);
    expect(coverSrc(link, "not a url")).toBe(plain);
    expect(coverSrc(link, "https://127.0.0.1/x")).toBe(plain);
    expect(coverSrc(link, "javascript:alert(1)")).toBe(plain);
  });

  it("accepts a cover on any CDN, whatever the title's site", () => {
    // No image-host allow-list any more: the proxy guards every fetch instead
    // (lib/cover-proxy.ts — public addresses only, image bytes only).
    for (const link of [
      "https://cdn.anything.example/c.webp",
      "https://i2.hentaifox.com/004/1/cover.jpg",
      "https://static.hentaicdn.com/hentai/cover/_S1.jpg",
      "http://t.nhentai.net/cover.jpg",
    ]) {
      expect(new URLSearchParams(coverSrc(link, "https://3hentai.net/d/1").split("?")[1]).get("src")).toBe(link);
    }
  });

  it("draws no cover for a link that is not a web address", () => {
    expect(coverSrc("")).toBe("");
    expect(coverSrc(null)).toBe("");
    expect(coverSrc(undefined)).toBe("");
    expect(coverSrc("data:image/png;base64,AAAA")).toBe("");
    expect(coverSrc("/galleries/1/cover.jpg")).toBe("");
    expect(coverSrc("javascript:alert(1)")).toBe("");
    expect(coverSrc("https://169.254.169.254/latest/meta-data")).toBe("");
    expect(coverSrc("https://t.nhentai.net:444/cover.jpg")).toBe("");
    expect(coverSrc("https://u:p@t.nhentai.net/cover.jpg")).toBe("");
    expect(coverSrc(`https://t.example/${"a".repeat(MAX_URL)}`)).toBe("");
    // ...even when the page itself is fine
    expect(coverSrc("data:image/png;base64,AAAA", "https://nhentai.net/g/1/")).toBe("");
  });
});
