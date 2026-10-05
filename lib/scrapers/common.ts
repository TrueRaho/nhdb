// What the scraper's layers share: the error type and the small text helpers
// that turn a page's markup into the common ScrapeResult.

import { cleanText, MAX_ENTITIES_PER_KIND, normalizeEntityName, type EntityKind, type ScrapeEntity } from "../scrape-payload";

export class ScrapeError extends Error {
  constructor(message: string, public code: "BAD_INPUT" | "CLOUDFLARE" | "NOT_FOUND" | "TIMEOUT") {
    super(message);
    this.name = "ScrapeError";
  }
}

// Cloudflare interstitials served instead of the real page.
export function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("attention required") ||
    head.includes("cf-browser-verification") ||
    head.includes("challenge-platform")
  );
}

/** A whole HTML document, as opposed to an empty body or a JSON error. */
export const looksLikeHtml = (body: string) => /<body[\s>]|<html[\s>]/i.test(body);

const TITLE_MAX = 255;

/** Cut to the column width without splitting a surrogate pair. */
export function clip(s: string, max = TITLE_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// "(C92) [Quill Rycm (Quill Tjgk)] Morning Ledger Fqkgbiq (Quill Rfns) [English]"
// → "Morning Ledger Fqkgbiq". The bracketed lead (event, circle, artist) and tail
// (parody, language, scanlator) are what nhentai keeps out of its `.pretty`
// title, and they are already stored as entities. A title that is nothing
// but brackets is returned as it was rather than emptied.
const GROUP = String.raw`(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|\[[^\]]*\]|\{[^}]*\}|【[^】]*】)`;
const LEAD = new RegExp(String.raw`^\s*(?:${GROUP}\s*)+`);
const TAIL = new RegExp(String.raw`(?:\s*${GROUP})+\s*$`);

export function prettyTitle(raw: string): string {
  const text = cleanText(raw);
  const pretty = text.replace(LEAD, "").replace(TAIL, "").trim();
  return clip(pretty || text);
}

/** "12,345" → 12345, "1.2K" → 1200; anything unreadable → 0. */
export function parseCount(raw: string | undefined): number {
  const m = (raw ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return 0;
  const scale = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1_000 : 1;
  const n = Math.round(parseFloat(m[1]) * scale);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A calendar day from whatever a site prints, or null. A literal Y-M-D is taken
 * as written (no timezone round trip to shift it); prose dates ("April 1,
 * 2020") go through Date.parse, which reads them as local time, so local
 * getters give the day back unchanged.
 */
export function isoDay(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let y: number, mo: number, d: number;
  const ymd = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymd) {
    [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  } else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    const date = new Date(t);
    [y, mo, d] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || y < 1970 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Unix seconds → calendar day (UTC). */
export function isoDayFromUnix(seconds: unknown): string | null {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return isoDay(new Date(n * 1000).toISOString().slice(0, 10));
}

/** Resolve a (relative, protocol-relative or absolute) href to https. "" when unusable. */
export function absoluteUrl(href: string | undefined, origin: string): string {
  if (!href) return "";
  try {
    const url = new URL(href.trim(), origin);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Collects a title's entities: names normalized, one row per name per kind. */
export class EntityBag {
  private readonly lists: Record<EntityKind, ScrapeEntity[]> = {
    tags: [], artists: [], groups: [], characters: [], parodies: [],
  };
  private readonly seen = new Set<string>();

  add(kind: EntityKind, rawName: string, link: string, total_works = 0): void {
    const name = clip(normalizeEntityName(rawName));
    const key = `${kind}\u0000${name}`;
    if (!name || this.seen.has(key) || this.lists[kind].length >= MAX_ENTITIES_PER_KIND) return;
    this.seen.add(key);
    // A link longer than its column could not be stored; the entity is kept
    // without one rather than the whole title failing over it.
    this.lists[kind].push({ name, link: link.length <= 255 ? link : "", total_works });
  }

  get size(): number {
    return Object.values(this.lists).reduce((n, l) => n + l.length, 0);
  }

  result(): Record<EntityKind, ScrapeEntity[]> {
    return this.lists;
  }
}

// Numeric and the handful of named entities JSON APIs leave in titles.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}
