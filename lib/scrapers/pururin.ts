// Pururin: the gallery page. Titles are written "English / Japanese" in the
// heading, and the metadata sits in a table of labeled rows (Artist, Circle,
// Parody, Contents, Character, Pages, Uploaded…). The site has re-skinned
// more than once (pururin.io → .to → .me), and its later builds render some
// rows as components that ship their values as JSON in hidden inputs
// (`<input name="artist_tags" value="[{&quot;name&quot;:…}]">`), so both
// forms are read. Whatever the row looks like, a link to the site's own page
// for an entity is kept; an entity without one gets the site's search page for
// its name — always a pururin.me URL, never anything else.

import * as cheerio from "cheerio";
import type { EntityKind, ScrapeResult } from "../scrape-payload";
import { normalizeEntityName } from "../scrape-payload";
import {
  absoluteUrl, clip, coverOrEmpty, EntityBag, isoDay, kindFromLabel, looksLikeHtml, meta, parseCount,
  ScrapeError, type SiteAdapter,
} from "./common";
import { SOURCES } from "../sources";

const ORIGIN = "https://pururin.me";
const HOSTS = ["pururin.me", "www.pururin.me"];

const searchLink = (name: string) => `${ORIGIN}/search?q=${encodeURIComponent(normalizeEntityName(name))}`;

function onSite(href: string | undefined): string {
  const url = absoluteUrl(href, ORIGIN);
  return url && HOSTS.includes(new URL(url).hostname) ? url : "";
}

// Tag pages: /tags/<kind>/<id>/<slug> (with or without a /browse prefix).
const TAG_PATH = /\/tags\/([a-z]+)\/\d+/i;

export function parsePururin(html: string, id: string): ScrapeResult {
  const $ = cheerio.load(html);

  const heading = $('h1 [itemprop="name"]').first().text() || $("h1").first().text() || meta($, "og:title");
  // "Morning Ledger Fqkgbiq / サンプルサケタス!!" → the first half that has text.
  const title = clip(heading.split(" / ").map((s) => s.trim()).find(Boolean) ?? "");
  if (!title) throw new ScrapeError(`Pururin gallery ${id} has no title — not a title page`, "NOT_FOUND");

  const bag = new EntityBag();
  let pages = 0;
  let uploaded: string | null = null;

  // 1. Labeled table rows: <tr><td>Artist</td><td><a href=… title="Name">Name</a></td></tr>
  $("tr").each((_, tr) => {
    const cells = $(tr).children("td, th");
    if (cells.length < 2) return;
    const label = cells.first().text().trim();
    const value = cells.eq(1);
    const kind = kindFromLabel(label);
    if (kind) {
      value.find("a").each((_, a) => {
        const name = ($(a).attr("title") || $(a).text()).split(" / ")[0];
        bag.add(kind, name, onSite($(a).attr("href")) || searchLink(name));
      });
      return;
    }
    const l = label.toLowerCase();
    if (l.startsWith("page")) pages ||= parseCount(value.text());
    if (l.startsWith("upload") || l === "date") {
      uploaded ??= isoDay(value.find("time[datetime]").attr("datetime")) ?? isoDay(value.text());
    }
  });

  // 2. Rows rendered as components: the values travel as JSON.
  $("input[name$='_tags'], input[name$='-tags']").each((_, input) => {
    const kind = kindFromLabel(($(input).attr("name") ?? "").replace(/[_-]tags$/i, ""));
    if (!kind) return;
    let items: unknown;
    try {
      items = JSON.parse($(input).attr("value") ?? "");
    } catch {
      return;
    }
    for (const item of Array.isArray(items) ? items : []) {
      const name = typeof item?.name === "string" ? item.name.split(" / ")[0] : "";
      if (name) bag.add(kind, name, searchLink(name));
    }
  });

  // 3. Neither form present: any link to one of the site's tag pages.
  if (bag.size === 0) {
    $("a[href]").each((_, a) => {
      const href = onSite($(a).attr("href"));
      const kind: EntityKind | null = href ? kindFromLabel(new URL(href).pathname.match(TAG_PATH)?.[1] ?? "") : null;
      if (kind) bag.add(kind, $(a).attr("title") || $(a).text(), href);
    });
  }

  pages ||= parseCount($("body").text().match(/(\d[\d,]*)\s*pages?\b/i)?.[1]);
  uploaded ??=
    isoDay($('[itemprop="datePublished"]').attr("content")) ??
    isoDay($("time[datetime]").first().attr("datetime"));

  const coverImg = $(".cover-wrapper img, .gallery-cover img, [class*='cover'] img").first();
  const image_link = coverOrEmpty(
    "pururin",
    meta($, "og:image") || coverImg.attr("data-src") || coverImg.attr("src"),
    ORIGIN,
  );

  if (pages === 0 && !image_link && bag.size === 0) {
    throw new ScrapeError(`Pururin page for ${id} is not a gallery`, "NOT_FOUND");
  }

  return {
    source: "pururin",
    source_id: id,
    title_name: title,
    image_link,
    pages,
    uploaded_at: uploaded,
    ...bag.result(),
  };
}

export const pururin: SiteAdapter = {
  request: (id) => ({ url: SOURCES.pururin.url(id) }),
  fetchHosts: HOSTS,
  isComplete: looksLikeHtml,
  parse: parsePururin,
  browserReady: "h1",
};
