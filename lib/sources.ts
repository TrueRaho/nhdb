// Where a title comes from — any gallery site, recognised by the shape of its
// address instead of a list of sites.
//
// A title's identity is (source, id):
//   source — the site: its host name without "www." ("hentaifox.com"). Seven
//            sites were known by name before the app could read any site, and
//            keep the short keys their rows were saved under ("nhentai",
//            "ehentai"…, see LEGACY) so those rows stay the same titles. That
//            is a naming table for old rows, not a list of what may be added.
//   id     — the part of the gallery's address that names it on its site,
//            found by `galleryIdOf` from patterns gallery engines share: a path
//            word like /g/ /gallery/ /view/ followed by a number or slug, a
//            long number, a slug ending in one, an ?id= query.
// The page address itself is kept with the title (`url`); nothing rebuilds one.
//
// What a page IS (a gallery, or a listing, a search, a login wall) is decided
// by the scraper reading it (lib/scrapers/extract.ts) — an address alone can
// only say "this could be a gallery". Client-safe (no node imports): the paste
// box parses with it.

/** A title, by where it comes from. */
export interface TitleKey {
  /** The site: a host name ("hentaifox.com") or a legacy key ("nhentai"). */
  source: string;
  /** The gallery's id on that site — see `galleryIdOf`. */
  id: string;
}

/** A title to scrape: its key plus the page to read it from. */
export interface TitleRef extends TitleKey {
  url: string;
}

// ---------------------------------------------------------------------------
// The seven sites with legacy keys
// ---------------------------------------------------------------------------

// Rows saved before the app read arbitrary sites carry these keys and ids in
// these shapes (an nhentai row's hashtag IS its id — migration 9). A new scrape
// of the same site must land on the same key, and the ids galleryIdOf finds
// for these sites' addresses are exactly the old ids (lib/sources.test.ts pins
// that), so only the key and the reader URL need a table.
const LEGACY: Record<string, { host: string; also?: readonly string[]; url: (id: string) => string }> = {
  nhentai: { host: "nhentai.net", url: (id) => `https://nhentai.net/g/${id}/` },
  ehentai: { host: "e-hentai.org", url: (id) => `https://e-hentai.org/g/${id}/` },
  hitomi: { host: "hitomi.la", url: (id) => `https://hitomi.la/galleries/${id}.html` },
  hentaifox: { host: "hentaifox.com", url: (id) => `https://hentaifox.com/gallery/${id}/` },
  imhentai: { host: "imhentai.xxx", url: (id) => `https://imhentai.xxx/gallery/${id}/` },
  // pururin.to / .io are the site's former domains; the ids carried over. The
  // route wants a slug segment and does not check it.
  pururin: { host: "pururin.me", also: ["pururin.to", "pururin.io"], url: (id) => `https://pururin.me/gallery/${id}/x` },
  // Since its 2026-10 redesign a title lives at /<type>/<number>-<slug>, and
  // /doujinshi/<number>… answers 301 with the right type. Rows saved before
  // keep their old slug key; that address redirects to the new one.
  hentai2read: {
    host: "hentai2read.com",
    url: (id) => /^\d+(?:-[a-z0-9-]+)?$/.test(id) ? `https://hentai2read.com/doujinshi/${id}` : `https://hentai2read.com/${id}/`,
  },
};

const LEGACY_BY_HOST = new Map(
  Object.entries(LEGACY).flatMap(([key, def]) => [def.host, ...(def.also ?? [])].map((h) => [h, key] as const)),
);

export const isLegacySource = (source: string): boolean => Object.hasOwn(LEGACY, source);

/** The address a legacy row's title is read at, or null for any other source. */
export function legacyUrl(source: string, id: string): string | null {
  return isLegacySource(source) ? LEGACY[source].url(id) : null;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** "www.HentaiFox.com" → "hentaifox.com"; a legacy site's host → its key. */
export function siteKey(hostname: string): string {
  let host = hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^(?:www\d*|m|mobile)\./, "");
  if (bare.includes(".")) host = bare;
  return LEGACY_BY_HOST.get(host) ?? host;
}

// A DNS name with a top-level label that has a letter in it — which also rules
// out an IPv4 literal ("127.0.0.1" would otherwise read as four labels).
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A key `siteKey` could have produced: a legacy key or a dotted host name. */
export function isSourceKey(v: unknown): v is string {
  return typeof v === "string" && (isLegacySource(v) || HOSTNAME.test(v));
}

/** The site's host name, for display and for "same site" checks. */
export function siteHost(source: string): string {
  return isLegacySource(source) ? LEGACY[source].host : source;
}

/** What the UI calls the site: its host name ("e-hentai.org", "hentaifox.com"). */
export const siteName = siteHost;

/** Do two hosts belong to one site? Equal, or one is a subdomain of the other. */
export function isSameSite(a: string, b: string): boolean {
  const x = siteHost(siteKey(a));
  const y = siteHost(siteKey(b));
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

// ---------------------------------------------------------------------------
// The gallery id inside an address
// ---------------------------------------------------------------------------

// Path words that introduce a title: what follows them names it.
// "/g/177013", "/gallery/42/", "/view/1200000/3/", "/galleries/1234567.html",
// "/doujinshi/some-title-1234567.html", "/manga/some-title/", "/m/S12345"…
const GALLERY_WORDS = new Set([
  "g", "gallery", "galleries", "view", "read", "reader", "mpv", "d", "doujin", "doujins", "doujinshi",
  "manga", "comic", "comics", "hentai", "album", "albums", "post", "posts", "title", "titles", "work",
  "works", "book", "books", "cg", "artistcg", "gamecg", "imageset", "original", "anime", "m", "item", "watch",
]);

// Path words of the pages AROUND titles — a tag's list, an artist's, a search.
// An address that starts with one is a list of titles, not a title.
const LISTING_WORDS = new Set([
  "tag", "tags", "tagged", "artist", "artists", "author", "authors", "group", "groups", "circle", "circles",
  "parody", "parodies", "series", "character", "characters", "category", "categories", "genre", "genres",
  "language", "languages", "lang", "search", "browse", "popular", "latest", "new", "random", "top",
  "ranking", "rankings", "user", "users", "uploader", "profile", "login", "logout", "register", "signup",
  "account", "favorites", "favourites", "bookmarks", "page", "index", "home", "list", "hentai-list",
  "manga-list", "manga-genre", "manga-author", "manga-artist", "manga-tag", "pairing", "type", "types",
  "content", "contents", "uploads", "info", "help", "about", "contact", "faq", "dmca", "terms", "privacy",
  "blog", "news", "forum", "forums", "rss", "feed", "sitemap", "api", "static", "assets", "cdn", "images",
  "img", "css", "js", "settings",
]);

// Only reserve these at the site root: /manga/comments/ can still name a work.
const SERVICE_PAGES = new Set([
  "watched", "torrents", "toplist", "discord", "comments", "advsearch", "hentai-lists",
]);

// Query parameters that carry a title's id on sites without clean paths. The
// last two are WordPress's: only ever numbers, and an id only on an address
// with no path ("/?p=123") — on "/some-title/?p=2" the p is a page number.
const ID_PARAMS = ["id", "gid", "g", "gallery", "galleryid", "gallery_id", "manga_id", "mid", "v", "post", "p"];
const NUMERIC_ONLY_PARAMS = new Set(["post", "p"]);

const MAX_ID = 128;

/** "000123" → "123"; null for anything but 1–12 digits with a value. */
function number(raw: string): string | null {
  if (!/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? String(n) : null;
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((s) => {
    let seg = s;
    try {
      seg = decodeURIComponent(s);
      // Keep escaped separators (and a literal escaped percent) in an id.
      // Decoding them into path/query syntax or replacing spaces by hyphens
      // would merge distinct gallery addresses.
      seg = seg.replace(/[ /?#%]/g, (c) => encodeURIComponent(c));
    } catch {
      // keep the raw segment
    }
    return seg.toLowerCase().replace(/\.(?:html?|php|aspx?|jsp)$/, "");
  });
}

const SLUG = /^[a-z0-9](?:[a-z0-9_.-]|%(?:20|2f|3f|23|25)){0,119}$/;

// The id a slug carries at its end: "some-title-english-1234567" → the number.
// A short tail ("-2") is part of the name, and so is a year: "summer-story-
// 2019" and "winter-story-2019" are two titles, never one id "2019". An
// underscore tail counts only after a gallery word ("/albums/some-title_456789/"):
// a lone underscore slug is a name ("/summer_festival_2019/", "/sister_1234/").
function tailId(seg: string, underscore: boolean): string | null {
  const tail = seg.match(underscore ? /[-_](\d{4,12})$/ : /-(\d{4,12})$/);
  if (!tail || /^(?:19|20)\d\d$/.test(tail[1])) return null;
  return number(tail[1]);
}

// One path segment as an id: a number, a slug that ends in an id (tailId), a
// letter-prefixed number ("s12345"), or — where slugs name titles — the slug
// itself.
function idOfSegment(seg: string, slugOk: boolean, afterGalleryWord = false): string | null {
  const n = number(seg);
  if (n) return n;
  const tail = tailId(seg, afterGalleryWord);
  if (tail) return tail;
  if (/^[a-z]\d{3,12}$/.test(seg)) return seg;
  // A gallery word on its own ("/manga/", "/hentai/") names a section, not a title.
  return slugOk && SLUG.test(seg) && !LISTING_WORDS.has(seg) && !GALLERY_WORDS.has(seg) ? seg : null;
}

/**
 * The gallery id in an address, or null when the address does not look like a
 * single title (a home page, a tag list, a search). Checked in order:
 *   1. after a gallery word: "/g/899557/edd545586a" → "899557/edd545586a" (a hex
 *      token right after a number is part of the id), "/gallery/42/" → "42";
 *   2. an id query parameter: "view.php?id=123" → "123";
 *   3. a long number anywhere in the path: "/12345/some-slug" → "12345";
 *   4. a lone slug, optionally followed by chapter and page numbers (up to two):
 *      "/lone_slug/" and "/lone_slug/1/5/" → "lone_slug".
 */
// A token after a gallery's number is part of its id: E-Hentai's is 10 hex
// characters, which can happen to be all digits ("899557/0123456789"); any
// other length must mix letters and digits, the way a random hex string does —
// so "/view/1200000/3/" stays a page number and a slug that happens to be spelt
// in hex letters ("/gallery/86334/facade", "decade", "beaded") stays a name.
const isToken = (seg: string | undefined): seg is string =>
  !!seg && (/^[0-9a-f]{10}$/.test(seg) || (/^[0-9a-f]{6,40}$/.test(seg) && /[a-f]/.test(seg) && /\d/.test(seg)));

export function galleryIdOf(url: URL): string | null {
  const path = url.pathname.split("/").filter(Boolean);
  let loneFile = path.length === 1 ? path[0] : "";
  try { loneFile = decodeURIComponent(loneFile); } catch { /* keep the raw path */ }
  // A file is not an HTML gallery, even when its query happens to contain id=.
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|xml|txt)$/i.test(loneFile)) return null;
  let segs = segments(url);
  if (segs.length === 1 && SERVICE_PAGES.has(segs[0])) return null;
  // "/index.php?p=123" is the site's front script, i.e. no path at all.
  if (segs.length === 1 && segs[0] === "index") segs = [];
  if (segs.length > 0 && LISTING_WORDS.has(segs[0])) return null;

  for (let i = 0; i < segs.length - 1; i++) {
    if (!GALLERY_WORDS.has(segs[i])) continue;
    const id = idOfSegment(segs[i + 1], true, true);
    if (!id) continue;
    const token = segs[i + 2];
    if (/^\d+$/.test(id) && isToken(token)) return `${id}/${token}`;
    return id.length <= MAX_ID ? id : null;
  }

  for (const key of ID_PARAMS) {
    if (NUMERIC_ONLY_PARAMS.has(key) && segs.length > 0) continue;
    const v = url.searchParams.get(key);
    if (!v) continue;
    const n = number(v);
    if (n) return n;
    // "?id=abc123": an opaque id, kept as written — case can matter in one.
    if (!NUMERIC_ONLY_PARAMS.has(key) && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(v)) return v;
  }

  // A front script needs an id parameter; its filename cannot name a title.
  if (/\.php$/i.test(loneFile)) return null;

  for (const [i, seg] of segs.entries()) {
    // "/2024/05/some-post/" is a date, not an id.
    if (/^(?:19|20)\d\d$/.test(seg) && /^\d{1,2}$/.test(segs[i + 1] ?? "")) continue;
    if (/^\d{4,12}$/.test(seg) || (i === 0 && /^\d+$/.test(seg))) {
      const n = number(seg);
      if (n) return n;
    }
    const tail = tailId(seg, false);
    if (tail) return tail;
    // A number LEADING a slug ("1001-nights", "86958-title-slug") is not taken
    // for an id: it is as often the start of the name, and "1001-nights" and
    // "1001-nights-of-love" would become one title. The whole slug names it.
  }

  // A blog files a post under its date: "/2024/05/<slug>/" names the slug.
  const rest = /^(?:19|20)\d\d$/.test(segs[0] ?? "") ? segs.slice(segs.findIndex((s) => !/^\d{1,4}$/.test(s))) : segs;
  // A reader's chapter and page numbers after the slug belong to the title:
  // "/<slug>/", "/<slug>/<chapter>/", "/<slug>/<chapter>/<page>/".
  const [first, second] = rest;
  const numbers = rest.slice(1);
  const calendarTail = numbers.length === 2 && /^(?:19|20)\d\d$/.test(numbers[0]) && /^\d{1,2}$/.test(numbers[1]);
  if (first && !calendarTail && numbers.length <= 2 && numbers.every((s) => /^\d{1,4}$/.test(s))) {
    const slug = idOfSegment(first, true);
    if (slug && slug.length >= 3 && slug.length <= MAX_ID) return slug;
  }
  // "/<series-slug>/<title-slug>": a title filed under its series. Both parts
  // are the id — the title's slug alone can repeat under another series.
  if (rest.length === 2 && /[-_]/.test(second) && second.length >= 8) {
    const series = idOfSegment(first, true);
    const title = idOfSegment(second, true);
    if (series && title && `${series}/${title}`.length <= MAX_ID) return `${series}/${title}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Longest page or cover address the app keeps (the titles.url column). */
export const MAX_URL = 1024;

/**
 * An address the app may store or fetch: http(s), a dotted host name (no bare
 * IP — a gallery site has a name), no credentials, the scheme's own port.
 */
export function parseWebUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  if (!HOSTNAME.test(url.hostname.toLowerCase())) return null;
  return url;
}

// Tracking parameters a shared link picks up; they never name the title.
const TRACKING = /^(?:utm_.*|fbclid|gclid|yclid|mc_[a-z]+|ref|ref_src|source|share|s_id)$/i;

/** The address without its fragment and tracking noise. */
function tidy(url: URL): string {
  const out = new URL(url.toString());
  out.hash = "";
  for (const key of [...out.searchParams.keys()]) if (TRACKING.test(key)) out.searchParams.delete(key);
  return out.toString();
}

/** A title from one address, or null when it does not look like a title's. */
export function refFromUrl(raw: string): TitleRef | null {
  const url = parseWebUrl(raw);
  if (!url) return null;
  const source = siteKey(url.hostname);
  const id = galleryIdOf(url);
  if (!id) return null;
  // nhentai's key IS the hashtag, which the database keeps below 1e9.
  if (source === "nhentai" && !(Number(id) > 0 && Number(id) < 1_000_000_000)) return null;
  // A legacy site's title is read at its canonical page — a pasted reader
  // page or chapter becomes the title's own page, as it always did.
  return { source, id, url: legacyUrl(source, id) ?? tidy(url) };
}

// A bare "177013" or "#177013" has always meant nhentai, and still does.
function nhentaiRef(raw: string): TitleRef | null {
  const n = number(raw.replace(/^#/, ""));
  return n && Number(n) < 1_000_000_000 ? { source: "nhentai", id: n, url: LEGACY.nhentai.url(n) } : null;
}

// `nhentai:177013`, `hitomi:1234567`: the ref text older clients and the
// rescrape script send. Only a legacy key can be rebuilt into an address.
const REF_TEXT = /^([a-z0-9]+):(\S+)$/;
function legacyRefText(raw: string): TitleRef | null {
  const m = raw.match(REF_TEXT);
  if (!m || !isLegacySource(m[1])) return null;
  return refFromUrl(LEGACY[m[1]].url(m[2]));
}

// Every web address in a blob of text, in order. Links glued together without
// a separator ("…/g/837933/https://nhentai.net/g/177013/" — a share-sheet
// shortcut appending) are split apart, and an address typed without its scheme
// ("nhentai.net/g/177013") counts.
const URLISH = /(?:https?:\/\/|\b(?:www\.)?(?=[a-z0-9-]+\.[a-z0-9.-]+\/))[^\s"'<>`]+/gi;
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  // The schemeless-host lookahead rescans every dotted suffix on a failed
  // match. Tokenize linearly first and never run it on an oversized address.
  // Split glued schemes before the cap so long tab dumps keep all their URLs.
  for (const token of text.matchAll(/[^\s"'<>`]+/g)) {
    for (const part of token[0].split(/(?=https?:\/\/)/i)) {
      if (part.length > MAX_URL) continue;
      for (const m of part.matchAll(URLISH)) {
        const trimmed = m[0].replace(/[)\].,;:!?'"»”’>]+$/, "");
        if (!trimmed) continue;
        out.push(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      }
    }
  }
  return out;
}

/** `source:id` — the string form of a title's key (job keys, lookups). */
export function refKey(ref: TitleKey): string {
  return `${ref.source}:${ref.id}`;
}

/** A `source:id` key back into its parts, or null when it is not one. */
export function parseRefKey(key: unknown): TitleKey | null {
  if (typeof key !== "string") return null;
  const at = key.indexOf(":");
  return at > 0 ? toTitleKey(key.slice(0, at), key.slice(at + 1)) : null;
}

/**
 * One title from one piece of input: "177013" / "#177013" (nhentai, as ever),
 * a legacy `source:id` ref, or a link to a title on any site. Null for anything
 * else, including links that look like listings (tags, searches, home pages).
 */
export function parseTitleRef(input: string): TitleRef | null {
  const t = input.trim();
  if (/^#?\d+$/.test(t)) return nhentaiRef(t);
  const asRef = legacyRefText(t);
  if (asRef) return asRef;
  for (const url of urlsIn(t)) {
    const ref = refFromUrl(url);
    if (ref) return ref;
  }
  return null;
}

// Pull every title out of an arbitrary blob of text, in paste order, deduped.
// This is the *batch* counterpart to parseTitleRef: the add box is filled by
// pasting far more often than by typing, and iOS Safari's "Copy Links" (tab
// overview → long-press "N Tabs" → Copy Links) dumps every open tab at once,
// interleaving page TITLES with the URLs.
//
// A link counts when its address looks like one title's (galleryIdOf); the
// scraper still refuses a page that turns out not to be one. Bare numbers
// (nhentai ids) are trusted only as far as their company allows: when every
// token is a number the box was typed by hand, so any digit run counts; as soon
// as prose is mixed in it is a paste, where stray digits are page counts, years
// and chapter numbers, so only id-shaped runs (5-7 digits) survive.
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

  for (const token of tokens) {
    const urls = urlsIn(token);
    if (urls.length > 0) {
      urls.forEach((u) => push(refFromUrl(u)));
      continue;
    }
    const asRef = legacyRefText(token);
    if (asRef) {
      push(asRef);
      continue;
    }
    const m = token.match(bare);
    if (m) push(nhentaiRef(m[1]));
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

/** A page's `searchParams`, as Next hands them over. */
export type PageQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

// decodeURIComponent throws on a malformed escape ("%"), which would turn a
// typo in the address bar into a 500.
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function queryOf(query: PageQuery): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of typeof value === "string" ? [value] : (value ?? [])) out.append(key, v);
  }
  return out.toString();
}

/**
 * The link `/add/<link>` (app/add/[...input]) was handed, from the catch-all's
 * segments and the page's query. A share-sheet shortcut sends the link
 * percent-encoded ("/add/https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F", one
 * segment) or raw ("/add/https://site.example/view.php?id=7"), depending on
 * whether its URL-encode step escapes slashes. Raw, the link arrives cut up:
 * Next merges the scheme's "//" into one, drops a trailing "/", and the link's
 * own query ("?id=7", the only id some sites have) lands in the /add page's
 * query — which has none of its own. All three are put back. A bare id or
 * `source:id` ref has no "/" and takes no query.
 */
export function quickAddInput(segments: readonly string[], query: PageQuery = {}): string {
  const scheme = safeDecode(segments[0] ?? "");
  // A split raw URL already carries its own path escapes. Decode the scheme
  // that Next escaped, but keep %20/%2F/%3F/%23 in the URL's path intact.
  // A single encoded URL (or bare id/key) still decodes fully, once.
  const parts = segments.length > 1 && /^https?:$/i.test(scheme)
    ? [scheme, ...segments.slice(1)] : segments.map(safeDecode);
  const link = parts.join("/").replace(/^(https?:)\/(?!\/)/i, "$1//");
  const search = queryOf(query);
  if (!search || !link.includes("/")) return link;
  return `${link}${link.includes("?") ? "&" : "?"}${search}`;
}

/**
 * The `/add/<link>` address itself, to come back to after signing in. Next
 * hands the segments over percent-encoded, so they are decoded before being
 * encoded again — encoding them as given would escape the escapes.
 */
export function quickAddPath(segments: readonly string[], query: PageQuery = {}): string {
  const search = queryOf(query);
  return `/add/${segments.map((s) => encodeURIComponent(safeDecode(s))).join("/")}${search ? `?${search}` : ""}`;
}

// ---------------------------------------------------------------------------
// Showing a title
// ---------------------------------------------------------------------------

/** Where a stored title is read: its saved address, or a legacy row's rebuilt one. */
export function titleUrl(source: string, id: string, url: string | null | undefined): string {
  return url || legacyUrl(source, id) || `https://${siteHost(source)}/`;
}

/** Compact label: "#177013" for nhentai (as ever), "hentaifox 42", "e-hentai 899557"… */
export function refLabel(ref: TitleKey): string {
  if (ref.source === "nhentai") return `#${ref.id}`;
  const host = siteHost(ref.source);
  const labels = host.split(".");
  const site = labels.length > 1 ? labels.slice(0, -1).join(".") : host;
  // "899557/edd545586a" shows its number; "series/title-slug" its title.
  const parts = ref.id.split("/");
  const id = /^\d+$/.test(parts[0]) ? parts[0] : parts[parts.length - 1];
  return `${site} ${id.length > 24 ? `${id.slice(0, 23)}…` : id}`;
}

/** Stored parts → a key, or null when they could not have been written. */
export function toTitleKey(source: unknown, id: unknown): TitleKey | null {
  return isSourceKey(source) && typeof id === "string" && id.length > 0 ? { source, id } : null;
}

export const COVER_PATH = "/api/cover";

/**
 * What an <img> loads for a stored cover: the same-origin proxy (/api/cover),
 * which fetches it with the title page's origin as Referer — image hosts that
 * refuse hotlinks check for exactly that, and a browser on this origin cannot
 * send it. "" when the link is not a web address, so the caller draws the
 * procedural cover instead.
 */
export function coverSrc(imageLink: string | null | undefined, pageUrl?: string | null): string {
  const img = parseWebUrl(imageLink);
  if (!img) return "";
  const page = pageUrl ? parseWebUrl(pageUrl) : null;
  const ref = page ? `&ref=${encodeURIComponent(page.origin)}` : "";
  return `${COVER_PATH}?src=${encodeURIComponent(img.toString())}${ref}`;
}
