// nhentai: the gallery page's #info block. The original source of this app, and
// still the one whose vocabulary (lowercase tags, " | " aliases) every other
// adapter is folded into.

import * as cheerio from "cheerio";
import type { ScrapeEntity, ScrapeResult } from "../scrape-payload";
import { SOURCES } from "../sources";
import { parseCount, ScrapeError, type SiteAdapter } from "./common";

const NH_ORIGIN = "https://nhentai.net";

// Entity links are stored in one absolute form. The markup carries relative
// hrefs ("/artist/x/"), and a stored link you cannot open without separately
// knowing the base is only half a link. Migration 5 backfilled the same shape.
function absoluteLink(href: string): string {
  if (!href) return "";
  try {
    return new URL(href, NH_ORIGIN).toString();
  } catch {
    return href;
  }
}

// nhentai slugs a tag page by lowercasing and collapsing every run of
// non-alphanumerics into a single dash ("quill ruva" → "quill-ruva").
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// nhentai keeps every alias of one entity on a single tag page with " | "
// between the names, and every category is split the same way so the tables
// stay uniform. What that means differs by category and is worth knowing before
// changing it: for artists and groups the halves are genuinely separate credits
// ("pensgfi | pencbfj"), while for parodies the separator carries one work's
// Japanese and English titles, so "pokemon | pocket monsters" becomes two
// parody rows for one franchise. Uniformity was chosen over nhentai's
// semantics on purpose — see migration 5.
type EntityKind = "artist" | "group" | "character" | "parody" | "tag";

function splitAliases(entities: ScrapeEntity[], kind: EntityKind): ScrapeEntity[] {
  const out: ScrapeEntity[] = [];
  const seen = new Set<string>();
  const push = (e: ScrapeEntity) => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    out.push(e);
  };

  for (const e of entities) {
    if (!e.name.includes("|")) {
      push(e);
      continue;
    }
    for (const raw of e.name.split("|")) {
      const name = raw.trim();
      if (!name) continue;
      // The combined page's own href says nothing about a half, so derive it.
      // total_works is carried over rather than zeroed: it is write-only data,
      // and a zero would clobber a real count on an existing row's upsert.
      push({ name, link: `${NH_ORIGIN}/${kind}/${slugify(name)}/`, total_works: e.total_works });
    }
  }
  return out;
}

// Exported for tests (lib/scrapers/nhentai.test.ts pins the parse against
// fixture HTML so nhentai markup drift or a selector edit fails loudly).
export function parseInfoDiv(html: string, id: string): ScrapeResult {
  const $ = cheerio.load(html);
  const info = $("#info");

  const title_name = info.find("h1 .pretty").text().trim();
  // An empty title means the selector no longer matches (markup drift) or the
  // page served an empty #info — fail loudly rather than upsert a blank record
  // that a later `rescrape --all` would overwrite good data with.
  if (title_name === "") {
    throw new ScrapeError(`parsed empty title for #${id} — markup drift?`, "TIMEOUT");
  }

  const image_link =
    $("div#cover img").attr("data-src") ||
    $("div#cover img").attr("src") ||
    "";

  const pagesText = info
    .find(".tag-container")
    .filter((_, el) => $(el).text().trimStart().startsWith("Pages:"))
    .find(".name")
    .first()
    .text();
  const pages = parseCount(pagesText);

  // Never fabricate an upload date: a missing/malformed datetime attr would
  // otherwise get stamped as "today" and re-stamped on every re-scrape.
  const datetimeAttr = (info.find("time").attr("datetime") ?? "").trim();
  if (datetimeAttr === "" || Number.isNaN(Date.parse(datetimeAttr))) {
    throw new ScrapeError(`missing or malformed upload date for #${id}`, "TIMEOUT");
  }
  const uploaded_at = datetimeAttr.split("T")[0];

  const extractEntities = (label: string): ScrapeEntity[] => {
    const container = info
      .find(".tag-container")
      .filter((_, el) => $(el).text().trimStart().startsWith(label));

    const entities: ScrapeEntity[] = [];
    container.find("a.tag, a.tagchip").each((_, el) => {
      const name = $(el).find(".name").text().trim();
      const total_works = parseCount($(el).find(".count").text());
      const href = $(el).attr("href") || "";
      entities.push({ name, link: absoluteLink(href), total_works });
    });
    return entities;
  };

  return {
    source: "nhentai",
    source_id: id,
    title_name,
    image_link,
    pages,
    uploaded_at,
    tags: splitAliases(extractEntities("Tags:"), "tag"),
    artists: splitAliases(extractEntities("Artists:"), "artist"),
    groups: splitAliases(extractEntities("Groups:"), "group"),
    characters: splitAliases(extractEntities("Characters:"), "character"),
    parodies: splitAliases(extractEntities("Parodies:"), "parody"),
  };
}

export const nhentai: SiteAdapter = {
  request: (id) => ({ url: SOURCES.nhentai.url(id) }),
  fetchHosts: ["nhentai.net"],
  isComplete: (html) => html.includes('id="info"'),
  parse: parseInfoDiv,
  browserReady: "#info",
};
