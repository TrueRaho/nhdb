import { describe, expect, it } from "vitest";
import { ScrapeError, looksLikeChallenge } from "./common";
import { parseInfoDiv } from "./nhentai";

// Fixture mirroring the real nhentai gallery markup that parseInfoDiv's
// selectors depend on: #info > h1 .pretty, div#cover img[data-src],
// .tag-container blocks labeled "Tags:" / "Pages:" / …, and time[datetime].
// If a selector edit (or an intentional markup change) breaks one of these
// assertions, the scraper would silently upsert wrong data — better here.
function galleryHtml({
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
}: {
  title?: string;
  cover?: string;
  time?: string;
  pagesRow?: string;
  artistsRow?: string;
  groupsRow?: string;
  parodiesRow?: string;
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

describe("parseInfoDiv", () => {
  it("parses a full gallery page", () => {
    const r = parseInfoDiv(galleryHtml(), "177013");
    expect(r.source).toBe("nhentai");
    expect(r.source_id).toBe("177013");
    expect(r.title_name).toBe("PenXjbs");
    expect(r.image_link).toBe("https://t.nhentai.net/galleries/811673/cover.jpg");
    expect(r.pages).toBe(225);
    expect(r.uploaded_at).toBe("2016-10-18");
    expect(r.tags.map((t) => t.name)).toEqual(["ahegao", "dark skin"]);
    // Links are stored absolute, whatever the markup carried.
    expect(r.tags[0]).toEqual({ name: "ahegao", link: "https://nhentai.net/tag/ahegao/", total_works: 21043 });
    expect(r.artists).toEqual([
      { name: "penqech", link: "https://nhentai.net/artist/penqech/", total_works: 79 },
    ]);
    expect(r.groups).toEqual([]);
    expect(r.characters).toEqual([]);
    expect(r.parodies.map((p) => p.name)).toEqual(["original"]);
  });

  it("takes only the .pretty span, not the bracketed before/after parts", () => {
    const r = parseInfoDiv(galleryHtml(), "1");
    expect(r.title_name).not.toContain("PenNieb");
    expect(r.title_name).not.toContain("English");
  });

  it("prefers data-src on the cover but falls back to src", () => {
    const r = parseInfoDiv(galleryHtml({ cover: `<img src="https://t.nhentai.net/x/cover.jpg">` }), "1");
    expect(r.image_link).toBe("https://t.nhentai.net/x/cover.jpg");
  });

  it("parses comma-grouped total_works counts", () => {
    const r = parseInfoDiv(galleryHtml(), "1");
    expect(r.parodies[0].total_works).toBe(62050);
  });

  it("makes every entity link absolute", () => {
    const r = parseInfoDiv(galleryHtml(), "1");
    for (const e of [...r.tags, ...r.artists, ...r.parodies]) {
      expect(e.link.startsWith("https://nhentai.net/")).toBe(true);
    }
  });

  it("splits an aliased artist or group into separate credits", () => {
    // nhentai keeps aliases of one credit on a single page: "pensgfi | pencbfj".
    const html = galleryHtml({
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
    });
    const r = parseInfoDiv(html, "1");

    expect(r.artists).toEqual([
      { name: "pensgfi", link: "https://nhentai.net/artist/pensgfi/", total_works: 8 },
      { name: "pencbfj", link: "https://nhentai.net/artist/pencbfj/", total_works: 8 },
    ]);
    expect(r.groups).toEqual([
      { name: "quill ihak", link: "https://nhentai.net/group/quill-ihak/", total_works: 3 },
      { name: "penqzoj", link: "https://nhentai.net/group/penqzoj/", total_works: 3 },
    ]);
  });

  it("slugs a split half the way nhentai does", () => {
    const html = galleryHtml({
      artistsRow: `
        <div class="tag-container field-name">Artists:
          <span class="tags">
            <a class="tag" href="/artist/ckdkh-xmym-px/"><span class="name">ckdkh | quill ruva</span> <span class="count">1</span></a>
          </span>
        </div>`,
    });
    expect(parseInfoDiv(html, "1").artists.map((a) => a.link)).toEqual([
      "https://nhentai.net/artist/ckdkh/",
      "https://nhentai.net/artist/quill-ruva/",
    ]);
  });

  it("splits a parody too — uniform rule, even though the halves are JP/EN of one work", () => {
    // Chosen deliberately (see migration 5): the schema stays uniform at the
    // cost of one franchise occupying two parody rows.
    const html = galleryHtml({
      parodiesRow: `
        <div class="tag-container field-name">Parodies:
          <span class="tags">
            <a class="tag" href="/parody/penvxcz-quill-cuoi/"><span class="name">penvxcz | quill cuoi</span> <span class="count">900</span></a>
          </span>
        </div>`,
    });
    expect(parseInfoDiv(html, "1").parodies).toEqual([
      { name: "penvxcz", link: "https://nhentai.net/parody/penvxcz/", total_works: 900 },
      { name: "quill cuoi", link: "https://nhentai.net/parody/quill-cuoi/", total_works: 900 },
    ]);
  });

  it("does not emit the same credit twice when a half is also listed on its own", () => {
    const html = galleryHtml({
      artistsRow: `
        <div class="tag-container field-name">Artists:
          <span class="tags">
            <a class="tag" href="/artist/pensgfi/"><span class="name">pensgfi</span> <span class="count">79</span></a>
            <a class="tag" href="/artist/pensgfi-pencbfj/"><span class="name">pensgfi | pencbfj</span> <span class="count">8</span></a>
          </span>
        </div>`,
    });
    expect(parseInfoDiv(html, "1").artists.map((a) => a.name)).toEqual(["pensgfi", "pencbfj"]);
  });

  it("throws (not returns blank) when the title selector matches nothing", () => {
    // A blank title upserted quietly would let a later rescrape --all overwrite
    // good rows — the parser must refuse instead.
    expect(() => parseInfoDiv(galleryHtml({ title: "" }), "42")).toThrow(ScrapeError);
    expect(() => parseInfoDiv("<div id='info'></div>", "42")).toThrow(/markup drift/);
  });

  it("throws when the upload date is missing or malformed", () => {
    expect(() => parseInfoDiv(galleryHtml({ time: "<time>6 years ago</time>" }), "42")).toThrow(ScrapeError);
    expect(() => parseInfoDiv(galleryHtml({ time: `<time datetime="not-a-date">x</time>` }), "42")).toThrow(
      /upload date/,
    );
  });

  it("parses zero pages when the Pages row is absent, not NaN", () => {
    const r = parseInfoDiv(galleryHtml({ pagesRow: "" }), "1");
    expect(r.pages).toBe(0);
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
    expect(looksLikeChallenge(galleryHtml())).toBe(false);
  });

  it("only inspects the head of the document", () => {
    // The marker scan is capped at 4KB — gallery comments mentioning the
    // phrases must not flag a real page.
    const page = galleryHtml() + " ".repeat(5000) + "just a moment";
    expect(looksLikeChallenge(page)).toBe(false);
  });
});
