// HentaiFox and IMHentai: one gallery engine behind two sites (gallery-dl reads
// both with a single extractor). The title page is an <h1> inside an info box
// that lists the entities as links to the site's own category pages:
//
//   <div class="info">                      (IMHentai: div.right_details)
//     <h1>[Circle (Artist)] Title (Parody) [English]</h1>
//     <ul class="tags"><span class="tags_text">Tags:</span>
//       <li><a class="tag_btn" href="/tag/big-breasts/">big breasts <span class="t_badge">123</span></a></li>
//     </ul>
//     <span class="i_text pages">Pages: 24</span>
//   </div>
//
// The kind of each entity is read from its href (/tag/, /artist/, /group/,
// /parody/, /character/) rather than from the row label or a class name: the
// path IS the site's taxonomy, and it is the part of this markup least likely
// to be restyled.

import * as cheerio from "cheerio";
import type { EntityKind, ScrapeResult } from "../scrape-payload";
import { SOURCES, type SourceId } from "../sources";
import {
  absoluteUrl, coverOrEmpty, EntityBag, isoDay, looksLikeHtml, meta, parseCount, prettyTitle, ScrapeError,
  type SiteAdapter,
} from "./common";

const PATH_KINDS: Record<string, EntityKind> = {
  tag: "tags",
  artist: "artists",
  group: "groups",
  parody: "parodies",
  character: "characters",
};

const ENTITY_PATH = /^\/(tag|artist|group|parody|character)\/[^/]+\/?$/;

export function parseGalleryAdults(source: "hentaifox" | "imhentai", html: string, id: string): ScrapeResult {
  const def = SOURCES[source];
  const origin = `https://${def.hosts[0]}`;
  const $ = cheerio.load(html);

  const kindOf = (href: string | undefined): EntityKind | null => {
    const url = absoluteUrl(href, origin);
    if (!url) return null;
    const { hostname, pathname } = new URL(url);
    if (!def.hosts.includes(hostname.replace(/^www\./, ""))) return null;
    const m = pathname.match(ENTITY_PATH);
    return m ? PATH_KINDS[m[1]] : null;
  };

  const h1 = $("h1").first();
  const rawTitle =
    h1.text().trim() ||
    ($("#gallery_title").attr("value") ?? "").trim() || // older HentaiFox markup
    meta($, "og:title");
  if (!rawTitle) throw new ScrapeError(`${def.name} gallery ${id} has no title — not a title page`, "NOT_FOUND");

  // The info box: the nearest ancestor of the title that holds entity links.
  // Bounded, so a tag-less gallery does not grow the box into the whole page
  // and pick up the sidebar's tag cloud.
  const holdsEntities = (_: number, el: Parameters<typeof $>[0]) =>
    $(el).find("a[href]").toArray().some((a) => kindOf($(a).attr("href")) !== null);
  const scope = h1.parents().slice(0, 4).filter(holdsEntities).first();
  const box = scope.length ? scope : h1.length ? h1.parents().first() : $("body");

  const bag = new EntityBag();
  box.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const kind = kindOf(href);
    if (!kind) return;
    // The anchor holds the name and a count badge; take the badge out first.
    const el = $(a).clone();
    const badge = el.find('[class*="badge"], [class*="count"]');
    const count = parseCount(badge.text());
    badge.remove();
    bag.add(kind, el.text(), absoluteUrl(href, origin), count);
  });

  const boxText = box.text();
  const pages =
    parseCount(boxText.match(/Pages\s*:?\s*(\d[\d,]*)/i)?.[1]) ||
    parseCount($("#load_pages").attr("value"));

  const coverImg = $("#cover img, .cover img, .left_cover img, .gallery_top img, [class*='cover'] img").first();
  const image_link = coverOrEmpty(
    source,
    coverImg.attr("data-src") || coverImg.attr("src") || meta($, "og:image"),
    origin,
  );

  // Not every gallery prints a date; null says so rather than guessing.
  const uploaded_at =
    isoDay($("time[datetime]").first().attr("datetime")) ??
    isoDay(boxText.match(/Posted\s*:?\s*([^\n]{6,40}?\d{4})/i)?.[1]);

  // A page with a heading and none of a gallery's parts (a listing, a
  // "removed" notice, the home page after a redirect) is not a title.
  if (pages === 0 && !image_link && bag.size === 0) {
    throw new ScrapeError(`${def.name} page for ${id} is not a gallery`, "NOT_FOUND");
  }

  return {
    source,
    source_id: id,
    title_name: prettyTitle(rawTitle),
    image_link,
    pages,
    uploaded_at,
    ...bag.result(),
  };
}

function adapter(source: "hentaifox" | "imhentai"): SiteAdapter {
  const hosts = SOURCES[source as SourceId].hosts;
  return {
    request: (id) => ({ url: SOURCES[source].url(id) }),
    fetchHosts: [...hosts, ...hosts.map((h) => `www.${h}`)],
    isComplete: looksLikeHtml,
    parse: (html, id) => parseGalleryAdults(source, html, id),
    browserReady: "h1",
  };
}

export const hentaifox = adapter("hentaifox");
export const imhentai = adapter("imhentai");
