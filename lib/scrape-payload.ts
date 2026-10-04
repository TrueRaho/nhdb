// The shape of one scraped title, and the gate every copy of it passes before it
// is stored or handed to the browser.
//
// Payloads reach the app from three places the server does not control: a
// user's own scraper host (any version, possibly modified), the browser (a
// commit sends back what it was shown), and the in-process scraper. So the
// write boundary re-derives a clean object instead of trusting one: unknown
// keys are dropped, the title must belong to a supported site under a
// canonical id, the cover must sit on that site's image hosts, every entity
// link must point at the site itself, and every string fits its column. The
// result is a title — never an arbitrary link or blob.
//
// Client-safe (no node imports), like lib/sources.ts.

import { isAllowedImageUrl, isSourceId, isSourceLink, SOURCES, type SourceId, type TitleRef } from "./sources";

export interface ScrapeEntity {
  name: string;
  link: string;
  total_works: number;
}

// alter_name is intentionally absent: it is a user-managed custom name,
// never collected by the scraper.
export interface ScrapeResult {
  source: SourceId;
  /** Canonical id on that site (lib/sources.ts `normalizeId`). */
  source_id: string;
  title_name: string;
  /** Cover URL on one of the site's image hosts, or "" when there is none. */
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
const MAX_PAGES = 100_000;
const MAX_INT4 = 2_147_483_647;
// nhentai's busiest galleries carry ~60 tags; anything near this is not a title.
export const MAX_ENTITIES_PER_KIND = 200;

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
 * already lowercase ("big breasts", "penqech"), and the other sites write the
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

// Older scraper hosts (and jobs saved by an older browser tab) speak the
// nhentai-only shape: `hashtag` and no source. Read that as what it was.
function sourceOf(raw: Record<string, unknown>): { source: SourceId; id: string } {
  if (raw.source === undefined && raw.source_id === undefined) {
    const h = raw.hashtag;
    if (typeof h === "number" && Number.isInteger(h) && h > 0) return { source: "nhentai", id: String(h) };
    return fail(`hashtag must be a positive integer, got ${String(h)}`);
  }
  if (!isSourceId(raw.source)) return fail(`unsupported source ${JSON.stringify(raw.source)}`);
  if (typeof raw.source_id !== "string") return fail("source_id must be a string");
  return { source: raw.source, id: raw.source_id };
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

function entities(source: SourceId, kind: EntityKind, v: unknown): ScrapeEntity[] {
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
    if (!isSourceLink(source, e.link)) {
      return fail(`${kind} link ${JSON.stringify(e.link.slice(0, 80))} is not a ${SOURCES[source].name} page`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, link: e.link, total_works: e.total_works });
  }
  return out;
}

/** Validate and normalize a scraped title. Throws ScrapePayloadError. */
export function parseScrapePayload(raw: unknown): ScrapeResult {
  if (!isObject(raw)) return fail("expected an object");
  const { source, id } = sourceOf(raw);
  const source_id = SOURCES[source].normalizeId(id);
  if (!source_id || source_id !== id) return fail(`${JSON.stringify(id)} is not a ${SOURCES[source].name} title id`);
  // Legacy payloads carry both; a hashtag naming a different gallery is a lie.
  if (source === "nhentai" && raw.hashtag !== undefined && raw.hashtag !== Number(source_id)) {
    return fail("hashtag does not match source_id");
  }

  if (typeof raw.title_name !== "string") return fail("title_name must be a string");
  const title_name = cleanText(raw.title_name);
  if (!title_name || title_name.length > MAX_TEXT) {
    return fail(`title_name must be 1–${MAX_TEXT} characters`);
  }

  if (typeof raw.image_link !== "string") return fail("image_link must be a string");
  if (raw.image_link !== "" && !isAllowedImageUrl(source, raw.image_link)) {
    return fail(`image_link is not on a ${SOURCES[source].name} image host`);
  }

  if (!isCount(raw.pages) || raw.pages > MAX_PAGES) {
    return fail(`pages must be an integer between 0 and ${MAX_PAGES}, got ${String(raw.pages)}`);
  }

  return {
    source,
    source_id,
    title_name,
    image_link: raw.image_link,
    pages: raw.pages,
    uploaded_at: uploadDate(raw.uploaded_at),
    tags: entities(source, "tags", raw.tags),
    artists: entities(source, "artists", raw.artists),
    groups: entities(source, "groups", raw.groups),
    characters: entities(source, "characters", raw.characters),
    parodies: entities(source, "parodies", raw.parodies),
  };
}

/** Which title a (validated) payload describes. */
export function scrapedRef(s: Pick<ScrapeResult, "source" | "source_id">): TitleRef {
  return { source: s.source, id: s.source_id };
}
