import { describe, expect, it } from "vitest";
import { parseScrapePayload } from "../scrape-payload";
import { refFromUrl } from "../sources";
import { absoluteUrl, clip, decodeEntities, EntityBag, isoDay, isoDayFromUnix, parseCount, prettyTitle } from "./common";
import { concreteDay, readPage, type ExtractedTitle, type PageReading } from "./extract";

// readPage reads ANY gallery page from conventions, not per-site selectors.
// These pages are small and hand-written (or trimmed from the markup the old
// per-site adapters were built against — nhentai, the IMHentai/HentaiFox
// engine, Pururin, Hentai2Read, E-Hentai, Hitomi), each pinning one rule; the
// full-size pages live in the fixture corpus (corpus.test.ts).

const names = (list: { name: string }[]) => list.map((e) => e.name);

/** The page must read as a title — and one the write boundary would store. */
function gallery(html: string, url: string): ExtractedTitle {
  const reading = readPage(html, url);
  expect(reading.kind, JSON.stringify(reading).slice(0, 400)).toBe("gallery");
  const title = (reading as Extract<PageReading, { kind: "gallery" }>).title;
  const ref = refFromUrl(url)!;
  parseScrapePayload({ source: ref.source, source_id: ref.id, url: ref.url, ...title });
  return title;
}

/** The page must be refused; returns why. */
function refused(html: string, url: string): string {
  const reading = readPage(html, url);
  expect(reading.kind, JSON.stringify(reading).slice(0, 400)).toBe("none");
  return (reading as Extract<PageReading, { kind: "none" }>).reason;
}

/** The page must point elsewhere; returns where. */
function follows(html: string, url: string): { url: string; why: string } {
  const reading = readPage(html, url);
  expect(reading.kind, JSON.stringify(reading).slice(0, 400)).toBe("follow");
  return reading as Extract<PageReading, { kind: "follow" }>;
}

const SITE = "https://doujin-site.com";
const GALLERY = `${SITE}/gallery/12345/`;

/** A minimal info block: a heading, labeled rows, a page count. */
function page({ head = "", title = "Some Title", rows = "", cover = "", extra = "", pages = "<li>Pages: 24</li>" } = {}): string {
  return `<!doctype html><html><head>${head}</head><body>
    <div class="gallery-info">
      ${cover}
      <h1>${title}</h1>
      <ul class="info">${rows}${pages}</ul>
    </div>
    ${extra}
  </body></html>`;
}

// ---------------------------------------------------------------------------
// The helpers the reader is built on
// ---------------------------------------------------------------------------

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
    expect(parseCount("(168.2K)")).toBe(168_200);
    expect(parseCount("")).toBe(0);
    expect(parseCount(undefined)).toBe(0);
    expect(parseCount("99999999999")).toBe(0); // past an int4 column: unreadable, not clamped
  });

  it("isoDay keeps a literal date as written and reads prose dates", () => {
    expect(isoDay("2023-04-20 01:23:00-05")).toBe("2023-04-20");
    expect(isoDay("2019/1/3")).toBe("2019-01-03");
    expect(isoDay("April 20, 2023")).toBe("2023-04-20");
    expect(isoDay("6 years ago")).toBeNull();
    expect(isoDay("2023-02-30")).toBeNull();
    expect(isoDay("1969-12-31")).toBeNull();
    expect(isoDay(undefined)).toBeNull();
    expect(isoDayFromUnix("1376143500")).toBe("2013-08-10");
    expect(isoDayFromUnix(0)).toBeNull();
  });

  it("decodeEntities handles numeric and the common named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &#039;s &#x2606; &unknown;")).toBe("Tom & Jerry 's ☆ &unknown;");
  });

  it("absoluteUrl resolves hrefs to https and refuses other schemes", () => {
    expect(absoluteUrl("/tag/x/", GALLERY)).toBe(`${SITE}/tag/x/`);
    expect(absoluteUrl("//i.cdn.example/a.jpg", GALLERY)).toBe("https://i.cdn.example/a.jpg");
    expect(absoluteUrl("http://doujin-site.com/a", GALLERY)).toBe(`${SITE}/a`);
    expect(absoluteUrl("javascript:void(0)", GALLERY)).toBe("");
    expect(absoluteUrl(undefined, GALLERY)).toBe("");
  });

  it("clip never splits a surrogate pair", () => {
    expect(clip("a".repeat(254) + "😀")).toBe("a".repeat(254));
    expect(clip("short")).toBe("short");
  });

  it("EntityBag folds names, keeps one row per name, and drops an unstorable link", () => {
    const bag = new EntityBag();
    bag.add("tags", "Big  Breasts", `${SITE}/tag/big-breasts/`, 5);
    bag.add("tags", "big breasts", `${SITE}/tag/other/`);
    bag.add("artists", "big breasts", "");
    bag.add("tags", "long link", `${SITE}/${"x".repeat(300)}`);
    bag.add("tags", "   ", "");
    expect(bag.result().tags).toEqual([
      { name: "big breasts", link: `${SITE}/tag/big-breasts/`, total_works: 5 },
      { name: "long link", link: "", total_works: 0 },
    ]);
    expect(names(bag.result().artists)).toEqual(["big breasts"]);
    expect(bag.size).toBe(3);
  });
});

describe("concreteDay", () => {
  it("reads a calendar day only when the text names one", () => {
    expect(concreteDay("2013-08-10 13:25")).toBe("2013-08-10");
    expect(concreteDay("2016-10-18T12:28:49.216915+00:00")).toBe("2016-10-18");
    expect(concreteDay("Posted: April 1, 2020")).toBe("2020-04-01");
    expect(concreteDay("September 14th, 2024")).toBe("2024-09-14");
    expect(concreteDay("1 Apr 2020")).toBe("2020-04-01");
  });

  it("gives null for a year alone, a relative age or nothing — a day is never made up", () => {
    expect(concreteDay("Release Year: 2019")).toBeNull();
    expect(concreteDay("2019")).toBeNull();
    expect(concreteDay("3 days ago")).toBeNull();
    expect(concreteDay("uploaded by [Anonymous] about 10years ago")).toBeNull();
    expect(concreteDay("2 years, 6 months ago (2024-03-29)")).toBeNull();
    expect(concreteDay("not-a-date")).toBeNull();
    expect(concreteDay("")).toBeNull();
    expect(concreteDay(null)).toBeNull();
    expect(concreteDay(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nhentai's markup (#info, .tag-container rows, span.name + span.count)
// ---------------------------------------------------------------------------

// Mirrors the gallery markup the old nhentai adapter's selectors depended on.
// The generic reader has to get the same title out of it from conventions.
function nhentaiHtml({
  title = "PenXjbs",
  cover = `<img data-src="https://t.nhentai.net/galleries/811673/cover.jpg" src="lazy.gif">`,
  time = `<time datetime="2016-10-18T12:28:49.216915+00:00">6 years ago</time>`,
  pagesRow = `
    <div class="tag-container field-name">Pages:
      <span class="tags"><a class="tag" href="#"><span class="name">225</span></a></span>
    </div>`,
  artistsRow = `
    <div class="tag-container field-name">Artists:
      <span class="tags">
        <a class="tag" href="/artist/penqech/"><span class="name">penqech</span> <span class="count">79</span></a>
      </span>
    </div>`,
  groupsRow = `<div class="tag-container field-name">Groups:<span class="tags"></span></div>`,
  parodiesRow = `
    <div class="tag-container field-name">Parodies:
      <span class="tags">
        <a class="tag" href="/parody/original/"><span class="name">original</span> <span class="count">62,050</span></a>
      </span>
    </div>`,
} = {}): string {
  return `<!doctype html><html><body>
    <div id="cover"><a href="/g/177013/1/">${cover}</a></div>
    <div id="info">
      <h1 class="title"><span class="before">[PenNieb] </span><span class="pretty">${title}</span><span class="after"> [English]</span></h1>
      <section id="tags">
        ${parodiesRow}
        <div class="tag-container field-name">Characters:
          <span class="tags"></span>
        </div>
        <div class="tag-container field-name">Tags:
          <span class="tags">
            <a class="tag" href="/tag/ahegao/"><span class="name">ahegao</span> <span class="count">21,043</span></a>
            <a class="tag" href="/tag/dark-skin/"><span class="name">dark skin</span> <span class="count">18,022</span></a>
          </span>
        </div>
        ${artistsRow}
        ${groupsRow}
        ${pagesRow}
        <div class="tag-container field-name">Uploaded: ${time}</div>
      </section>
    </div>
  </body></html>`;
}
const NH = "https://nhentai.net/g/177013/";

describe("readPage: nhentai's markup", () => {
  it("parses a full gallery page", () => {
    const r = gallery(nhentaiHtml(), NH);
    expect(r.title_name).toBe("PenXjbs");
    expect(r.image_link).toBe("https://t.nhentai.net/galleries/811673/cover.jpg");
    expect(r.pages).toBe(225);
    expect(r.uploaded_at).toBe("2016-10-18");
    expect(names(r.tags)).toEqual(["ahegao", "dark skin"]);
    // Links are stored absolute, whatever the markup carried.
    expect(r.tags[0]).toEqual({ name: "ahegao", link: "https://nhentai.net/tag/ahegao/", total_works: 21043 });
    expect(r.artists).toEqual([{ name: "penqech", link: "https://nhentai.net/artist/penqech/", total_works: 79 }]);
    expect(r.groups).toEqual([]);
    expect(r.characters).toEqual([]);
    expect(names(r.parodies)).toEqual(["original"]);
  });

  it("keeps the bracketed lead and tail out of the title", () => {
    const r = gallery(nhentaiHtml(), NH);
    expect(r.title_name).not.toContain("PenNieb");
    expect(r.title_name).not.toContain("English");
  });

  it("prefers data-src on the cover but falls back to src", () => {
    const r = gallery(nhentaiHtml({ cover: `<img src="https://t.nhentai.net/x/cover.jpg">` }), NH);
    expect(r.image_link).toBe("https://t.nhentai.net/x/cover.jpg");
  });

  it("parses comma-grouped total_works counts", () => {
    expect(gallery(nhentaiHtml(), NH).parodies[0].total_works).toBe(62050);
  });

  it("makes every entity link absolute", () => {
    const r = gallery(nhentaiHtml(), NH);
    for (const e of [...r.tags, ...r.artists, ...r.parodies]) {
      expect(e.link.startsWith("https://nhentai.net/")).toBe(true);
    }
  });

  it("splits an aliased artist or group into separate credits, each keeping the combined page's link and count", () => {
    // nhentai keeps aliases of one credit on a single page: "pensgfi | pencbfj".
    // Since 9a links are not unique, so both halves keep the page they came from.
    const r = gallery(nhentaiHtml({
      artistsRow: `
        <div class="tag-container field-name">Artists:
          <span class="tags">
            <a class="tag" href="/artist/pensgfi-pencbfj/"><span class="name">pensgfi | pencbfj</span> <span class="count">8</span></a>
          </span>
        </div>`,
      groupsRow: `
        <div class="tag-container field-name">Groups:
          <span class="tags">
            <a class="tag" href="/group/quill-ihak-penqzoj/"><span class="name">quill ihak | penqzoj</span> <span class="count">3</span></a>
          </span>
        </div>`,
    }), NH);
    expect(r.artists).toEqual([
      { name: "pensgfi", link: "https://nhentai.net/artist/pensgfi-pencbfj/", total_works: 8 },
      { name: "pencbfj", link: "https://nhentai.net/artist/pensgfi-pencbfj/", total_works: 8 },
    ]);
    expect(r.groups).toEqual([
      { name: "quill ihak", link: "https://nhentai.net/group/quill-ihak-penqzoj/", total_works: 3 },
      { name: "penqzoj", link: "https://nhentai.net/group/quill-ihak-penqzoj/", total_works: 3 },
    ]);
  });

  it("splits a parody too — uniform rule, even though the halves are JP/EN of one work", () => {
    // Chosen deliberately (see migration 5): the schema stays uniform at the
    // cost of one franchise occupying two parody rows.
    const r = gallery(nhentaiHtml({
      parodiesRow: `
        <div class="tag-container field-name">Parodies:
          <span class="tags">
            <a class="tag" href="/parody/penvxcz-quill-cuoi/"><span class="name">penvxcz | quill cuoi</span> <span class="count">900</span></a>
          </span>
        </div>`,
    }), NH);
    expect(r.parodies).toEqual([
      { name: "penvxcz", link: "https://nhentai.net/parody/penvxcz-quill-cuoi/", total_works: 900 },
      { name: "quill cuoi", link: "https://nhentai.net/parody/penvxcz-quill-cuoi/", total_works: 900 },
    ]);
  });

  it("does not emit the same credit twice when a half is also listed on its own", () => {
    const r = gallery(nhentaiHtml({
      artistsRow: `
        <div class="tag-container field-name">Artists:
          <span class="tags">
            <a class="tag" href="/artist/pensgfi/"><span class="name">pensgfi</span> <span class="count">79</span></a>
            <a class="tag" href="/artist/pensgfi-pencbfj/"><span class="name">pensgfi | pencbfj</span> <span class="count">8</span></a>
          </span>
        </div>`,
    }), NH);
    expect(r.artists).toEqual([
      { name: "pensgfi", link: "https://nhentai.net/artist/pensgfi/", total_works: 79 },
      { name: "pencbfj", link: "https://nhentai.net/artist/pensgfi-pencbfj/", total_works: 8 },
    ]);
  });

  it("never reads a blank title: a page without one is refused, a bracket-only heading kept as written", () => {
    // A blank title upserted quietly would let a later rescrape --all overwrite
    // good rows — the reader must refuse instead.
    expect(refused("<div id='info'></div>", NH)).toMatch(/no title/);
    expect(refused("<html><body></body></html>", NH)).toMatch(/no title/);
    // The heading with its name gone still says something; prettyTitle keeps
    // a title that is nothing but brackets rather than emptying it.
    expect(gallery(nhentaiHtml({ title: "" }), NH).title_name).toBe("[PenNieb] [English]");
  });

  it("stores no date when the page has none, or only a relative or malformed one", () => {
    expect(gallery(nhentaiHtml({ time: "<time>6 years ago</time>" }), NH).uploaded_at).toBeNull();
    expect(gallery(nhentaiHtml({ time: `<time datetime="not-a-date">x</time>` }), NH).uploaded_at).toBeNull();
    expect(gallery(nhentaiHtml({ time: "" }), NH).uploaded_at).toBeNull();
  });

  it("parses zero pages when the Pages row is absent, not NaN — one reader link is not a count", () => {
    expect(gallery(nhentaiHtml({ pagesRow: "" }), NH).pages).toBe(0);
  });

  it("counts the reader links when no row states the page count", () => {
    const thumbs = Array.from({ length: 24 }, (_, i) =>
      `<a href="/g/177013/${i + 1}/"><img data-src="https://t.nhentai.net/galleries/811673/${i + 1}t.jpg"></a>`).join("");
    const html = nhentaiHtml({ pagesRow: "" }).replace("</body>", `<div id="thumbnail-container">${thumbs}</div></body>`);
    expect(gallery(html, NH).pages).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// The IMHentai / HentaiFox "gallery adults" engine
// ---------------------------------------------------------------------------

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

describe("readPage: the IMHentai / HentaiFox engine", () => {
  it("reads an IMHentai gallery from the info box only", () => {
    const r = gallery(IMHENTAI, "https://imhentai.xxx/gallery/1234567/");
    expect(r.title_name).toBe("Morning Ledger Qgpafun");
    expect(r.image_link).toBe("https://m7.imhentai.xxx/021/abc/cover.jpg");
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBe("2023-04-20");
    expect(names(r.parodies)).toEqual(["original"]);
    expect(names(r.tags)).toEqual(["big breasts", "sole male"]); // not the sidebar's, not the language or category
    expect(r.tags[0]).toEqual({ name: "big breasts", link: "https://imhentai.xxx/tag/big-breasts/", total_works: 1200 });
    expect(r.tags[1].total_works).toBe(80123);
    expect(names(r.artists)).toEqual(["pendhei"]);
    expect(names(r.groups)).toEqual(["quill mfnd"]);
    expect(r.characters).toEqual([]);
  });

  it("reads a HentaiFox gallery and keeps only its own site's links", () => {
    const r = gallery(HENTAIFOX, "https://hentaifox.com/gallery/1234567/");
    expect(r.title_name).toBe("Morning Ledger Qgpafun");
    expect(r.image_link).toBe("https://i.hentaifox.com/004/1234567/cover.jpg"); // protocol-relative → https
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBeNull(); // the page has no date; none is invented
    expect(names(r.tags)).toEqual(["big breasts"]); // the off-site link is not an entity
    expect(r.tags[0].total_works).toBe(99000);
    expect(names(r.artists)).toEqual(["pendhei"]);
  });

  it("refuses a page that is not a gallery", () => {
    const listing = `<html><body><h1>Latest galleries</h1>
      <div><a href="/gallery/1/">one</a><a href="/gallery/2/">two</a></div></body></html>`;
    expect(refused(listing, "https://hentaifox.com/gallery/1/")).toMatch(/not a title/);
    expect(refused("<html><body></body></html>", "https://hentaifox.com/gallery/1/")).toMatch(/no title/);
  });
});

// ---------------------------------------------------------------------------
// Pururin (a labeled table, bilingual names)
// ---------------------------------------------------------------------------

const PURURIN = `<!doctype html><html><head>
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

describe("readPage: Pururin's labeled table", () => {
  const URL = "https://pururin.me/gallery/88048/morningledgerpvwanrb-2";

  it("reads the rows by their first cell", () => {
    const r = gallery(PURURIN, URL);
    expect(r.title_name).toBe("Morning Ledger Fqkgbiq"); // the English half of "English / 日本語"
    expect(r.image_link).toBe("https://cdn.pururin.me/assets/images/data/88048/cover.jpg");
    expect(r.pages).toBe(19); // not the file size
    expect(r.uploaded_at).toBe("2017-09-12");
    expect(names(r.artists)).toEqual(["quill tjgk"]);
    expect(r.artists[0].link).toBe("https://pururin.me/tags/artist/123/quill-tjgk");
    expect(names(r.groups)).toEqual(["quill rycm"]);
    expect(names(r.parodies)).toEqual(["quill rfns"]);
    expect(names(r.characters)).toEqual(["penvwur", "penfmwx"]);
    expect(names(r.tags)).toEqual(["big breasts"]); // not "doujinshi" (format) or "english" (language)
  });

  it("reads an inline page count from a page that shows no rows", () => {
    // The old adapter read Pururin's hidden JSON inputs; the generic reader
    // reads what the page shows — here the heading and "24 Pages".
    const html = `<html><body><h1><span itemprop="name">Title</span></h1>
      <input type="hidden" name="artist_tags" value="[{&quot;id&quot;:1,&quot;name&quot;:&quot;Quill Tjgk&quot;}]">
      <p>24 Pages</p></body></html>`;
    const r = gallery(html, "https://pururin.me/gallery/1/x");
    expect(r.title_name).toBe("Title");
    expect(r.pages).toBe(24);
    expect(r.uploaded_at).toBeNull();
  });

  it("refuses a page that is not a gallery", () => {
    expect(refused("<html><body><p>404</p></body></html>", "https://pururin.me/gallery/1/x")).toMatch(/no title/);
    expect(refused("<html><body><h1>Browse</h1></body></html>", "https://pururin.me/gallery/1/x")).toMatch(/not a title/);
  });
});

// ---------------------------------------------------------------------------
// Hentai2Read (hidden schema.org name, rows beside it, a busy sidebar)
// ---------------------------------------------------------------------------

// Trimmed from the live page (hentai2read.com/morningledgerjoregra/, 2026-10): the Book
// block is hidden and holds only the name, the rows live in a separate info
// block, and every page's sidebar carries other titles' covers and ids.
const H2R_SIDEBAR = `<div class="block"><h3 class="block-title">Spotlight</h3>
    <a href="https://hentai2read.com/other_title/" data-mid="88001">
      <img class="img-avatar" src="https://img2.hentaicdn.com/hentai/cover/42/_S88001.jpg"></a></div>`;
const H2R = `<!doctype html><html><head>
  <meta property="og:image" content="https://hentaicdn.com/cdn/noImage.png"/></head><body>
  ${H2R_SIDEBAR}
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

describe("readPage: Hentai2Read's split layout", () => {
  const URL = "https://hentai2read.com/morningledgerjoregra/";

  it("reads the info block beside the hidden Book block", () => {
    const r = gallery(H2R, URL);
    expect(r.title_name).toBe("Morning Ledger Mdznpjk");
    // Neither a sidebar thumbnail nor the og:image placeholder is the cover.
    expect(r.image_link).not.toMatch(/_S88001|noImage/);
    expect(r.pages).toBe(44);
    // "Quill Gckk dj." is the series.
    expect(names(r.parodies)).toEqual(["quill gckk"]);
    expect(r.parodies[0].link).toBe("https://hentai2read.com/hentai-list/category/Quill%20Gckk%20dj./");
    expect(names(r.artists)).toEqual(["penjlvm"]);
    // The rating, the status and the publication format are not tags; the "-"
    // placeholder is not a character.
    expect(names(r.tags)).toEqual(["big breasts", "creampie", "x-ray"]);
    expect(r.characters).toEqual([]);
    // "about 10 years ago" is not a day.
    expect(r.uploaded_at).toBeNull();
  });

  // The old adapter's expectation, kept: the cover is the <picture> in the
  // column beside the info list (the parent's sibling) — a re-scrape of a saved
  // Hentai2Read title must not overwrite its cover with "".
  it("finds the cover in the column beside the info block", () => {
    expect(gallery(H2R, URL).image_link).toBe("https://img1.hentaicdn.com/hentai/cover/_S83739.jpg");
  });

  it("takes the title from the document's <title> when the Book block is gone", () => {
    const html = H2R.replace(/<div itemscope[\s\S]*?<\/div>\s*<\/div>/, "")
      .replace("<head>", "<head><title>Morning Ledger Mdznpjk - Hentai2Read</title>");
    expect(html).not.toContain("schema.org/Book");
    const r = gallery(html, URL);
    expect(r.title_name).toBe("Morning Ledger Mdznpjk");
    expect(r.pages).toBe(44);
  });

  it("refuses a page without the title markup, sidebar ids notwithstanding", () => {
    const listing = `<html><body><h1>Latest</h1>${H2R_SIDEBAR}<a href="https://hentai2read.com/a_b/">A B</a></body></html>`;
    expect(refused(listing, "https://hentai2read.com/latest_stuff/")).toMatch(/not a title/);
  });
});

// ---------------------------------------------------------------------------
// E-Hentai (namespaced #taglist, CSS-background cover) and Hitomi (rendered)
// ---------------------------------------------------------------------------

describe("readPage: namespaced tag tables", () => {
  const EH = `<!doctype html><html><head><title>MORNING LEDGER HXWGKUI - E-Hentai Galleries</title></head><body>
    <div class="gm">
      <div id="gleft"><div id="gd1"><div style="width:250px; height:354px; background:transparent url(https://ehgt.org/14/63/9e9bd72a-jpg_l.jpg) no-repeat"></div></div></div>
      <div id="gd2">
        <h1 id="gn">(PenYtbs 8) [Pen&#9734;Qobq! (Quill Nqiv)] MORNING LEDGER HXWGKUI (Quill Oeby) [English]</h1>
        <h1 id="gj">(試作未酉甲辛8) [Pen☆Qobq! (試作巳卯天酉)] MORNING LEDGER HXWGKUI (試作子子申亥Samplekksvsye)</h1>
      </div>
      <div id="gmid">
        <div id="gdd"><table>
          <tr><td class="gdt1">Posted:</td><td class="gdt2">2013-08-10 13:25</td></tr>
          <tr><td class="gdt1">Language:</td><td class="gdt2">English &nbsp;<span class="halp">TR</span></td></tr>
          <tr><td class="gdt1">Length:</td><td class="gdt2">20 pages</td></tr>
        </table></div>
        <div id="taglist"><table>
          <tr><td class="tc">language:</td><td><div class="gt"><a href="https://e-hentai.org/tag/language:english">english</a></div>
            <div class="gt"><a href="https://e-hentai.org/tag/language:translated">translated</a></div></td></tr>
          <tr><td class="tc">parody:</td><td><div class="gt"><a href="https://e-hentai.org/tag/parody:quill+oeby">quill oeby</a></div></td></tr>
          <tr><td class="tc">character:</td><td><div class="gt"><a href="https://e-hentai.org/tag/character:quill+bbld">quill bbld</a></div></td></tr>
          <tr><td class="tc">group:</td><td><div class="gt"><a href="https://e-hentai.org/tag/group:quill+bcud">quill bcud</a></div></td></tr>
          <tr><td class="tc">artist:</td><td><div class="gt"><a href="https://e-hentai.org/tag/artist:quill+klwt">quill klwt</a></div></td></tr>
          <tr><td class="tc">female:</td><td><div class="gt"><a href="https://e-hentai.org/tag/female:big+breasts">big breasts</a></div></td></tr>
          <tr><td class="tc">male:</td><td><div class="gt"><a href="https://e-hentai.org/tag/male:sole+male">sole male</a></div></td></tr>
          <tr><td class="tc">other:</td><td><div class="gt"><a href="https://e-hentai.org/tag/other:full+color">full color</a></div></td></tr>
          <tr><td class="tc">misc:</td><td><div class="gt"><a href="https://e-hentai.org/tag/cosplay">cosplay</a></div></td></tr>
        </table></div>
      </div>
    </div></body></html>`;

  it("maps E-Hentai's namespaced rows onto the five entity kinds", () => {
    const r = gallery(EH, "https://e-hentai.org/g/899557/edd545586a/");
    expect(r.title_name).toBe("MORNING LEDGER HXWGKUI");
    expect(r.image_link).toBe("https://ehgt.org/14/63/9e9bd72a-jpg_l.jpg"); // the CSS background of #gd1
    expect(r.pages).toBe(20);
    expect(r.uploaded_at).toBe("2013-08-10");
    expect(names(r.parodies)).toEqual(["quill oeby"]);
    expect(names(r.groups)).toEqual(["quill bcud"]);
    expect(names(r.artists)).toEqual(["quill klwt"]);
    expect(names(r.characters)).toEqual(["quill bbld"]);
    // Namespaces fold into the shared vocabulary; language is not an entity;
    // a format word outside a Category row ("cosplay" as a misc tag) is a tag.
    expect(names(r.tags)).toEqual(["big breasts", "sole male", "full color", "cosplay"]);
    expect(r.tags[0].link).toBe("https://e-hentai.org/tag/female:big+breasts");
    expect(r.tags[3].link).toBe("https://e-hentai.org/tag/cosplay");
  });

  it("reads Hitomi's rendered page: first-cell labels, ♀/♂ flags, namespace only in the path", () => {
    const html = `<!doctype html><html><head><title>Morning Ledger Qgpafun by pendhei - Read Online - hentai doujinshi | Hitomi.la</title></head><body>
      <div class="content">
        <div class="cover-column">
          <h1><a href="/reader/1234567.html">Read Online</a></h1>
          <h1><a href="#">Download</a></h1>
          <div class="cover"><a href="/reader/1234567.html"><picture>
            <source type="image/avif" srcset="//tn.gold-usergeneratedcontent.net/avifbigtn/d/bc/abc.avif">
            <img src="//tn.gold-usergeneratedcontent.net/webpbigtn/d/bc/abc.webp"></picture></a></div>
        </div>
        <div class="gallery dj-gallery">
          <h1 id="gallery-brand"><a href="/reader/1234567.html">Morning Ledger Qgpafun</a></h1>
          <h2 id="artists"><ul class="comma-list"><li><a href="/artist/pendhei-all.html">pendhei</a></li></ul></h2>
          <div class="gallery-info"><table>
            <tr><td>Group</td><td><ul class="comma-list"><li><a href="/group/quill%20mfnd-all.html">quill mfnd</a></li></ul></td></tr>
            <tr><td>Type</td><td><a href="/type/doujinshi-all-1.html">doujinshi</a></td></tr>
            <tr><td>Language</td><td><a href="/index-english.html">English</a></td></tr>
            <tr><td>Series</td><td><ul><li><a href="/series/original-all.html">original</a></li></ul></td></tr>
            <tr><td>Characters</td><td></td></tr>
            <tr><td>Tags</td><td><ul class="tags">
              <li><a href="/tag/female%3Abig%20breasts-all.html">big breasts ♀</a></li>
              <li><a href="/tag/male%3Asole%20male-all.html">sole male ♂</a></li>
              <li><a href="/tag/full%20color-all.html">full color</a></li></ul></td></tr>
          </table></div>
          <span class="date">2023-04-20 01:23:00-05</span>
        </div>
      </div></body></html>`;
    const r = gallery(html, "https://hitomi.la/galleries/1234567.html");
    expect(r.title_name).toBe("Morning Ledger Qgpafun"); // not the "Read Online" / "Download" buttons
    expect(r.image_link).toBe("https://tn.gold-usergeneratedcontent.net/webpbigtn/d/bc/abc.webp");
    expect(r.uploaded_at).toBe("2023-04-20");
    expect(names(r.artists)).toEqual(["pendhei"]);
    expect(r.artists[0].link).toBe("https://hitomi.la/artist/pendhei-all.html");
    expect(names(r.groups)).toEqual(["quill mfnd"]);
    expect(names(r.parodies)).toEqual(["original"]);
    expect(r.characters).toEqual([]);
    expect(names(r.tags)).toEqual(["big breasts", "sole male", "full color"]);
  });
});

// ---------------------------------------------------------------------------
// The rules, one at a time
// ---------------------------------------------------------------------------

describe("readPage: choosing the title's heading", () => {
  it("skips a logo heading — the site's name, or a link home", () => {
    const html = `<html><head><title>Real Title - Doujin Site</title></head><body>
      <header><h1 class="site-title"><a href="/">Doujin Site</a></h1></header>
      <div class="brand"><h1><a href="https://doujin-site.com/">DS</a></h1></div>
      ${page({ title: "Real Title", rows: `<li>Tags: <a href="/tag/x/">x</a></li>` })}</body></html>`;
    expect(gallery(html, GALLERY).title_name).toBe("Real Title");
  });

  it("skips headings that are buttons", () => {
    const html = page({ title: "Real Title", rows: `<li>Tags: <a href="/tag/x/">x</a></li>` })
      .replace('<div class="gallery-info">', '<div class="gallery-info"><h1>Read Online</h1><h1>Download</h1>');
    expect(gallery(html, GALLERY).title_name).toBe("Real Title");
  });

  it("takes the heading the document's <title> names when there are several", () => {
    const html = `<html><head><title>The Real Title | Doujin Site</title></head><body>
      <div class="box"><h1>Featured: Something Else Entirely</h1></div>
      ${page({ title: "The Real Title", rows: `<li>Artists: <a href="/artist/a/">a</a></li>` })}</body></html>`;
    expect(gallery(html, GALLERY).title_name).toBe("The Real Title");
  });

  it("falls back to og:title / <title> without the site's name when the page has no heading", () => {
    const html = `<html><head><meta property="og:site_name" content="Doujin Site">
      <title>Doujin Site - My Title</title></head><body>
      <div class="info"><ul><li>Artists: <a href="/artist/a/">a</a></li><li>Pages: 12</li></ul></div></body></html>`;
    expect(gallery(html, GALLERY).title_name).toBe("My Title");
  });

  it("does not split a title that itself contains ' | '", () => {
    const html = page({ head: "<title>Morning Ledger Tjvuqpa | Morning Ledger Uwupfcb - Doujin Site</title>",
      title: "Morning Ledger Tjvuqpa | Morning Ledger Uwupfcb", rows: `<li>Tags: <a href="/tag/x/">x</a></li>` });
    expect(gallery(html, GALLERY).title_name).toBe("Morning Ledger Tjvuqpa | Morning Ledger Uwupfcb");
  });
});

describe("readPage: what a link is", () => {
  const read = (rows: string) => gallery(page({ rows }), GALLERY);

  it("a namespace in the link text outranks the row's label", () => {
    const r = read(`<li>Tags: <a href="/tag/a/">artist:foo bar</a> <a href="/tag/b/">female:big breasts</a></li>`);
    expect(names(r.artists)).toEqual(["foo bar"]);
    expect(names(r.tags)).toEqual(["big breasts"]);
  });

  it("a namespace in the path's value outranks the row's label", () => {
    const r = read(`<li>Tags: <a href="/tag/parody:quill+oeby">quill oeby</a> <a href="/tag/x/">x</a></li>`);
    expect(names(r.parodies)).toEqual(["quill oeby"]);
    expect(names(r.tags)).toEqual(["x"]);
  });

  it("the row's label outranks the path's words", () => {
    // A site that files every entity under /tag/ still labels its rows.
    const r = read(`<li>Artists: <a href="/tag/penqech/">penqech</a></li><li>Series: <a href="/tag/original/">original</a></li>`);
    expect(names(r.artists)).toEqual(["penqech"]);
    expect(names(r.parodies)).toEqual(["original"]);
    expect(r.tags).toEqual([]);
  });

  it("the path's words decide when nothing else says", () => {
    const r = read(`<li><a href="/artist/foo/">foo</a> <a href="/circle/bar/">bar</a> <a href="/character/baz/">baz</a>
      <a href="/series/qux/">qux</a> <a href="/tag/quux/">quux</a></li>`);
    expect(names(r.artists)).toEqual(["foo"]);
    expect(names(r.groups)).toEqual(["bar"]);
    expect(names(r.characters)).toEqual(["baz"]);
    expect(names(r.parodies)).toEqual(["qux"]);
    expect(names(r.tags)).toEqual(["quux"]);
  });

  it("a label that says 'skip' outranks a path that says 'tag' — languages are not entities", () => {
    const r = read(`<li>Languages: <a href="/tag/english/">english</a> <a href="/tag/translated/">translated</a></li>
      <li>Tags: <a href="/tag/x/">x</a> <a href="/tag/language:japanese">japanese</a></li>`);
    expect(names(r.tags)).toEqual(["x"]);
  });

  it("strips count badges and reads them as total_works", () => {
    const r = read(`<li>Tags:
      <a href="/tag/a/">big breasts <span class="count">21,043</span></a>
      <a href="/tag/b/"><span class="item_name">sole male</span><span class="item_count">6.1K</span></a>
      <a href="/tag/c/">nakadashi <span class="tag-count">(168.2K)</span></a>
      <a href="/tag/d/">paizuri <sup>(98,321)</sup></a>
      <a href="/tag/e/">glasses <em>712</em></a>
      <a href="/tag/f/">level 5</a></li>`);
    expect(r.tags).toEqual([
      { name: "big breasts", link: `${SITE}/tag/a/`, total_works: 21043 },
      { name: "sole male", link: `${SITE}/tag/b/`, total_works: 6100 },
      { name: "nakadashi", link: `${SITE}/tag/c/`, total_works: 168_200 },
      { name: "paizuri", link: `${SITE}/tag/d/`, total_works: 98321 },
      // Any element of its own that holds only a count is a badge.
      { name: "glasses", link: `${SITE}/tag/e/`, total_works: 712 },
      // A bare number in the text is part of the name.
      { name: "level 5", link: `${SITE}/tag/f/`, total_works: 0 },
    ]);
  });

  // The count written into the link's own text, not a badge element:
  // parenthesised, or with a separator or K/M — never cut inside the number.
  it("strips a count written into the link's own text", () => {
    const r = read(`<li>Tags:
      <a href="/tag/a/">nakadashi (1.2K)</a>
      <a href="/tag/b/">paizuri 12,345</a>
      <a href="/tag/c/">sole male (712)</a></li>`);
    expect(r.tags).toEqual([
      { name: "nakadashi", link: `${SITE}/tag/a/`, total_works: 1200 },
      { name: "paizuri", link: `${SITE}/tag/b/`, total_works: 12345 },
      { name: "sole male", link: `${SITE}/tag/c/`, total_works: 712 },
    ]);
  });

  it("splits ' | ' aliases, keeps the first of a bilingual ' / ' name, and leaves a slash inside a name alone", () => {
    const r = read(`<li>Artists: <a href="/artist/a/">pensgfi | pencbfj</a></li>
      <li>Parodies: <a href="/parody/quill-ninc/">Quill Ninc / サンプルハオイサ/サンプルハオイサ</a></li>
      <li>Characters: <a href="/character/m/">Quill Drct / サンプルチキハオ</a></li>`);
    expect(names(r.artists)).toEqual(["pensgfi", "pencbfj"]);
    expect(names(r.parodies)).toEqual(["quill ninc"]);
    expect(names(r.characters)).toEqual(["quill drct"]);
  });

  it("strips a parody's ' dj.' / ' doujinshi' suffix", () => {
    const r = read(`<li>Parody: <a href="/parody/is/">Quill Gckk dj.</a> <a href="/parody/th/">Quill Oeby Doujinshi</a></li>
      <li>Tags: <a href="/tag/dj/">dj</a></li>`);
    expect(names(r.parodies)).toEqual(["quill gckk", "quill oeby"]);
    expect(names(r.tags)).toEqual(["dj"]);
  });

  it("drops format words from a Category row and keeps its genres as tags", () => {
    const r = read(`<li>Category: <a href="/category/adult/">Adult</a> <a href="/category/big-breasts/">Big Breasts</a>
      <a href="/category/doujinshi/">Doujinshi</a> <a href="/category/oneshot/">Oneshot</a> <a href="/category/artist-cg/">Artist CG</a></li>
      <li>Type: <a href="/type/manga/">Manga</a></li>`);
    expect(names(r.tags)).toEqual(["big breasts"]);
  });

  it("drops ♀/♂ flags and placeholder values", () => {
    const r = read(`<li>Tags: <a href="/tag/female:big breasts/">big breasts ♀</a> <a href="/tag/x/">-</a> <a href="/tag/y/">N/A</a></li>
      <li>Characters: <a href="javascript:void(0)">-</a></li>`);
    expect(names(r.tags)).toEqual(["big breasts"]);
    expect(r.characters).toEqual([]);
  });

  it("keeps an entity whose link cannot be stored, without the link", () => {
    const r = read(`<li>Tags: <a href="javascript:void(0)">no link</a> <a href="/tag/${"x".repeat(300)}/">long link</a></li>`);
    expect(r.tags).toEqual([
      { name: "no link", link: "", total_works: 0 },
      { name: "long link", link: "", total_works: 0 },
    ]);
  });

  it("does not take the title's own name as an entity", () => {
    const html = page({ title: "Original", rows: `<li><a href="/parody/original/">Original</a> <a href="/tag/x/">x</a></li>` });
    const r = gallery(html, GALLERY);
    expect(r.parodies).toEqual([]);
    expect(names(r.tags)).toEqual(["x"]);
  });
});

describe("readPage: noise", () => {
  it("never reads sidebars, related galleries, comments, menus or footers", () => {
    const extra = `
      <nav><a href="/tag/nav-tag/">nav tag</a><a href="/artist/nav-artist/">nav artist</a></nav>
      <aside><a href="/tag/aside-tag/">aside tag</a></aside>
      <div class="sidebar"><h3>Popular tags</h3><a href="/tag/sidebar-tag/">sidebar tag</a></div>
      <div id="related"><div class="gallery"><a href="/gallery/2/"><img src="https://cdn.doujin-site.com/2/cover.jpg"></a>
        <a href="/artist/other-artist/">other artist</a><a href="/parody/other-parody/">other parody</a></div></div>
      <div class="more-like-this"><a href="/character/other-character/">other character</a></div>
      <div id="comments"><div class="comment"><p>Tags: <a href="/tag/netorare/">netorare</a></p>
        <p>Artist: <a href="/artist/commenter-pick/">commenter pick</a></p>
        <time datetime="2025-01-01T00:00:00Z">later</time></div></div>
      <footer><a href="/tag/footer-tag/">footer tag</a></footer>`;
    const r = gallery(page({ rows: `<li>Tags: <a href="/tag/real/">real</a></li>`, extra }), GALLERY);
    expect(names(r.tags)).toEqual(["real"]);
    expect(r.artists).toEqual([]);
    expect(r.parodies).toEqual([]);
    expect(r.characters).toEqual([]);
    expect(r.uploaded_at).toBeNull(); // the comment's <time> is not the upload date
  });

  it("does not take another title's cover from a related block", () => {
    const extra = `<div class="related"><a href="/gallery/2/"><div class="cover"><img src="https://cdn.doujin-site.com/2/cover.jpg"></div></a></div>`;
    const r = gallery(page({ rows: `<li>Tags: <a href="/tag/real/">real</a></li>`, extra }), GALLERY);
    expect(r.image_link).toBe("");
  });
});

describe("readPage: the cover", () => {
  const withCover = (cover: string, head = "") =>
    gallery(page({ head, cover, rows: `<li>Tags: <a href="/tag/x/">x</a></li>` }), GALLERY).image_link;

  it("reads a lazy loader's real address over its placeholder", () => {
    expect(withCover(`<div class="cover"><img class="lazy" src="/img/loading.gif" data-src="https://cdn.doujin-site.com/1/cover.jpg"></div>`))
      .toBe("https://cdn.doujin-site.com/1/cover.jpg");
    expect(withCover(`<div id="cover"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-lazy-src="//cdn.doujin-site.com/1/c.jpg"></div>`))
      .toBe("https://cdn.doujin-site.com/1/c.jpg");
    expect(withCover(`<div class="cover"><img src="/blank.gif" data-srcset="https://cdn.doujin-site.com/1/s.jpg 300w, https://cdn.doujin-site.com/1/l.jpg 900w"></div>`))
      .toBe("https://cdn.doujin-site.com/1/l.jpg");
  });

  it("reads a <picture>'s <source> only when the <img> has nothing", () => {
    expect(withCover(`<div class="cover"><picture><source srcset="https://cdn.doujin-site.com/1/c.avif">
      <img src="https://cdn.doujin-site.com/1/c.jpg"></picture></div>`)).toBe("https://cdn.doujin-site.com/1/c.jpg");
    expect(withCover(`<div class="cover"><picture><source srcset="https://cdn.doujin-site.com/1/c.webp 1x, https://cdn.doujin-site.com/1/c2.webp 2x">
      <img src="/img/loading.gif"></picture></div>`)).toBe("https://cdn.doujin-site.com/1/c2.webp");
  });

  it("reads a CSS background cover", () => {
    expect(withCover(`<div class="cover" style="background-image: url('https://cdn.doujin-site.com/1/bg.jpg')"></div>`))
      .toBe("https://cdn.doujin-site.com/1/bg.jpg");
    // Unmarked, but sized like a cover.
    expect(withCover(`<div style="width:250px;height:354px;background:url(//cdn.doujin-site.com/1/bg2.jpg) no-repeat"></div>`))
      .toBe("https://cdn.doujin-site.com/1/bg2.jpg");
  });

  it("falls back to og:image, but not to a placeholder or logo", () => {
    expect(withCover("", `<meta property="og:image" content="https://cdn.doujin-site.com/1/og.jpg">`))
      .toBe("https://cdn.doujin-site.com/1/og.jpg");
    expect(withCover("", `<meta property="og:image" content="https://cdn.doujin-site.com/noImage.png">`)).toBe("");
    expect(withCover("", `<meta property="og:image" content="https://cdn.doujin-site.com/img/logo.png">`)).toBe("");
  });

  it("accepts a cover on any CDN", () => {
    // No image-host allow-list: the cover proxy's address checks are the gate.
    expect(withCover(`<div class="cover"><img src="https://images.some-other-cdn.net/a/b/c.webp"></div>`))
      .toBe("https://images.some-other-cdn.net/a/b/c.webp");
  });

  it("rejects a cover that is not a web address", () => {
    expect(withCover(`<div class="cover"><img src="data:image/png;base64,iVBORw0KGgo="></div>`)).toBe("");
    expect(withCover(`<div class="cover"><img src="javascript:alert(1)"></div>`)).toBe("");
    expect(withCover(`<div class="cover"><img src="https://169.254.169.254/latest/cover.jpg"></div>`)).toBe("");
    expect(withCover(`<div class="cover"><img src="https://cdn.doujin-site.com:8443/c.jpg"></div>`)).toBe("");
    expect(withCover(`<div class="cover"><img src="https://user:pw@cdn.doujin-site.com/c.jpg"></div>`)).toBe("");
  });
});

describe("readPage: the page count and the date", () => {
  const read = (rows: string, extra = "", head = "") => gallery(page({ head, rows, pages: "", extra }), GALLERY);
  // An artist credit is enough to make the page a title on its own, so each
  // case below varies only the count or the date.
  const TAG = `<li>Artists: <a href="/artist/x/">x</a></li>`;

  it("reads labeled rows in their usual shapes", () => {
    expect(read(`${TAG}<li>Pages: 24</li>`).pages).toBe(24);
    expect(read(`${TAG}<li>Length: 46 pages</li>`).pages).toBe(46);
    expect(read(`${TAG}<li><b>Page</b> <a href="javascript:void(0)">44 pages</a></li>`).pages).toBe(44);
    expect(read(`${TAG}<li>Pages: 1,024</li>`).pages).toBe(1024);
    expect(read(TAG, `<table><tr><td>Pages</td><td>19 (12.3 MB)</td></tr></table>`).pages).toBe(0); // outside the info block
  });

  it("reads the upload day from a <time>, a labeled row, a 'date' element or the declared metadata", () => {
    expect(read(`${TAG}<li>Uploaded: <time datetime="2016-10-18T12:28:49+00:00">6 years ago</time></li>`).uploaded_at).toBe("2016-10-18");
    expect(read(`${TAG}<li>Posted: April 20, 2023</li>`).uploaded_at).toBe("2023-04-20");
    expect(read(`${TAG}<li><span class="date">2023-04-20 01:23:00-05</span></li>`).uploaded_at).toBe("2023-04-20");
    expect(read(TAG, "", `<meta property="article:published_time" content="2021-06-01T08:00:00Z">`).uploaded_at).toBe("2021-06-01");
    expect(read(TAG, "", `<script type="application/ld+json">{"@type":"Book","name":"Some Title","datePublished":"2020-02-14"}</script>`).uploaded_at)
      .toBe("2020-02-14");
  });

  it("stores no day for a year alone or a relative age", () => {
    expect(read(`${TAG}<li>Release Year: 2019</li>`).uploaded_at).toBeNull();
    expect(read(`${TAG}<li>Posted: 3 days ago</li>`).uploaded_at).toBeNull();
    expect(read(`${TAG}<li>Uploaded: <time>2 years ago</time></li>`).uploaded_at).toBeNull();
  });
});

describe("readPage: the doujin title convention", () => {
  it("names the circle, artist and parody when the page lists none of them", () => {
    const r = gallery(page({
      title: "(C92) [Quill Rycm (Quill Tjgk)] Morning Ledger Fqkgbiq (Quill Rfns) [English] [Scanlator]",
      rows: `<li>Tags: <a href="/tag/big-breasts/">big breasts</a></li>`,
    }), GALLERY);
    expect(r.title_name).toBe("Morning Ledger Fqkgbiq");
    expect(r.groups).toEqual([{ name: "quill rycm", link: "", total_works: 0 }]);
    expect(r.artists).toEqual([{ name: "quill tjgk", link: "", total_works: 0 }]);
    expect(r.parodies).toEqual([{ name: "quill rfns", link: "", total_works: 0 }]);
    // The event and the language/scanlator tail are not entities.
    expect(names([...r.groups, ...r.artists, ...r.parodies])).not.toContain("c92");
    expect(names(r.groups)).not.toContain("scanlator");
  });

  it("reads a lone artist bracket, and no parody from a release-note tail", () => {
    const r = gallery(page({ title: "[PenQech] PenXjbs (Decensored) [English]", rows: `<li>Tags: <a href="/tag/x/">x</a></li>` }), GALLERY);
    expect(names(r.artists)).toEqual(["penqech"]);
    expect(r.groups).toEqual([]);
    expect(r.parodies).toEqual([]);
  });

  it("only fills in what the page did not list itself", () => {
    const r = gallery(page({
      title: "[Wrong Circle (Wrong Artist)] Title (Wrong Parody)",
      rows: `<li>Artists: <a href="/artist/right/">right artist</a></li>`,
    }), GALLERY);
    expect(names(r.artists)).toEqual(["right artist"]);
    // Kinds the page left out still come from the brackets.
    expect(names(r.groups)).toEqual(["wrong circle"]);
    expect(names(r.parodies)).toEqual(["wrong parody"]);
  });

  it("is enough, with a cover, to call a page a gallery", () => {
    const html = `<html><head><meta property="og:image" content="https://cdn.doujin-site.com/1/cover.jpg"></head><body>
      <div class="content"><h1>[Circle (Artist)] Title (Parody) [English]</h1></div></body></html>`;
    const r = gallery(html, GALLERY);
    expect(r.title_name).toBe("Title");
    expect(r.image_link).toBe("https://cdn.doujin-site.com/1/cover.jpg");
    expect(names(r.artists)).toEqual(["artist"]);
  });
});

describe("readPage: what is not a gallery", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) =>
    `<div class="card"><a href="/gallery/${200 + i}/"><img src="https://cdn.doujin-site.com/${200 + i}/thumb.jpg">
      <div class="caption">[Circle ${i}] Another Title ${i} (Original) [English]</div></a></div>`).join("");

  it("refuses a page that links to many other titles — a listing", () => {
    const html = `<html><body><div class="container"><h1>Big Breasts Selection</h1>
      <a href="/tag/big-breasts/">big breasts</a>${cards(8)}</div></body></html>`;
    expect(refused(html, GALLERY)).toMatch(/lists other titles/);
  });

  it("refuses an address that does not name a single title", () => {
    expect(refused(`<html><body><h1>Doujin Site</h1>${cards(8)}</body></html>`, `${SITE}/`)).toMatch(/does not name a single title/);
    expect(refused(page({ rows: `<li>Tags: <a href="/tag/x/">x</a></li>` }), `${SITE}/tag/big-breasts/`)).toMatch(/does not name/);
  });

  it("refuses a login wall", () => {
    const html = `<html><body><h1>Members only gallery</h1><form><input name="u"><input type="password" name="p">
      <button>Log in</button></form><p>You must be logged in to view this.</p></body></html>`;
    expect(refused(html, GALLERY)).toMatch(/login wall/);
    expect(refused(`<html><body><h1>Sign in</h1><input type="password"></body></html>`, GALLERY)).toMatch(/not a title/);
  });

  it("refuses a 404 or a removed gallery", () => {
    expect(refused(`<html><body><h1>404 - Page Not Found</h1><a href="/">home</a></body></html>`, GALLERY)).toMatch(/not a title/);
    expect(refused(`<html><body><h1>Gallery not found</h1></body></html>`, GALLERY)).toMatch(/not a title/);
    expect(refused(page({ title: "This gallery has been removed", rows: `<li>Tags: <a href="/tag/x/">x</a></li>` }), GALLERY))
      .toMatch(/not a title/);
  });

  it("refuses a news article that has only tags and an image", () => {
    const html = `<html><head><meta property="og:type" content="article">
      <meta property="og:image" content="https://cdn.doujin-site.com/news/summer.jpg">
      <title>Summer sale announced - Doujin Site</title></head><body>
      <article><h1>Summer sale announced</h1><p>Lorem ipsum.</p>
        <div class="post-tags">Tags: <a href="/tag/news/">news</a> <a href="/tag/sale/">sale</a> <a href="/tag/summer/">summer</a></div>
      </article></body></html>`;
    expect(refused(html, `${SITE}/2024/05/summer-sale-announced/`)).toMatch(/no title data/);
  });

  it("refuses a client-rendered shell whose template is still empty", () => {
    const html = `<html><head><title>Hitomi.la</title></head><body>
      <div class="cover-column"><h1><a href="#">Read Online</a></h1><h1><a href="#">Download</a></h1>
        <div class="cover"><img src="/images/loading.gif"></div></div>
      <div class="gallery"><h1 id="gallery-brand"></h1><h2 id="artists"></h2>
        <div class="gallery-info"><table><tr><td>Group</td><td></td></tr><tr><td>Tags</td><td></td></tr></table></div>
        <span class="date"></span></div></body></html>`;
    expect(readPage(html, "https://hitomi.la/galleries/1234567.html").kind).toBe("none");
  });
});

describe("readPage: following", () => {
  it("follows a content warning's 'View Gallery' link", () => {
    const html = `<html><head><title>[Circle] Some Title - E-Hentai Galleries</title></head><body>
      <div id="nb"><a href="https://e-hentai.org/">Front Page</a></div>
      <div><h1>[Circle] Some Title</h1><h2>Content Warning</h2>
        <p>This gallery has been flagged as <strong>Offensive For Everyone</strong>.</p>
        <p>[<a href="https://e-hentai.org/g/8958199/cae9a87857/?nw=session">View Gallery</a>]
           [<a href="https://e-hentai.org/g/8958199/cae9a87857/?nw=always">Never Warn Me Again</a>]
           [<a href="https://e-hentai.org/">Get Me Outta Here</a>]</p></div></body></html>`;
    const f = follows(html, "https://e-hentai.org/g/8958199/cae9a87857/");
    expect(f.url).toBe("https://e-hentai.org/g/8958199/cae9a87857/?nw=session");
    expect(f.why).toMatch(/View Gallery/);
  });

  it("follows an age gate's 'Enter', never a link off the site", () => {
    const html = `<html><head><title>Age verification</title></head><body><div class="gate">
      <h2>Are you over 18?</h2><p>This site contains adult content.</p>
      <a href="https://elsewhere.example/g/12345/">Continue</a>
      <a href="/gallery/12345/?adult=1">Enter</a> <a href="https://google.com/">Leave</a></div></body></html>`;
    expect(follows(html, GALLERY).url).toBe(`${SITE}/gallery/12345/?adult=1`);
  });

  it("goes from a reader page to its gallery", () => {
    const html = `<html><head><title>Some Title - Page 3</title></head><body>
      <div class="reader-bar"><a href="/gallery/12345/">Some Title</a> <span>3 / 24</span></div>
      <img id="image" src="https://cdn.doujin-site.com/12345/3.jpg"></body></html>`;
    const f = follows(html, `${SITE}/read/12345/3`);
    expect(f.url).toBe(GALLERY);
    expect(f.why).toMatch(/reader/);
  });

  // A reader page that repeats the title in an <h1> and links to its
  // neighbours is not a gallery reading: its Next link is not a page count and
  // its image is one page — the link back to the gallery is followed instead.
  it("goes from a reader page with a title heading and Prev/Next links to its gallery", () => {
    const html = `<html><head><title>Some Title - Page 3 - Doujin Site</title></head><body>
      <div class="reader"><h1>Some Title</h1>
        <a href="/gallery/12345/">Back to gallery</a>
        <a href="/gallery/12345/2/">Prev</a> <a href="/gallery/12345/4/">Next</a>
        <img src="https://cdn.doujin-site.com/12345/3.jpg"></div></body></html>`;
    expect(follows(html, `${SITE}/gallery/12345/3/`).url).toBe(GALLERY);
  });

  it("does not follow a warning link on a page that is already the gallery", () => {
    const html = page({ rows: `<li>Tags: <a href="/tag/x/">x</a></li>` })
      .replace("</body>", `<p>This gallery contains adult content.</p><a href="/gallery/12345/?nw=1">Continue</a></body>`);
    expect(readPage(html, GALLERY).kind).toBe("gallery");
  });
});

describe("readPage: hostile titles", () => {
  // A separator regex with \s+ on both sides backtracks over a run of spaces
  // from every start position: a page with a quarter of a million spaces in
  // its og:title held the scraper host's event loop for minutes.
  it("reads a page whose declared title is one huge run of whitespace in linear time", () => {
    const spaces = " ".repeat(250_000);
    const html = `<html><head><meta property="og:title" content="a${spaces}b"><title>x${" -".repeat(50_000)}y</title></head>
      <body><h1>Some Title${" - x".repeat(5_000)} dj</h1></body></html>`;
    const started = performance.now();
    readPage(html, "https://site.example/g/123/");
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
