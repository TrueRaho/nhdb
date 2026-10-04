// E-Hentai: the site's public JSON API (`gdata`), not the gallery page. The API
// is documented, unthrottled for single lookups, and has answered in the same
// shape for over a decade — a markup scrape would buy nothing but drift.
//
//   POST https://api.e-hentai.org/api.php
//   {"method":"gdata","gidlist":[[899557,"edd545586a"]],"namespace":1}
//   → {"gmetadata":[{"gid":899557,"token":"edd545586a","title":"…","thumb":"…",
//      "posted":"1376143500","filecount":"20","tags":["artist:…","female:…",…]}]}

import type { EntityKind, ScrapeResult } from "../scrape-payload";
import { SOURCES } from "../sources";
import {
  coverOrEmpty, decodeEntities, EntityBag, isoDayFromUnix, prettyTitle, ScrapeError, type SiteAdapter,
} from "./common";

const API_URL = "https://api.e-hentai.org/api.php";
const ORIGIN = "https://e-hentai.org";

// Namespaced tags → entity kinds. "female:", "male:", "mixed:", "other:" and
// "location:" are content tags; the namespace is dropped from the name so that
// "female:big breasts" files under the same "big breasts" the other sites use.
// language/reclass/cosplayer/temp describe the upload, not the work — skipped,
// just as the nhentai adapter skips its Languages row.
const NAMESPACES: Record<string, EntityKind> = {
  artist: "artists",
  group: "groups",
  parody: "parodies",
  character: "characters",
  female: "tags",
  male: "tags",
  mixed: "tags",
  other: "tags",
  location: "tags",
  misc: "tags",
};

// e-hentai.org/tag/female:big+breasts — the site's own tag page.
function tagLink(ns: string, name: string): string {
  const path = name.split(" ").map(encodeURIComponent).join("+");
  return `${ORIGIN}/tag/${ns === "misc" ? path : `${ns}:${path}`}`;
}

export function parseGdata(body: string, id: string): ScrapeResult {
  const [gid, token] = id.split("/");
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ScrapeError(`E-Hentai returned an unreadable answer for ${gid}`, "TIMEOUT");
  }
  const g = (data as { gmetadata?: Record<string, unknown>[] })?.gmetadata?.[0];
  // A wrong token comes back as {"gid":…,"error":"Key missing, or incorrect key provided."}.
  if (!g || g.error || String(g.gid) !== gid || g.token !== token) {
    throw new ScrapeError(`Gallery ${gid} not found on E-Hentai`, "NOT_FOUND");
  }

  const title = prettyTitle(decodeEntities(String(g.title ?? ""))) ||
    prettyTitle(decodeEntities(String(g.title_jpn ?? "")));
  if (!title) throw new ScrapeError(`E-Hentai gave no title for ${gid}`, "TIMEOUT");

  const bag = new EntityBag();
  for (const raw of Array.isArray(g.tags) ? g.tags : []) {
    if (typeof raw !== "string") continue;
    const sep = raw.indexOf(":");
    const ns = sep > 0 ? raw.slice(0, sep) : "misc";
    const name = sep > 0 ? raw.slice(sep + 1) : raw;
    const kind = NAMESPACES[ns];
    if (kind) bag.add(kind, name, tagLink(ns, name.trim()));
  }

  const pages = Number.parseInt(String(g.filecount ?? ""), 10);
  return {
    source: "ehentai",
    source_id: id,
    title_name: title,
    image_link: coverOrEmpty("ehentai", typeof g.thumb === "string" ? g.thumb : "", ORIGIN),
    pages: Number.isSafeInteger(pages) && pages > 0 ? pages : 0,
    uploaded_at: isoDayFromUnix(g.posted),
    ...bag.result(),
  };
}

export const ehentai: SiteAdapter = {
  request: (id) => {
    const [gid, token] = id.split("/");
    return {
      url: API_URL,
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: `${SOURCES.ehentai.url(id)}` },
      body: JSON.stringify({ method: "gdata", gidlist: [[Number(gid), token]], namespace: 1 }),
    };
  },
  fetchHosts: ["api.e-hentai.org"],
  isComplete: (body) => body.trimStart().startsWith("{"),
  parse: parseGdata,
};
