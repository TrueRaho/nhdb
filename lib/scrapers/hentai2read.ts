// Hentai2Read: the title page (/<slug>/), which lists its chapters. Two parts
// of it matter, and they are separate elements (checked against the live site):
//
//   <div itemscope itemtype="http://schema.org/Book" class="hide">
//     <span itemprop="name">Title</span> … rating …
//   </div>
//   …
//   <div class="block-content …">                     (the "Manga Info" block)
//     <img class="img-responsive" src="https://img1.hentaicdn.com/hentai/cover/_S1234.jpg">
//     <ul class="list list-simple-mini">
//       <li class="text-muted">Alternative Title<li>
//       <li><b>Parody</b> <a href="…/hentai-list/category/Some%20Series%20dj./">Some Series dj.</a></li>
//       <li><b>Page</b> <a href="javascript:void(0)">26 pages</a></li>
//       <li><b>Artist</b> <a href="…/hentai-list/artist/…/">…</a></li>
//       <li><b>Category</b> <a …>Adult</a><a …>Big Breasts</a><a …>Oneshot</a></li>
//       <li><b>Content</b> <a …>Ahegao</a><a …>X-Ray</a></li>
//       <li><b>Character</b> <a href="javascript:void(0)">-</a></li>
//     </ul>
//   </div>
//
// The hidden Book block holds only the name, so it is not where the rows are
// looked for. It is also what tells a title page apart: the sidebar on every
// page of the site carries `data-mid` manga ids, so those prove nothing, while
// the Book block and the info list appear only on a title — a slug that turns
// out to be a section of the site fails here as "not a title" instead of being
// stored. The page prints no upload date ("about 10 years ago" on a chapter is
// not one), so that stays null.

import * as cheerio from "cheerio";
import type { ScrapeResult } from "../scrape-payload";
import { normalizeEntityName } from "../scrape-payload";
import { SOURCES } from "../sources";
import {
  absoluteUrl, clip, coverOrEmpty, EntityBag, isoDay, kindFromLabel, looksLikeHtml, meta, parseCount,
  ScrapeError, type SiteAdapter,
} from "./common";

const ORIGIN = "https://hentai2read.com";
const HOSTS = ["hentai2read.com", "www.hentai2read.com"];

function onSite(href: string | undefined): string {
  const url = absoluteUrl(href, ORIGIN);
  return url && HOSTS.includes(new URL(url).hostname) ? url : "";
}

const searchLink = (name: string) =>
  `${ORIGIN}/hentai-list/search/${encodeURIComponent(normalizeEntityName(name))}/`;

// The Category row mixes genres with the rating and the publication format.
// Across live titles "Adult" was on every one and "Oneshot"/"Doujinshi" on
// most; like Pururin's format row, they are not tags.
const NOT_TAGS = new Set(["adult", "doujinshi", "manga", "oneshot", "serialized"]);

// An empty row prints a "-" placeholder instead of leaving the link out.
const isPlaceholder = (name: string) => /^[\s\-–—]*$/.test(name);

export function parseHentai2Read(html: string, id: string): ScrapeResult {
  const $ = cheerio.load(html);
  const book = $('[itemtype*="schema.org/Book"]').first();
  const info = $("ul.list-simple-mini").first();
  if (!book.length && !info.length) {
    throw new ScrapeError(`Hentai2Read page "${id}" is not a title page`, "NOT_FOUND");
  }

  // Fallback: the info block's own heading, "Title <small>[Doujinshi]</small>".
  const heading = info.closest(".block-content").prevAll(".block-header").find(".block-title a").first().clone();
  heading.find("small").remove();
  const title = clip((book.find('[itemprop="name"]').first().text() || heading.text()).trim());
  if (!title) throw new ScrapeError(`Hentai2Read title "${id}" has no name`, "TIMEOUT");

  const bag = new EntityBag();
  let pages = 0;
  // Rows read "<b>Label</b> <a>value</a><a>value</a>".
  info.children("li").each((_, li) => {
    const label = $(li).children("b, strong").first().text().trim();
    if (!label) return;
    const isCategory = /^categor/i.test(label);
    const kind = kindFromLabel(label) ?? (isCategory ? "tags" : null);
    if (kind) {
      $(li).find("a").each((_, a) => {
        let name = $(a).text().trim();
        if (isPlaceholder(name)) return;
        if (isCategory && NOT_TAGS.has(name.toLowerCase())) return;
        // A doujinshi's parody is "Some Series dj."; the series is "Some Series".
        if (kind === "parodies") name = name.replace(/\s+dj\.?$/i, "");
        bag.add(kind, name, onSite($(a).attr("href")) || searchLink(name));
      });
    } else if (/^pages?$/i.test(label)) {
      pages = parseCount($(li).text().replace(label, ""));
    }
  });

  // The cover sits beside the info list; the sidebar's thumbnails are covers
  // too (of other titles), so the search stays inside the info block.
  const coverImg = info.closest(".block-content").find("img")
    .filter((_, img) => /\/cover\//.test($(img).attr("src") ?? "")).first();
  const image_link = coverOrEmpty("hentai2read", coverImg.attr("src") || meta($, "og:image"), ORIGIN);

  return {
    source: "hentai2read",
    source_id: id,
    title_name: title,
    image_link,
    pages,
    uploaded_at:
      isoDay($('[itemprop="datePublished"]').attr("content")) ??
      isoDay(book.find("time[datetime]").first().attr("datetime")),
    ...bag.result(),
  };
}

export const hentai2read: SiteAdapter = {
  request: (id) => ({ url: SOURCES.hentai2read.url(id) }),
  fetchHosts: HOSTS,
  isComplete: looksLikeHtml,
  parse: parseHentai2Read,
  browserReady: '[itemtype*="schema.org/Book"], ul.list-simple-mini',
};
