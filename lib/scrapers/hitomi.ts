// Hitomi: the gallery page is assembled in the browser from a per-gallery
// script, so that script is what we read.
//
//   GET https://ltn.gold-usergeneratedcontent.net/galleries/<id>.js
//   → var galleryinfo = {"id":"1234567","title":"…","date":"2023-04-20 01:23:00-05",
//      "artists":[{"artist":"…","url":"/artist/…-all.html"}],"groups":[…],
//      "parodys":[…],"characters":[…],"tags":[{"tag":"big breasts","female":"1","url":"…"}],
//      "files":[{"hash":"<64 hex>","name":"01.jpg",…}],…}
//
// Field names and the thumbnail path follow gallery-dl's and node-hitomi's
// readers of the same file. The resource host has moved before (it used to be
// ltn.hitomi.la); if it moves again, this constant and the image host in
// lib/sources.ts are the two places to change.

import type { EntityKind, ScrapeResult } from "../scrape-payload";
import { clip, coverOrEmpty, EntityBag, isoDay, ScrapeError, type SiteAdapter } from "./common";

const RESOURCE_HOST = "ltn.gold-usergeneratedcontent.net";
const THUMB_HOST = "tn.gold-usergeneratedcontent.net";
const ORIGIN = "https://hitomi.la";

type Named = Record<string, unknown>;

// [list key in galleryinfo, name key inside each entry, entity kind, URL segment]
const LISTS: [string, string, EntityKind, string][] = [
  ["artists", "artist", "artists", "artist"],
  ["groups", "group", "groups", "group"],
  ["parodys", "parody", "parodies", "series"],
  ["characters", "character", "characters", "character"],
];

const isTruthyFlag = (v: unknown) => v === 1 || v === "1" || v === true;

// The site's own page for an entity: the entry's `url` when it is a site path,
// otherwise the same shape derived from the name.
function link(url: unknown, segment: string, name: string): string {
  if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) return `${ORIGIN}${url}`;
  return `${ORIGIN}/${segment}/${encodeURIComponent(name)}-all.html`;
}

export function parseGalleryInfo(body: string, id: string): ScrapeResult {
  let info: Named;
  try {
    info = JSON.parse(body.slice(body.indexOf("=") + 1).trim().replace(/;\s*$/, ""));
  } catch {
    throw new ScrapeError(`Hitomi returned an unreadable answer for ${id}`, "TIMEOUT");
  }
  if (!info || typeof info !== "object" || String(info.id) !== id) {
    throw new ScrapeError(`Gallery ${id} not found on Hitomi`, "NOT_FOUND");
  }

  const title = clip(String(info.title ?? "").trim() || String(info.japanese_title ?? "").trim());
  if (!title) throw new ScrapeError(`Hitomi gave no title for ${id}`, "TIMEOUT");

  const bag = new EntityBag();
  for (const [key, field, kind, segment] of LISTS) {
    for (const e of Array.isArray(info[key]) ? (info[key] as Named[]) : []) {
      const name = typeof e?.[field] === "string" ? (e[field] as string) : "";
      if (name) bag.add(kind, name, link(e.url, segment, name));
    }
  }
  // Tags carry a female/male flag instead of a namespace in the name. The flag
  // is dropped from the name (as e-hentai's namespace is) and kept in the link.
  for (const t of Array.isArray(info.tags) ? (info.tags as Named[]) : []) {
    const name = typeof t?.tag === "string" ? t.tag : "";
    if (!name) continue;
    const ns = isTruthyFlag(t.female) ? "female:" : isTruthyFlag(t.male) ? "male:" : "";
    bag.add("tags", name, link(t.url, "tag", `${ns}${name}`));
  }

  const files = Array.isArray(info.files) ? (info.files as Named[]) : [];
  const hash = typeof files[0]?.hash === "string" ? files[0].hash.toLowerCase() : "";
  const cover = /^[0-9a-f]{64}$/.test(hash)
    ? `https://${THUMB_HOST}/webpbigtn/${hash.slice(-1)}/${hash.slice(-3, -1)}/${hash}.webp`
    : "";

  return {
    source: "hitomi",
    source_id: id,
    title_name: title,
    image_link: coverOrEmpty("hitomi", cover, ORIGIN),
    pages: files.length,
    // "2023-04-20 01:23:00-05": when the gallery was added to Hitomi — the
    // same moment nhentai's upload date marks.
    uploaded_at: isoDay(typeof info.date === "string" ? info.date : null),
    ...bag.result(),
  };
}

export const hitomi: SiteAdapter = {
  // The resource host checks where the request claims to come from.
  request: (id) => ({
    url: `https://${RESOURCE_HOST}/galleries/${id}.js`,
    headers: { Referer: `${ORIGIN}/`, Origin: ORIGIN },
  }),
  fetchHosts: [RESOURCE_HOST],
  isComplete: (body) => body.includes("galleryinfo"),
  parse: parseGalleryInfo,
};
