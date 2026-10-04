import { describe, expect, it } from "vitest";
import { parseScrapePayload } from "../scrape-payload";
import { decodeEntities, isoDay, parseCount, prettyTitle, ScrapeError } from "./common";
import { parseGdata } from "./ehentai";
import { parseGalleryAdults } from "./galleryadults";
import { parseHentai2Read } from "./hentai2read";
import { parseGalleryInfo } from "./hitomi";
import { parsePururin } from "./pururin";

// Fixtures mirror each site's documented shape (the E-H wiki's gdata example,
// the galleryinfo fields gallery-dl and node-hitomi read, and the gallery
// markup the long-standing gallery-dl extractors parse). Every parse is also
// run through the write boundary, so a parser that emits something the app
// would refuse to store fails here first.
const names = (list: { name: string }[]) => list.map((e) => e.name);
const stored = <T,>(r: T) => {
  parseScrapePayload(r);
  return r;
};

describe("common helpers", () => {
  it("prettyTitle drops the bracketed lead and tail, and only that", () => {
    expect(prettyTitle("(C92) [Quill Rycm (Quill Tjgk)] Morning Ledger Fqkgbiq (Quill Rfns) [English] [penfubt]"))
      .toBe("Morning Ledger Fqkgbiq");
    expect(prettyTitle("[Quill Mfnd (PenDhei)] Morning Ledger Qgpafun {Scanlator}")).toBe("Morning Ledger Qgpafun");
    expect(prettyTitle("Plain Title")).toBe("Plain Title");
    expect(prettyTitle("Mid (bracket) title")).toBe("Mid (bracket) title");
    expect(prettyTitle("[Only Brackets]")).toBe("[Only Brackets]");
    expect(prettyTitle("x".repeat(300))).toHaveLength(255);
  });

  it("parseCount reads separators and K/M suffixes", () => {
    expect(parseCount("12,345")).toBe(12345);
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("")).toBe(0);
    expect(parseCount(undefined)).toBe(0);
  });

  it("isoDay keeps a literal date as written and reads prose dates", () => {
    expect(isoDay("2023-04-20 01:23:00-05")).toBe("2023-04-20");
    expect(isoDay("2019/1/3")).toBe("2019-01-03");
    expect(isoDay("April 20, 2023")).toBe("2023-04-20");
    expect(isoDay("6 years ago")).toBeNull();
    expect(isoDay("2023-02-30")).toBeNull();
    expect(isoDay(undefined)).toBeNull();
  });

  it("decodeEntities handles numeric and the common named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &#039;s &#x2606; &unknown;")).toBe("Tom & Jerry 's ☆ &unknown;");
  });
});

describe("E-Hentai (gdata API)", () => {
  const ID = "899557/edd545586a";
  const answer = (over: Record<string, unknown> = {}) => JSON.stringify({
    gmetadata: [{
      gid: 899557,
      token: "edd545586a",
      title: "(PenYtbs 8) [Pen&#9734;Qobq! (Quill Nqiv)] MORNING LEDGER HXWGKUI (Quill Oeby)",
      title_jpn: "(試作未酉甲辛8) [Pen☆Qobq! (試作巳卯天酉)] MORNING LEDGER HXWGKUI (試作子子申亥Samplekksvsye)",
      category: "Non-H",
      thumb: "https://ehgt.org/14/63/9e9bd72a4bf06399b41a382057355ef98e9c747f-9289419-9333-9745-jpg_l.jpg",
      uploader: "synthbmglhaw",
      posted: "1376143500",
      filecount: "20",
      expunged: false,
      tags: [
        "parody:quill oeby", "group:quill bcud", "artist:quill klwt",
        "character:quill bbld", "female:big breasts", "male:sole male", "other:full color",
        "language:english", "language:translated", "cosplay",
      ],
      ...over,
    }],
  });

  it("maps the namespaced tags onto the five entity kinds", () => {
    const r = stored(parseGdata(answer(), ID));
    expect(r.source).toBe("ehentai");
    expect(r.source_id).toBe(ID);
    expect(r.title_name).toBe("MORNING LEDGER HXWGKUI");
    expect(r.image_link).toMatch(/^https:\/\/ehgt\.org\//);
    expect(r.pages).toBe(20);
    expect(r.uploaded_at).toBe("2013-08-10");
    expect(names(r.parodies)).toEqual(["quill oeby"]);
    expect(names(r.groups)).toEqual(["quill bcud"]);
    expect(names(r.artists)).toEqual(["quill klwt"]);
    expect(names(r.characters)).toEqual(["quill bbld"]);
    // Namespaces fold into the shared vocabulary; language is not an entity.
    expect(names(r.tags)).toEqual(["big breasts", "sole male", "full color", "cosplay"]);
    expect(r.tags[0].link).toBe("https://e-hentai.org/tag/female:big+breasts");
    expect(r.tags[3].link).toBe("https://e-hentai.org/tag/cosplay");
  });

  it("reads a wrong token or an unknown gallery as not found", () => {
    const wrong = JSON.stringify({ gmetadata: [{ gid: 899557, error: "Key missing, or incorrect key provided." }] });
    expect(() => parseGdata(wrong, ID)).toThrow(/not found/);
    expect(() => parseGdata(answer({ token: "ffffffffff" }), ID)).toThrow(/not found/);
    expect(() => parseGdata("<html>", ID)).toThrow(ScrapeError);
  });

  it("drops a thumbnail from anywhere but E-Hentai's image hosts", () => {
    expect(parseGdata(answer({ thumb: "https://evil.example/x.jpg" }), ID).image_link).toBe("");
  });
});

describe("Hitomi (galleries/<id>.js)", () => {
  const HASH = "a".repeat(61) + "bcd";
  const script = (over: Record<string, unknown> = {}) => "var galleryinfo = " + JSON.stringify({
    id: "1234567",
    title: "Morning Ledger Qgpafun",
    japanese_title: "試作とになこ",
    type: "doujinshi",
    language: "english",
    date: "2023-04-20 01:23:00-05",
    artists: [{ artist: "pendhei", url: "/artist/pendhei-all.html" }],
    groups: [{ group: "quill mfnd", url: "/group/quill%20mfnd-all.html" }],
    parodys: [{ parody: "original", url: "/series/original-all.html" }],
    characters: null,
    tags: [
      { tag: "big breasts", female: "1", male: "", url: "/tag/female%3Abig%20breasts-all.html" },
      { tag: "sole male", female: "", male: "1", url: "/tag/male%3Asole%20male-all.html" },
      { tag: "full color", url: "/tag/full%20color-all.html" },
    ],
    files: [
      { hash: HASH, name: "01.jpg", width: 1280, height: 1810, hasavif: 1 },
      { hash: "b".repeat(64), name: "02.jpg", width: 1280, height: 1810, hasavif: 1 },
    ],
    ...over,
  });

  it("reads the gallery script", () => {
    const r = stored(parseGalleryInfo(script(), "1234567"));
    expect(r.title_name).toBe("Morning Ledger Qgpafun");
    expect(r.pages).toBe(2);
    expect(r.uploaded_at).toBe("2023-04-20");
    expect(r.image_link).toBe(`https://tn.gold-usergeneratedcontent.net/webpbigtn/d/bc/${HASH}.webp`);
    expect(names(r.artists)).toEqual(["pendhei"]);
    expect(r.artists[0].link).toBe("https://hitomi.la/artist/pendhei-all.html");
    expect(names(r.groups)).toEqual(["quill mfnd"]);
    expect(names(r.parodies)).toEqual(["original"]);
    expect(r.characters).toEqual([]);
    expect(names(r.tags)).toEqual(["big breasts", "sole male", "full color"]);
  });

  it("derives a site link when an entry has none", () => {
    const r = parseGalleryInfo(script({ tags: [{ tag: "big breasts", female: 1 }] }), "1234567");
    expect(r.tags[0].link).toBe("https://hitomi.la/tag/female%3Abig%20breasts-all.html");
  });

  it("refuses a script for another gallery, or none", () => {
    expect(() => parseGalleryInfo(script({ id: 7 }), "1234567")).toThrow(/not found/);
    expect(() => parseGalleryInfo("var galleryinfo = nope", "1234567")).toThrow(ScrapeError);
  });

  it("leaves the cover empty when the first file has no usable hash", () => {
    expect(parseGalleryInfo(script({ files: [{ hash: "../../x" }] }), "1234567").image_link).toBe("");
  });
});

describe("IMHentai / HentaiFox (gallery engine)", () => {
  const IMHENTAI = `<!doctype html><html><head>
    <meta property="og:image" content="https://m7.imhentai.xxx/021/abc/cover.jpg"></head><body>
    <div class="row gallery_first">
      <div class="col-md-4 col left_cover">
        <a href="/view/1234567/1/"><img class="lazy" data-src="https://m7.imhentai.xxx/021/abc/cover.jpg" src="/img/loading.gif"></a>
      </div>
      <div class="col-md-7 col-sm-7 col-lg-8 right_details">
        <h1>[Quill Mfnd (PenDhei)] Morning Ledger Qgpafun (Original) [English]</h1>
        <p class="subtitle">[試作けくとか (ためしちきとこ)] 試作とになこ</p>
        <ul class="galleries_info">
          <li><span class="tags_text">Parodies:</span> <a href="/parody/original/" class="tag">original <span class="badge">51234</span></a></li>
          <li><span class="tags_text">Characters:</span></li>
          <li><span class="tags_text">Tags:</span>
            <a href="/tag/big-breasts/" class="tag">big breasts <span class="badge">1.2K</span></a>
            <a href="/tag/sole-male/" class="tag">sole male <span class="badge">80,123</span></a></li>
          <li><span class="tags_text">Artists:</span> <a href="/artist/pendhei/" class="tag">pendhei <span class="badge">120</span></a></li>
          <li><span class="tags_text">Groups:</span> <a href="/group/quill-mfnd/" class="tag">quill mfnd <span class="badge">95</span></a></li>
          <li><span class="tags_text">Languages:</span> <a href="/language/english/" class="tag">english <span class="badge">9</span></a></li>
          <li><span class="tags_text">Category:</span> <a href="/category/doujinshi/" class="tag">doujinshi</a></li>
          <li class="pages">Pages: 24</li>
          <li class="posted">Posted: April 20, 2023</li>
        </ul>
      </div>
    </div>
    <div class="related"><h2>Popular tags</h2><a href="/tag/sidebar-tag/">sidebar tag</a></div>
  </body></html>`;

  const HENTAIFOX = `<!doctype html><html><body>
    <div class="gallery_top">
      <div class="cover"><img src="//i.hentaifox.com/004/1234567/cover.jpg"></div>
      <div class="info">
        <h1>Morning Ledger Qgpafun</h1>
        <ul class="parodies"><span class="tags_text">Parodies:</span>
          <li><a class="tag_btn" href="/parody/original/">original <span class="t_badge">51234</span></a></li></ul>
        <ul class="tags"><span class="tags_text">Tags:</span>
          <li><a class="tag_btn" href="https://hentaifox.com/tag/big-breasts/">Big Breasts <span class="t_badge">99,000</span></a></li>
          <li><a class="tag_btn" href="https://evil.example/tag/x/">smuggled <span class="t_badge">1</span></a></li></ul>
        <ul class="artists"><span class="tags_text">Artists:</span>
          <li><a class="tag_btn" href="/artist/pendhei/">pendhei <span class="t_badge">120</span></a></li></ul>
        <span class="i_text pages">Pages: 24</span>
      </div>
    </div>
  </body></html>`;

  it("reads an IMHentai gallery from the info box only", () => {
    const r = stored(parseGalleryAdults("imhentai", IMHENTAI, "1234567"));
    expect(r.title_name).toBe("Morning Ledger Qgpafun");
    expect(r.image_link).toBe("https://m7.imhentai.xxx/021/abc/cover.jpg");
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBe("2023-04-20");
    expect(names(r.parodies)).toEqual(["original"]);
    expect(names(r.tags)).toEqual(["big breasts", "sole male"]); // not the sidebar's
    expect(r.tags[0]).toEqual({ name: "big breasts", link: "https://imhentai.xxx/tag/big-breasts/", total_works: 1200 });
    expect(r.tags[1].total_works).toBe(80123);
    expect(names(r.artists)).toEqual(["pendhei"]);
    expect(names(r.groups)).toEqual(["quill mfnd"]);
    expect(r.characters).toEqual([]);
  });

  it("reads a HentaiFox gallery and keeps only its own links", () => {
    const r = stored(parseGalleryAdults("hentaifox", HENTAIFOX, "1234567"));
    expect(r.title_name).toBe("Morning Ledger Qgpafun");
    expect(r.image_link).toBe("https://i.hentaifox.com/004/1234567/cover.jpg");
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBeNull(); // the page has no date; none is invented
    expect(names(r.tags)).toEqual(["big breasts"]);
    expect(r.tags[0].total_works).toBe(99000);
    expect(names(r.artists)).toEqual(["pendhei"]);
  });

  it("refuses a page that is not a gallery", () => {
    const listing = `<html><body><h1>Latest galleries</h1>
      <div><a href="/gallery/1/">one</a><a href="/gallery/2/">two</a></div></body></html>`;
    expect(() => parseGalleryAdults("hentaifox", listing, "1")).toThrow(/not a gallery/);
    expect(() => parseGalleryAdults("hentaifox", "<html><body></body></html>", "1")).toThrow(/no title/);
  });
});

describe("Pururin", () => {
  const TABLE = `<!doctype html><html><head>
    <meta property="og:image" content="https://cdn.pururin.me/assets/images/data/88048/cover.jpg"></head><body>
    <div class="gallery-info">
      <h1><span itemprop="name">Morning Ledger Fqkgbiq / サンプルサケタス!!</span></h1>
      <table class="table table-gallery-info">
        <tr><td>Artist</td><td><a href="/tags/artist/123/quill-tjgk" title="Quill Tjgk">Quill Tjgk</a></td></tr>
        <tr><td>Circle</td><td><a href="/tags/circle/456/quill-rycm" title="Quill Rycm">Quill Rycm</a></td></tr>
        <tr><td>Parody</td><td><a href="/tags/parody/789/quill-rfns" title="Quill Rfns / 試作ししえと">Quill Rfns</a></td></tr>
        <tr><td>Character</td><td><a href="/tags/character/1/penvwur" title="PenVwur">PenVwur</a> <a href="/tags/character/2/penfmwx" title="PenFmwx">PenFmwx</a></td></tr>
        <tr><td>Contents</td><td><a href="/tags/content/3/big-breasts" title="Big Breasts">Big Breasts</a></td></tr>
        <tr><td>Category</td><td><a href="/tags/category/1/doujinshi" title="Doujinshi">Doujinshi</a></td></tr>
        <tr><td>Language</td><td><a href="/tags/language/1/english" title="English">English</a></td></tr>
        <tr><td>Pages</td><td>19 (12.3 MB)</td></tr>
        <tr><td>Uploaded</td><td><time datetime="2017-09-12T10:00:00+00:00">6 years ago</time></td></tr>
      </table>
    </div></body></html>`;

  it("reads the labeled table", () => {
    const r = stored(parsePururin(TABLE, "88048"));
    expect(r.title_name).toBe("Morning Ledger Fqkgbiq");
    expect(r.image_link).toBe("https://cdn.pururin.me/assets/images/data/88048/cover.jpg");
    expect(r.pages).toBe(19);
    expect(r.uploaded_at).toBe("2017-09-12");
    expect(names(r.artists)).toEqual(["quill tjgk"]);
    expect(r.artists[0].link).toBe("https://pururin.me/tags/artist/123/quill-tjgk");
    expect(names(r.groups)).toEqual(["quill rycm"]);
    expect(names(r.parodies)).toEqual(["quill rfns"]);
    expect(names(r.characters)).toEqual(["penvwur", "penfmwx"]);
    expect(names(r.tags)).toEqual(["big breasts"]); // not "doujinshi" (format) or "english"
  });

  it("reads rows that ship their values as JSON", () => {
    const html = `<html><body><h1><span itemprop="name">Title</span></h1>
      <input type="hidden" name="artist_tags" value="[{&quot;id&quot;:1,&quot;name&quot;:&quot;Quill Tjgk&quot;}]">
      <input type="hidden" name="contents_tags" value="[{&quot;name&quot;:&quot;Big Breasts&quot;}]">
      <input type="hidden" name="language_tags" value="[{&quot;name&quot;:&quot;English&quot;}]">
      <p>24 Pages</p></body></html>`;
    const r = stored(parsePururin(html, "1"));
    expect(names(r.artists)).toEqual(["quill tjgk"]);
    expect(r.artists[0].link).toBe("https://pururin.me/search?q=quill%20tjgk");
    expect(names(r.tags)).toEqual(["big breasts"]);
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBeNull();
  });

  it("refuses a page that is not a gallery", () => {
    expect(() => parsePururin("<html><body><p>404</p></body></html>", "1")).toThrow(/not a title page/);
    expect(() => parsePururin("<html><body><h1>Browse</h1></body></html>", "1")).toThrow(/not a gallery/);
  });
});

describe("Hentai2Read", () => {
  // Trimmed from the live page (hentai2read.com/morningledgerjoregra/, 2026-10): the
  // Book block is hidden and holds only the name, the rows live in a separate
  // info block, and every page's sidebar carries other titles' data-mid ids.
  const SIDEBAR = `<div class="block"><h3 class="block-title">Spotlight</h3>
      <a href="https://hentai2read.com/other_title/" data-mid="88001">
        <img class="img-avatar" src="https://img2.hentaicdn.com/hentai/cover/42/_S88001.jpg"></a></div>`;
  const PAGE = `<!doctype html><html><head>
    <meta property="og:image" content="https://hentaicdn.com/cdn/noImage.png"/></head><body>
    ${SIDEBAR}
    <div itemscope itemtype="http://schema.org/Book" class="hide">
      <span itemprop="name">Morning Ledger Mdznpjk</span>
      <div itemprop="aggregateRating" itemscope itemtype="http://schema.org/AggregateRating">
        <span itemprop="ratingValue">4</span></div>
    </div>
    <div class="col-xs-12 col-md-8">
      <div class="block-header bg-black bh-xs">
        <h3 class="block-title"><i class="fa fa-book"></i>
          <a href="https://hentai2read.com/morningledgerjoregra/">Morning Ledger Mdznpjk <small class="text-danger">[Doujinshi]</small></a></h3>
        <a href="#" class="js-addBookmark" data-mid="83739">Bookmark</a>
      </div>
      <div class="block-content row bg-white bc-xs">
        <div class="col-xs-12 col-sm-5"><picture>
          <source type="image/webp" srcset="https://img1.hentaicdn.com/hentai/cover/webp/_S83739.jpg.webp">
          <img class="img-responsive border-black-op" src="https://img1.hentaicdn.com/hentai/cover/_S83739.jpg" alt="Morning Ledger Mdznpjk">
        </picture></div>
        <div class="col-xs-12 col-sm-7">
          <ul class="list list-simple-mini">
            <li class="text-muted">Morning Ledger Mjnoorj<li>
            <li class="text-primary"><b>Parody</b>
              <a href="https://hentai2read.com/hentai-list/category/Quill%20Gckk%20dj./" class="tagButton">Quill Gckk dj.</a></li>
            <li class="text-primary"><b>Status</b>
              <a href="https://hentai2read.com/hentai-list/status/Completed/" class="tagButton">Completed</a></li>
            <li class="text-primary"><b>Release Year</b> <a href="javascript:void(0)" class="tagButton">-</a></li>
            <li class="text-primary"><b>Page</b> <a href="javascript:void(0)" class="tagButton">
                44 pages
              </a></li>
            <li class="text-primary"><b>Author</b>
              <a href="https://hentai2read.com/hentai-list/author/penjlvm/" class="tagButton">PenJlvm</a></li>
            <li class="text-primary"><b>Artist</b>
              <a href="https://hentai2read.com/hentai-list/artist/penjlvm/" class="tagButton">PenJlvm</a></li>
            <li class="text-primary"><b>Category</b>
              <a href="https://hentai2read.com/hentai-list/category/Adult/" class="tagButton">Adult</a><a href="https://hentai2read.com/hentai-list/category/Big%20Breasts/" class="tagButton">Big Breasts</a><a href="https://hentai2read.com/hentai-list/category/Doujinshi/" class="tagButton">Doujinshi</a><a href="https://hentai2read.com/hentai-list/category/Oneshot/" class="tagButton">Oneshot</a></li>
            <li class="text-primary"><b>Content</b>
              <a href="https://hentai2read.com/hentai-list/category/Creampie/" class="tagButton">Creampie</a><a href="https://hentai2read.com/hentai-list/category/X-Ray/" class="tagButton">X-Ray</a></li>
            <li class="text-primary"><b>Character</b> <a href="javascript:void(0)" class="tagButton">-</a></li>
            <li class="text-primary"><b>Language</b> <a href="javascript:void(0)" class="tagButton">English</a></li>
          </ul>
        </div>
      </div>
      <ul class="nav-chapters"><li><div class="chapter-row" data-cid="88299"></div>
        <a href="https://hentai2read.com/morningledgerjoregra/1/">1 - Morning Ledger Mdznpjk [Oneshot]
          <div class="text-muted"><small>uploaded by [Anonymous] about 10years ago</small></div></a></li></ul>
    </div></body></html>`;

  it("reads the info block beside the hidden Book block", () => {
    const r = stored(parseHentai2Read(PAGE, "morningledgerjoregra"));
    expect(r.title_name).toBe("Morning Ledger Mdznpjk");
    // The title's own cover, not a sidebar thumbnail or the og:image placeholder.
    expect(r.image_link).toBe("https://img1.hentaicdn.com/hentai/cover/_S83739.jpg");
    expect(r.pages).toBe(44);
    expect(names(r.parodies)).toEqual(["quill gckk"]);
    expect(r.parodies[0].link).toBe("https://hentai2read.com/hentai-list/category/Quill%20Gckk%20dj./");
    expect(names(r.artists)).toEqual(["penjlvm"]);
    // The rating and the publication format are not tags; the "-" placeholder is not a character.
    expect(names(r.tags)).toEqual(["big breasts", "creampie", "x-ray"]);
    expect(r.characters).toEqual([]);
    // "about 10 years ago" is not a day.
    expect(r.uploaded_at).toBeNull();
  });

  it("falls back to the info heading when the Book block is gone", () => {
    const page = PAGE.replace(/<div itemscope[\s\S]*?<\/div>\s*<\/div>/, "");
    expect(page).not.toContain("schema.org/Book");
    const r = parseHentai2Read(page, "morningledgerjoregra");
    expect(r.title_name).toBe("Morning Ledger Mdznpjk");
    expect(r.pages).toBe(44);
  });

  it("refuses a page without the title markup, sidebar ids notwithstanding", () => {
    const listing = `<html><body><h1>Latest</h1>${SIDEBAR}<a href="https://hentai2read.com/a_b/">A B</a></body></html>`;
    expect(() => parseHentai2Read(listing, "latest_stuff")).toThrow(/not a title page/);
  });
});
