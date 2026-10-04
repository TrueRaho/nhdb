// The sites a title can come from, and the only shapes their addresses may take.
//
// Everything that turns user input into "a title to scrape" goes through here:
// the add box, the `?add=` deep link, the `/add/<link>` share target, the
// /api/scrape route and the scraper host. Recognition is an ALLOW-LIST of
// gallery-page patterns, one set per site — a search page, a tag page, a home
// page or a link to anywhere else matches nothing and is dropped. The id is
// pulled out of the match and the address the scraper actually fetches is
// rebuilt from it (`sourceUrl`), so a pasted URL never reaches a fetch as-is:
// whatever surrounded the id (another host, a query string, a path that
// redirects elsewhere) is gone.
//
// Client-safe on purpose (no node imports): the browser parses pastes with it.

export const SOURCE_IDS = [
  "nhentai",
  "ehentai",
  "hitomi",
  "hentaifox",
  "imhentai",
  "pururin",
  "hentai2read",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/** One title on one site. `id` is canonical — see `SourceDef.normalizeId`. */
export interface TitleRef {
  source: SourceId;
  id: string;
}

interface SourceDef {
  /** Display name. */
  name: string;
  /** Compact label for badges. */
  short: string;
  /** Hosts the site serves pages from. Entity links must point at one of them. */
  hosts: readonly string[];
  /**
   * Hosts covers may be loaded from, in next/image `remotePatterns` syntax
   * (`*.` = exactly one subdomain label). next.config.ts lists the same set —
   * lib/sources.test.ts keeps the two in step — so a stored cover is always one
   * the image optimizer will serve.
   */
  imageHosts: readonly string[];
  /** Gallery-page addresses, matched anywhere inside a token. Global regexes. */
  patterns: readonly RegExp[];
  /** A match → the canonical id, or null when the captured value is not one. */
  idFromMatch(m: RegExpMatchArray): string | null;
  /** A raw id (from `source:id` text or a stored row) → canonical, or null. */
  normalizeId(raw: string): string | null;
  /** The gallery page a reader opens, and the page the scraper starts from. */
  url(id: string): string;
}

// A positive decimal id, leading zeros dropped. Capped at nine digits: the
// database keeps nhentai ids below 1e9 (the range above is where titles from
// the other sites get their internal keys — see migration 9).
function numericId(raw: string | undefined): string | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n < 1_000_000_000 ? String(n) : null;
}

// hentai2read addresses a title by slug, not number, so its pattern is the one
// place a bare path segment counts. Slugs are lowercase words joined by
// underscores; the site's own sections use hyphens (`hentai-list`) and fall
// out of the pattern, and the single-word ones are listed here. The scraper
// still refuses a page without the title markup, so a section missing from
// this list fails as "not a title" instead of being stored.
const H2R_RESERVED = new Set([
  "about", "account", "admin", "api", "artist", "artists", "assets", "author",
  "authors", "blog", "bookmark", "bookmarks", "categories", "category", "cdn",
  "comments", "contact", "css", "dmca", "doujinshi", "faq", "feed", "forum",
  "help", "hentai", "home", "images", "img", "index", "js", "latest", "list",
  "login", "logout", "manga", "new", "news", "page", "popular", "privacy",
  "profile", "random", "read", "reader", "register", "rss", "search", "settings",
  "sitemap", "static", "support", "tag", "tags", "terms", "top", "upload",
  "uploads", "user", "users",
]);

function h2rSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  const slug = raw.toLowerCase();
  if (slug.length > 120 || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug)) return null;
  return H2R_RESERVED.has(slug) ? null : slug;
}

export const SOURCES: Record<SourceId, SourceDef> = {
  nhentai: {
    name: "nhentai",
    short: "nh",
    hosts: ["nhentai.net"],
    // t.nhentai.net, t1–t7, i, i1–i5 — any single-label subdomain
    imageHosts: ["*.nhentai.net"],
    patterns: [/nhentai\.net\/g\/(\d+)/gi],
    idFromMatch: (m) => numericId(m[1]),
    normalizeId: (raw) => numericId(raw.replace(/^#/, "")),
    url: (id) => `https://nhentai.net/g/${id}/`,
  },
  ehentai: {
    name: "E-Hentai",
    short: "eh",
    hosts: ["e-hentai.org"],
    imageHosts: ["ehgt.org", "*.ehgt.org"],
    // A gallery is addressed by its numeric gid AND a 10-hex token; neither
    // alone opens it, so the canonical id carries both: "899557/edd545586a".
    patterns: [/e-hentai\.org\/(?:g|mpv)\/(\d+)\/([0-9a-f]{10})/gi],
    idFromMatch: (m) => {
      const gid = numericId(m[1]);
      return gid ? `${gid}/${m[2].toLowerCase()}` : null;
    },
    normalizeId: (raw) => {
      const m = raw.match(/^(\d+)\/([0-9a-f]{10})$/i);
      const gid = m ? numericId(m[1]) : null;
      return gid ? `${gid}/${m![2].toLowerCase()}` : null;
    },
    url: (id) => `https://e-hentai.org/g/${id}/`,
  },
  hitomi: {
    name: "Hitomi",
    short: "hitomi",
    hosts: ["hitomi.la"],
    imageHosts: ["*.gold-usergeneratedcontent.net", "*.hitomi.la"],
    // /galleries/123.html, /reader/123.html, and the slugged type pages
    // (/doujinshi/some-title-english-123.html) all end in "-<id>.html".
    patterns: [
      /hitomi\.la\/(?:galleries|reader|doujinshi|manga|cg|gamecg|imageset|anime)\/(?:[^/?#\s]*-)?(\d+)\.html/gi,
    ],
    idFromMatch: (m) => numericId(m[1]),
    normalizeId: (raw) => numericId(raw),
    url: (id) => `https://hitomi.la/galleries/${id}.html`,
  },
  hentaifox: {
    name: "HentaiFox",
    short: "hfox",
    hosts: ["hentaifox.com"],
    imageHosts: ["*.hentaifox.com"],
    // /gallery/<id>/ is the title page, /g/<id>/<page>/ the reader.
    patterns: [/hentaifox\.com\/(?:gallery|g)\/(\d+)/gi],
    idFromMatch: (m) => numericId(m[1]),
    normalizeId: (raw) => numericId(raw),
    url: (id) => `https://hentaifox.com/gallery/${id}/`,
  },
  imhentai: {
    name: "IMHentai",
    short: "imh",
    hosts: ["imhentai.xxx"],
    imageHosts: ["*.imhentai.xxx"],
    // /gallery/<id>/ is the title page, /view/<id>/<page>/ the reader.
    patterns: [/imhentai\.xxx\/(?:gallery|view)\/(\d+)/gi],
    idFromMatch: (m) => numericId(m[1]),
    normalizeId: (raw) => numericId(raw),
    url: (id) => `https://imhentai.xxx/gallery/${id}/`,
  },
  pururin: {
    name: "Pururin",
    short: "pururin",
    hosts: ["pururin.me"],
    imageHosts: ["*.pururin.me"],
    // pururin.to / .io are the site's former domains; the ids carried over.
    patterns: [/pururin\.(?:me|to|io)\/(?:gallery|read)\/(\d+)/gi],
    idFromMatch: (m) => numericId(m[1]),
    normalizeId: (raw) => numericId(raw),
    // The route wants a slug segment and does not check it — "x" is what the
    // long-standing gallery-dl extractor used.
    url: (id) => `https://pururin.me/gallery/${id}/x`,
  },
  hentai2read: {
    name: "Hentai2Read",
    short: "h2r",
    hosts: ["hentai2read.com"],
    imageHosts: ["*.hentaicdn.com"],
    // The title page is /<slug>/; a chapter (/<slug>/<n>/) belongs to it.
    patterns: [/hentai2read\.com\/([a-z0-9_]+)(?=[/?#\s"')\]]|$)/gi],
    idFromMatch: (m) => h2rSlug(m[1]),
    normalizeId: (raw) => h2rSlug(raw),
    url: (id) => `https://hentai2read.com/${id}/`,
  },
};

export function isSourceId(v: unknown): v is SourceId {
  return typeof v === "string" && (SOURCE_IDS as readonly string[]).includes(v);
}

/** `source:id` — the one string form of a ref (job keys, the scrape route's input). */
export function refKey(ref: TitleRef): string {
  return `${ref.source}:${ref.id}`;
}

/** Where a reader opens the title. */
export function sourceUrl(ref: TitleRef): string {
  return SOURCES[ref.source].url(ref.id);
}

/** Compact human label: "#177013" for nhentai (as ever), "eh 899557", "hitomi 1234567"… */
export function refLabel(ref: TitleRef): string {
  if (ref.source === "nhentai") return `#${ref.id}`;
  const id = ref.source === "ehentai" ? ref.id.split("/")[0] : ref.id;
  return `${SOURCES[ref.source].short} ${id}`;
}

/** A ref from stored/sent parts, or null when they do not form a canonical one. */
export function toTitleRef(source: unknown, id: unknown): TitleRef | null {
  if (!isSourceId(source) || typeof id !== "string") return null;
  const canonical = SOURCES[source].normalizeId(id);
  return canonical ? { source, id: canonical } : null;
}

// Every gallery link inside one token, in the order they appear. matchAll, not
// match: a share-sheet shortcut that appends links without a separator hands
// over one token holding several URLs back to back
// ("…/g/837933/https://nhentai.net/g/177013/"), and taking only the first
// match would silently drop every title but one.
function linksIn(text: string): TitleRef[] {
  const found: { at: number; ref: TitleRef }[] = [];
  for (const source of SOURCE_IDS) {
    const def = SOURCES[source];
    for (const pattern of def.patterns) {
      for (const m of text.matchAll(pattern)) {
        const id = def.idFromMatch(m);
        if (id) found.push({ at: m.index ?? 0, ref: { source, id } });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.ref);
}

const REF_TEXT = /^([a-z0-9]+):(\S+)$/;

/**
 * One title from one piece of input: "177013" / "#177013" (nhentai, as ever),
 * a `source:id` ref, or a gallery link from any supported site. Null for
 * anything else — including links to supported sites that are not a title
 * (search, tag and listing pages).
 */
export function parseTitleRef(input: string): TitleRef | null {
  const t = input.trim();
  if (/^#?\d+$/.test(t)) return toTitleRef("nhentai", t.replace(/^#/, ""));
  const asRef = t.match(REF_TEXT);
  if (asRef && isSourceId(asRef[1])) return toTitleRef(asRef[1], asRef[2]);
  return linksIn(t)[0] ?? null;
}

// Pull every title out of an arbitrary blob of text, in paste order, deduped.
// This is the *batch* counterpart to parseTitleRef: the add box is filled by
// pasting far more often than by typing, and iOS Safari's "Copy Links" (tab
// overview → long-press "N Tabs" → Copy Links) dumps every open tab at once,
// interleaving page TITLES with the URLs. Splitting such a dump into tokens and
// parsing each one whole turned every word of every title into its own bogus
// entry.
//
// A gallery link is unambiguous and always counts, whatever the id's length.
// Bare numbers (nhentai ids) are trusted only as far as their company allows:
// when every token is a number the box was typed by hand, so any digit run
// counts; as soon as prose is mixed in it is a paste, where stray digits are
// page counts, years and chapter numbers, so only id-shaped runs (5-7 digits)
// survive. Consequence: a pre-10000 gallery inside a paste has to arrive as a
// URL, not a bare number.
export function parseInputs(text: string): TitleRef[] {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const typedByHand = tokens.every((t) => /^#?\d+$/.test(t));
  const bare = typedByHand ? /^#?(\d+)$/ : /^#?(\d{5,7})$/;
  const refs: TitleRef[] = [];
  const seen = new Set<string>();

  const push = (ref: TitleRef | null) => {
    if (!ref) return;
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  // One left-to-right pass over the tokens keeps the output in paste order. A
  // link is matched anywhere inside its token, so surrounding punctuation
  // (markdown link syntax, a trailing slash, quotes) is fine.
  for (const token of tokens) {
    const links = linksIn(token);
    if (links.length > 0) {
      links.forEach(push);
      continue;
    }
    const asRef = token.match(REF_TEXT);
    if (asRef && isSourceId(asRef[1])) {
      push(toTitleRef(asRef[1], asRef[2]));
      continue;
    }
    const m = token.match(bare);
    if (m) push(toTitleRef("nhentai", m[1]));
  }
  return refs;
}

// Query param that queues titles straight from a link: `/?add=177013,895243`.
// Kept short because it is typed into an iOS Shortcut by hand.
export const ADD_PARAM = "add";

// Titles carried by an `?add=` deep link, given a location.search string.
// URLSearchParams does the percent-decoding, so the param may hold bare ids, a
// comma/space separated list, or whole encoded gallery URLs — parseInputs
// treats all three the same way it treats a paste. Repeats (`?add=1&add=2`) are
// joined rather than dropped, since a share-sheet shortcut may append instead
// of building one value.
export function readAddParam(search: string): TitleRef[] {
  const raw = new URLSearchParams(search).getAll(ADD_PARAM).join(" ");
  return raw ? parseInputs(raw) : [];
}

// ---------------------------------------------------------------------------
// What a stored title may point at
// ---------------------------------------------------------------------------

/** `*.example.com` = exactly one label in front; `**.` = one or more; else exact. */
export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  if (pattern.startsWith("**.")) {
    const base = pattern.slice(3);
    return h.endsWith(`.${base}`) && h.length > base.length + 1;
  }
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    if (!h.endsWith(`.${base}`)) return false;
    const label = h.slice(0, -(base.length + 1));
    return label.length > 0 && !label.includes(".");
  }
  return h === pattern;
}

// A plain https URL: no credentials, no custom port, at most 255 characters
// (the column width). Anything else is not a link this app stores.
function plainHttps(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url;
}

/** A cover on one of the site's image hosts. */
export function isAllowedImageUrl(source: SourceId, raw: string): boolean {
  const url = plainHttps(raw);
  return !!url && SOURCES[source].imageHosts.some((p) => hostMatches(p, url.hostname));
}

/** A link to a page of the site itself (an artist, a tag…). */
export function isSourceLink(source: SourceId, raw: string): boolean {
  const url = plainHttps(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return SOURCES[source].hosts.includes(host);
}

/** Every cover host, for next.config.ts and the test that keeps it in sync. */
export function allImageHosts(): string[] {
  return [...new Set(SOURCE_IDS.flatMap((s) => SOURCES[s].imageHosts))];
}
