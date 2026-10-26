// The shape of one scraped title, and the gate every copy of it passes before it
// is stored or handed to the browser.
//
// Payloads reach the app from three places the server does not control: a
// user's own scraper host (any version, possibly modified), the browser (a
// commit sends back what it was shown), and the in-process scraper. So the
// write boundary re-derives a clean object instead of trusting one: unknown
// keys are dropped; the site is a host name (or a legacy key) and the id is the
// one lib/sources.ts finds in the title's own address, on that site; the cover
// is a web address; an entity link that leaves the title's site is dropped; and
// every string fits its column. Which sites may be added is no longer a list —
// what makes a page a title is decided by the scraper reading it.
//
// Client-safe (no node imports), like lib/sources.ts.

import {
  galleryIdOf, isSameSite, isSourceKey, legacyUrl, MAX_URL, parseWebUrl, siteHost, siteKey, type TitleKey,
} from "./sources";

export interface ScrapeEntity {
  name: string;
  link: string;
  total_works: number;
}

// alter_name is intentionally absent: it is a user-managed custom name,
// never collected by the scraper.
export interface ScrapeResult {
  /** The site: its host name, or a legacy key (lib/sources.ts). */
  source: string;
  /** The gallery id in the title's address (lib/sources.ts `galleryIdOf`). */
  source_id: string;
  /** The page the title is read at, on that site. */
  url: string;
  title_name: string;
  /** Cover address, or "" when there is none. */
  image_link: string;
  pages: number;
  /** YYYY-MM-DD, or null when the site does not say. Never fabricated. */
  uploaded_at: string | null;
  tags: ScrapeEntity[];
  artists: ScrapeEntity[];
  groups: ScrapeEntity[];
  characters: ScrapeEntity[];
  parodies: ScrapeEntity[];
}

export const ENTITY_KINDS = ["tags", "artists", "groups", "characters", "parodies"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

const MAX_TEXT = 255; // every name/link column is VARCHAR(255)
const MAX_ID = 255; // titles.source_id
const MAX_PAGES = 100_000;
const MAX_INT4 = 2_147_483_647;
// Measured corpus (56 pages, 44 galleries): tags max 24, other kinds max 3.
// 64 leaves room for busy galleries without accepting 1000 entity rows/title.
export const MAX_ENTITIES_PER_KIND = 64;

// Thrown for a malformed payload. `name` is "ValidationError" so the
// /api/scrape route maps it to HTTP 400 (not 500) — matching on the message
// would misfire on Prisma errors, whose messages often contain "Invalid".
export class ScrapePayloadError extends Error {
  name = "ValidationError";
}

const fail = (msg: string): never => {
  throw new ScrapePayloadError(`Invalid scrape payload: ${msg}`);
};

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Collapse whitespace and drop control characters. */
export function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(CONTROL, "").trim();
}

/**
 * One spelling per entity, whichever site it came from: nhentai's vocabulary is
 * already lowercase ("big breasts", "some artist"), and the other sites write the
 * same names capitalized or in full-width forms. Folding them here is what lets
 * a tag filter, the stats, related tags and ghost tags see one "big breasts"
 * across sources instead of three.
 */
export function normalizeEntityName(raw: string): string {
  return cleanText(raw.normalize("NFKC")).toLowerCase();
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT4;

// Older scraper hosts (and jobs saved by an older browser tab) speak older
// shapes: the nhentai-only one (`hashtag`, no source) and the seven-site one
// (a legacy key, no url). Both are read as what they were.
function sourceOf(raw: Record<string, unknown>): { source: string; id: string; url: string } {
  if (raw.source === undefined && raw.source_id === undefined) {
    const h = raw.hashtag;
    if (typeof h === "number" && Number.isInteger(h) && h > 0 && h < 1_000_000_000) {
      return { source: "nhentai", id: String(h), url: legacyUrl("nhentai", String(h))! };
    }
    return fail(`hashtag must be a positive integer, got ${String(h)}`);
  }
  if (!isSourceKey(raw.source)) return fail(`${JSON.stringify(raw.source)} is not a site`);
  if (typeof raw.source_id !== "string" || !raw.source_id || raw.source_id.length > MAX_ID || /\s/.test(raw.source_id)) {
    return fail("source_id must be a non-empty string without spaces");
  }
  const source = raw.source;
  // nhentai's id IS the row's hashtag (migration 9): a number below 1e9.
  if (source === "nhentai" && !(/^\d{1,9}$/.test(raw.source_id) && Number(raw.source_id) > 0)) {
    return fail(`${JSON.stringify(raw.source_id)} is not an nhentai gallery id`);
  }
  const fallback = legacyUrl(source, raw.source_id);
  const url = raw.url === undefined && fallback ? fallback : raw.url;
  const page = parseWebUrl(url);
  if (!page) return fail("url must be the title's http(s) address");
  if (siteKey(page.hostname) !== source) return fail(`url is not on ${siteHost(source)}`);
  // The id is the one the address names — a payload cannot file one title's
  // data under another title's id.
  if (galleryIdOf(page) !== raw.source_id) return fail(`url does not name ${JSON.stringify(raw.source_id)}`);
  return { source, id: raw.source_id, url: page.toString() };
}

function uploadDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return fail("uploaded_at must be a date string or null");
  const t = Date.parse(v);
  if (Number.isNaN(t)) return fail(`uploaded_at is not a valid date, got ${v}`);
  const iso = new Date(t).toISOString().slice(0, 10);
  const year = Number(iso.slice(0, 4));
  if (year < 1970 || year > 2100) return fail(`uploaded_at is out of range, got ${v}`);
  return iso;
}

// An entity link is kept only when it is a web address on the title's own site;
// anything else (another site, javascript:, too long) is dropped and the
// entity kept without one — one odd link is not worth refusing the title.
function siteLink(pageHost: string, raw: string): string {
  const url = parseWebUrl(raw);
  return url && raw.length <= MAX_TEXT && isSameSite(url.hostname, pageHost) ? raw : "";
}

function entities(pageHost: string, kind: EntityKind, v: unknown): ScrapeEntity[] {
  if (!Array.isArray(v)) return fail(`${kind} must be an array`);
  if (v.length > MAX_ENTITIES_PER_KIND) return fail(`${kind} has more than ${MAX_ENTITIES_PER_KIND} entries`);
  const out: ScrapeEntity[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (!isObject(e) || typeof e.name !== "string" || typeof e.link !== "string" || !isCount(e.total_works)) {
      return fail(`${kind} contains an invalid entity`);
    }
    const name = normalizeEntityName(e.name);
    if (!name || name.length > MAX_TEXT) return fail(`${kind} contains an empty or oversized name`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, link: siteLink(pageHost, e.link), total_works: e.total_works });
  }
  return out;
}

/** Validate and normalize a scraped title. Throws ScrapePayloadError. */
export function parseScrapePayload(raw: unknown): ScrapeResult {
  if (!isObject(raw)) return fail("expected an object");
  const { source, id: source_id, url } = sourceOf(raw);
  // Legacy payloads carry both; a hashtag naming a different gallery is a lie.
  if (source === "nhentai" && raw.hashtag !== undefined && raw.hashtag !== Number(source_id)) {
    return fail("hashtag does not match source_id");
  }
  const pageHost = new URL(url).hostname;

  if (typeof raw.title_name !== "string") return fail("title_name must be a string");
  const title_name = cleanText(raw.title_name);
  if (!title_name || title_name.length > MAX_TEXT) {
    return fail(`title_name must be 1–${MAX_TEXT} characters`);
  }

  if (typeof raw.image_link !== "string") return fail("image_link must be a string");
  if (raw.image_link !== "" && (!parseWebUrl(raw.image_link) || raw.image_link.length > MAX_URL)) {
    return fail("image_link must be an http(s) address");
  }

  if (!isCount(raw.pages) || raw.pages > MAX_PAGES) {
    return fail(`pages must be an integer between 0 and ${MAX_PAGES}, got ${String(raw.pages)}`);
  }

  return {
    source,
    source_id,
    url,
    title_name,
    image_link: raw.image_link,
    pages: raw.pages,
    uploaded_at: uploadDate(raw.uploaded_at),
    tags: entities(pageHost, "tags", raw.tags),
    artists: entities(pageHost, "artists", raw.artists),
    groups: entities(pageHost, "groups", raw.groups),
    characters: entities(pageHost, "characters", raw.characters),
    parodies: entities(pageHost, "parodies", raw.parodies),
  };
}

/** Which title a (validated) payload describes. */
export function scrapedRef(s: Pick<ScrapeResult, "source" | "source_id">): TitleKey {
  return { source: s.source, id: s.source_id };
}
