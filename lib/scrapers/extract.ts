// Reads a title from ANY gallery page — no per-site code.
//
// Gallery engines differ in markup but agree on conventions, and those are
// what this reads:
//   * metadata the page declares: OpenGraph, JSON-LD, schema.org microdata;
//   * the heading (<h1>), and the block around it that holds the entity links —
//     the "info block" — as opposed to sidebars, related galleries, comments,
//     menus (NOISE), which carry links of the same kind about other titles;
//   * what a link is, from three independent signals, strongest first: a
//     namespace in its value ("female:big breasts", "artist:foo"), the label of
//     its row ("Artists:", "Parodies", a table's first cell), and the words of
//     its path (/tag/x, /artist/x, /series/x, /character/x, /circle/x);
//   * the doujin title convention "(Event) [Circle (Artist)] Title (Parody)
//     [Language]", which names the circle, artist and parody even on a page
//     that lists none of them;
//   * labeled rows for the page count and the date ("Pages: 24", "Length: 20
//     pages", "Posted: 2013-08-10"), <time datetime>, reader links /…/<id>/<n>/;
//   * the cover: an image marked as one (class/id "cover"), og:image, a CSS
//     background, lazy-load attributes (data-src, srcset) over placeholders.
//
// A page is a gallery only when it says enough to be one (see `isGallery`);
// a listing, a search, a tag page, a 404, a login wall or a news article is
// refused. A content warning or age gate, and a reader page, answer "follow"
// with the link to the gallery itself.

import * as cheerio from "cheerio";
import { contains, type CheerioAPI } from "cheerio";
import { cleanText, type EntityKind } from "../scrape-payload";
import { galleryIdOf, isSameSite, parseWebUrl } from "../sources";
import { absoluteUrl, clip, decodeEntities, EntityBag, isoDay, parseCount, prettyTitle } from "./common";

// cheerio does not re-export domhandler's node type; this is it.
type El = Parameters<typeof contains>[0];
type Sel = ReturnType<CheerioAPI>;

export interface ExtractedTitle {
  title_name: string;
  image_link: string;
  pages: number;
  uploaded_at: string | null;
  tags: { name: string; link: string; total_works: number }[];
  artists: { name: string; link: string; total_works: number }[];
  groups: { name: string; link: string; total_works: number }[];
  characters: { name: string; link: string; total_works: number }[];
  parodies: { name: string; link: string; total_works: number }[];
}

export type PageReading =
  | { kind: "gallery"; title: ExtractedTitle }
  | { kind: "follow"; url: string; why: string }
  | { kind: "none"; reason: string };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

type Meaning = EntityKind | "pages" | "date" | "skip" | "format";

// Row labels and path words → what they hold. Lowercased, letters only.
const WORDS: Record<string, Meaning> = {
  tag: "tags", tags: "tags", tagged: "tags", content: "tags", contents: "tags", genre: "tags", genres: "tags",
  theme: "tags", themes: "tags", keyword: "tags", keywords: "tags", female: "tags", male: "tags", mixed: "tags",
  other: "tags", misc: "tags", fetish: "tags", fetishes: "tags", kink: "tags", kinks: "tags", taglist: "tags",
  artist: "artists", artists: "artists", author: "artists", authors: "artists", mangaka: "artists",
  creator: "artists", creators: "artists", illustrator: "artists", illustrators: "artists", drawnby: "artists",
  mangaauthor: "artists", mangaartist: "artists",
  group: "groups", groups: "groups", circle: "groups", circles: "groups",
  parody: "parodies", parodies: "parodies", series: "parodies", fandom: "parodies", fandoms: "parodies",
  catalog: "parodies", section: "parodies",
  franchise: "parodies", copyright: "parodies", copyrights: "parodies", source: "parodies", origin: "parodies",
  character: "characters", characters: "characters", char: "characters", chars: "characters",
  pairing: "characters", pairings: "characters",
  page: "pages", pages: "pages", length: "pages", images: "pages", pics: "pages", pictures: "pages",
  files: "pages", photos: "pages", pagecount: "pages",
  uploaded: "date", upload: "date", uploadedon: "date", uploaddate: "date", posted: "date", postedon: "date",
  added: "date", dateadded: "date", published: "date", date: "date", created: "date", released: "date",
  releasedate: "date",
  language: "skip", languages: "skip", lang: "skip", translated: "skip", translator: "skip",
  translators: "skip", scanlator: "skip", scanlators: "skip", scanlation: "skip", scanlations: "skip",
  scanlationgroup: "skip", translation: "skip", translations: "skip", uploader: "skip", uploadedby: "skip",
  user: "skip", status: "skip", rating: "skip", ratings: "skip", views: "skip", favorites: "skip",
  favorited: "skip", favourites: "skip", size: "skip", filesize: "skip", year: "skip", releaseyear: "skip",
  ranking: "skip", visible: "skip", reclass: "skip", cosplayer: "skip", temp: "skip", alternative: "skip",
  alternativetitle: "skip", alttitle: "skip", altname: "skip", comments: "skip", convention: "skip",
  conventions: "skip", event: "skip", events: "skip", magazine: "skip", publisher: "skip",
  category: "format", categories: "format", type: "format", types: "format", format: "format",
};

// Publication/serialization metadata never becomes tags, even in a Tags row.
const FORMAT_WORDS = new Set([
  "doujinshi", "doujin", "manga", "artist cg", "artistcg", "game cg", "gamecg",
  "image set", "imageset", "oneshot", "one shot", "serialized", "completed",
  "ongoing", "hentai", "private", "ecchi manga", "doujinshi manga",
]);
// Ambiguous Genre/Content taxonomies use these as formats too, but explicit
// Tags/namespace signals may identify them as genuine descriptive tags.
const GENRE_FORMAT_WORDS = new Set([
  "western", "non-h", "nonh", "asian porn", "adult", "webtoon", "manhwa", "manhua",
  "18+", "r18", "r-18", "mature", "smut", "nsfw", "erotica",
]);
// Words that are a format only in a Category/Type row — elsewhere they can be a
// genuine tag ("cosplay", "anime").
const FORMAT_IN_FORMAT_ROW = new Set([
  "cosplay", "misc", "anime", "comic", "comics", "illustration", "illustrations", "cg", "video", "game",
  "novel", "western comic", "3d",
]);

const PLACEHOLDER = /^[\s\-–—_?.]*$|^(?:n\/?a|none|unknown|no data|not set|empty)$/i;

// Class/id parts and elements that hold links about OTHER titles or the site.
const NOISE_PARTS = new Set([
  "sidebar", "aside", "widget", "widgets", "related", "recommend", "recommended", "recommendations",
  "similar", "suggested", "suggestions", "popular", "trending", "footer", "navbar", "nav", "menu",
  "breadcrumb", "breadcrumbs", "comment", "comments", "disqus", "cloud", "ad", "ads", "advert",
  "advertisement", "banner", "sponsor", "sponsored", "carousel", "slider", "share", "social", "login",
  "signup", "pagination", "pager", "chapters", "chapterlist", "morelikethis", "recent", "latest",
  "navigation", "toolbar", "topbar", "tagcloud", "dropdown", "modal",
]);
const NOISE_TAGS = new Set(["nav", "footer", "aside", "form", "select", "button"]);
const NOISE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

const words = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const fold = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Blocks named for what they hold about OTHER titles, by their own heading.
const OTHERS_HEADING = /^(?:you (?:may|might) (?:also )?like|related|similar|recommended|recommendations|more like this|more (?:from|by|galleries)|also by|other (?:works|galleries|titles)|popular|trending|most (?:viewed|popular)|recent|latest|new(?:est)? (?:uploads|galleries)|top|random|people also|readers also|comments?)\b/i;

let ownTitle = "";
let otherWorkCards: WeakSet<object> | null = null;
function isOwnTitle(text: string, keyword: string): boolean {
  const f = fold(text);
  return f.length >= 4 && f !== fold(keyword) && ownTitle.includes(f);
}

// The page being read, for the noise check: a block holding most of the page is
// its layout wrapper ("#page-container.sidebar-l", ".content-sidebar-wrap"),
// whatever its class says, never a sidebar.
let pageSizes: { total: number; size: WeakMap<object, number>; heading: WeakSet<object> } | null = null;

function measure(root: El): NonNullable<typeof pageSizes> {
  const size = new WeakMap<object, number>();
  const heading = new WeakSet<object>();
  const walk = (el: El): number => {
    if (tagOf(el) === "h1" || (attrOf(el, "itemprop") === "name" && ownTitle.includes(fold(nodeText(el))))) heading.add(el);
    let n = 0;
    for (const c of (el as { children?: El[] }).children ?? []) {
      if ((c as { type?: string }).type === "tag" || (c as { type?: string }).type === "script" || (c as { type?: string }).type === "style") n += 1 + walk(c);
      if (heading.has(c)) heading.add(el);
    }
    size.set(el as object, n);
    return n;
  };
  return { total: walk(root), size, heading };
}

function nodeText(el: El, max = 200): string {
  let out = "";
  const walk = (n: El) => {
    if (out.length > max) return;
    if ((n as { type?: string }).type === "text") out += (n as { data?: string }).data ?? "";
    for (const c of (n as { children?: El[] }).children ?? []) walk(c);
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function attrOf(el: El, name: string): string {
  return (el as { attribs?: Record<string, string> }).attribs?.[name] ?? "";
}

function tagOf(el: El): string {
  return ((el as { tagName?: string }).tagName ?? "").toLowerCase();
}

function hasAncestor(el: El, tag: string): boolean {
  for (let cur = (el as { parent?: El | null }).parent ?? null; cur; cur = (cur as { parent?: El | null }).parent ?? null) {
    if (tagOf(cur) === tag) return true;
  }
  return false;
}

function isNoiseElement(el: El): boolean {
  // The page's layout wrapper holds most of it; whatever its modifier classes
  // say ("#page-container.sidebar-l"), it is not a sidebar. (A big related
  // block can hold half a page — hitomi's does — so the bar is well above that.)
  const tag = tagOf(el);
  // An <article>'s own <footer> is its meta block (tags, categories) — HTML5's
  // other footer, not the site's.
  if (tag === "footer" && hasAncestor(el, "article")) return false;
  if (NOISE_TAGS.has(tag)) return true;
  if (NOISE_ROLES.has(attrOf(el, "role").toLowerCase())) return true;
  // Size alone cannot turn a huge tag widget into a layout wrapper. A wrapper
  // must also contain the main heading; semantic sidebars remain noise above.
  if (pageSizes && pageSizes.heading.has(el) && (pageSizes.size.get(el) ?? 0) > pageSizes.total * 0.6) return false;
  // A class names what an element is by its head or its tail: "related-content",
  // "popular-tags", "site-footer", "entry-comments". A word in the middle is a
  // layout's description ("content-sidebar-wrap" holds the content).
  const names = `${attrOf(el, "class")} ${attrOf(el, "id")}`.toLowerCase();
  for (const token of names.split(/\s+/)) {
    if (!token) continue;
    if (NOISE_PARTS.has(token.replace(/[^a-z]/g, ""))) return true;
    const parts = token.split(/[-_]/).filter(Boolean);
    if (NOISE_PARTS.has(parts[0]) || NOISE_PARTS.has(parts[parts.length - 1])) return true;
  }
  // A block whose own heading says it is about other titles.
  let seen = 0;
  for (const c of (el as { children?: El[] }).children ?? []) {
    if ((c as { type?: string }).type !== "tag") continue;
    if (++seen > 3) break;
    const ct = tagOf(c);
    if (/^h[2-6]$/.test(ct) || /(?:^|[\s_-])(?:title|heading|header|caption)(?:$|[\s_-])/i.test(attrOf(c, "class"))) {
      const ht = nodeText(c, 80);
      const kw = ht.match(OTHERS_HEADING);
      // The page's own title heading ("Morning Ledger Gqihnsh [English]") is not a
      // block about other titles, whatever word it starts with.
      if (kw && ct !== "h1" && !isOwnTitle(ht, kw[0])) return true;
    }
  }
  return false;
}

function inOtherWorkCard(el: El): boolean {
  for (let cur: El | null = el; cur; cur = (cur as { parent?: El | null }).parent ?? null) {
    if (otherWorkCards?.has(cur)) return true;
  }
  return false;
}

/** Is any element between `el` and `root` (exclusive) noise? */
function inNoise(el: El, root: El | null, excludeCards = true): boolean {
  if (excludeCards && inOtherWorkCard(el)) return true;
  let cur = (el as { parent?: El | null }).parent ?? null;
  if (isNoiseElement(el)) return true;
  while (cur && cur !== root && tagOf(cur) !== "body" && tagOf(cur) !== "html") {
    if (isNoiseElement(cur)) return true;
    cur = (cur as { parent?: El | null }).parent ?? null;
  }
  return false;
}

function isHidden($: CheerioAPI, el: El): boolean {
  for (const node of [el, ...$(el).parents().toArray()]) {
    if (attrOf(node, "hidden") !== "" || (node as { attribs?: Record<string, string> }).attribs?.hidden !== undefined) return true;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrOf(node, "style"))) return true;
    if (/(?:^|\s)(?:hide|hidden|d-none|sr-only|visually-hidden|invisible)(?:\s|$)/i.test(attrOf(node, "class"))) return true;
  }
  return false;
}

const textOf = ($: CheerioAPI, el: El | Sel) => cleanText(decodeEntities($(el as El).text()));

// Cheerio's string .find prepares all direct children with an O(n²)
// removeSubsets pass. For a wide block, select from the document's single root
// and filter candidates by containment (the non-string .find algorithm).
function descendants($: CheerioAPI, scope: Sel, selector: string): Sel {
  const roots = scope.toArray();
  const wide = roots.some((el) => ((el as { children?: El[] }).children?.length ?? 0) > 128);
  return wide ? $(selector).filter((_, el) => roots.some((root) => contains(root, el))) : scope.find(selector);
}

// ---------------------------------------------------------------------------
// Metadata the page declares
// ---------------------------------------------------------------------------

interface Declared {
  title: string;
  image: string;
  date: string | null;
  pages: number;
  siteName: string;
  type: string;
  keywords: string[];
  authors: string[];
  entityNames: string[];
}

function meta($: CheerioAPI, ...names: string[]): string {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr("content") ?? $(`meta[name="${n}"]`).attr("content");
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function jsonLd($: CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const data: unknown = JSON.parse($(s).text());
      const queue = Array.isArray(data) ? [...data] : [data];
      for (let at = 0; at < queue.length; at++) {
        const item = queue[at];
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        if (Array.isArray(obj["@graph"])) for (const child of obj["@graph"]) queue.push(child);
        out.push(obj);
      }
    } catch {
      // a malformed block says nothing
    }
  });
  return out;
}

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? asText(v[0]) : v && typeof v === "object" ? asText((v as { name?: unknown; url?: unknown }).name ?? (v as { url?: unknown }).url) : "";

function asList(v: unknown): string[] {
  const out: string[] = [];
  const stack = [v];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
    } else if (typeof item === "string") {
      for (const text of item.split(/\s*,\s*/)) out.push(text);
    } else if (item && typeof item === "object") {
      stack.push((item as { name?: unknown }).name);
    }
  }
  return out;
}

function declared($: CheerioAPI): Declared {
  const declarations = jsonLd($);
  const work = declarations.find((o) => /book|comic|creativework|article|imagegallery|mediagallery|webpage|product/i.test(String(o["@type"] ?? "")) && asText(o.name ?? o.headline));
  return {
    title: cleanText(decodeEntities(asText(work?.name ?? work?.headline) || meta($, "og:title", "twitter:title"))).slice(0, MAX_TITLE_TEXT),
    image: asText(work?.image ?? work?.thumbnailUrl) || meta($, "og:image", "og:image:url", "twitter:image", "twitter:image:src") ||
      ($('[itemprop="image"]').attr("content") ?? $('[itemprop="image"]').attr("src") ?? ""),
    date: concreteDay(asText(work?.datePublished ?? work?.uploadDate ?? work?.dateCreated)) ??
      concreteDay(meta($, "article:published_time", "og:published_time", "datePublished")) ??
      concreteDay($('[itemprop="datePublished"]').attr("content") ?? $('[itemprop="datePublished"]').attr("datetime")),
    pages: parseCount(String(work?.numberOfPages ?? "")),
    siteName: meta($, "og:site_name", "application-name"),
    type: String(work?.["@type"] ?? meta($, "og:type")),
    keywords: [...asList(work?.genre), ...asList(work?.keywords)],
    authors: [...asList(work?.author), ...asList(work?.creator)],
    entityNames: declarations.filter((o) => /\b(?:profilepage|person|organization|collectionpage)\b/i.test(String(o["@type"] ?? "")))
      .map((o) => cleanText(asText(o.name))).filter(Boolean),
  };
}

// A calendar day only when the text names one — "2013-08-10 13:25",
// "April 1, 2020", "1 Apr 2020", "2016-10-18T12:28:49+00:00". A year alone
// ("Release Year: 2019") or a relative age ("3 days ago") is not a day, and a
// day is never made up.
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_PATTERNS = [
  /(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/,
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "i"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, "i"),
];
export function concreteDay(raw: string | undefined | null): string | null {
  const s = cleanText(raw ?? "");
  if (!s || /\bago\b/i.test(s)) return null;
  // Day-first numerals: "14.06.2023" is European (dots are never month-first);
  // "14/06/2023" only when a part is over 12 — "06/07/2023" stays unknown.
  const dmy = s.match(/(?<!\d)(\d{1,2})([./])(\d{1,2})\2(\d{4})(?!\d)/);
  if (dmy) {
    const [a, b] = [Number(dmy[1]), Number(dmy[3])];
    const dayFirst = dmy[2] === "." || a > 12;
    const monthFirst = dmy[2] === "/" && b > 12;
    if (dayFirst || monthFirst) {
      const [d, m] = dayFirst ? [a, b] : [b, a];
      return isoDay(`${dmy[4]}-${m}-${d}`);
    }
    return null;
  }
  for (const re of DAY_PATTERNS) {
    const m = s.match(re);
    if (m) return isoDay(m[0].replace(/(\d)(st|nd|rd|th)/i, "$1"));
  }
  return null;
}

// ---------------------------------------------------------------------------
// The title and its block
// ---------------------------------------------------------------------------

function siteWords(pageUrl: URL, siteName: string): string[] {
  const host = pageUrl.hostname.replace(/^www\./, "");
  return [siteName, host, host.split(".")[0]].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
}

// The longest title text any rule here looks at. A stored title is at most 255
// characters once its bracket groups are gone; a heading or og:title longer
// than this is not a title, and the title regexes below must never see a
// megabyte of text (several are quadratic on a long enough run).
const MAX_TITLE_TEXT = 1000;

// "Title - Site", "Title | Site Name", "Site » Title" → the part that is not the site.
function stripSiteName(raw: string, site: string[]): string {
  // Whitespace is collapsed first so the separator is one fixed " x " shape:
  // \s+ on both sides backtracks over a long run of spaces from every start.
  const text = cleanText(raw).slice(0, MAX_TITLE_TEXT);
  const parts = text.split(/ [-|–—»·:] /).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return text;
  const kept = parts.filter((p) => !site.some((w) => p.toLowerCase().includes(w)));
  return (kept.length ? kept : parts).sort((a, b) => b.length - a.length)[0];
}

function isLogoHeading($: CheerioAPI, el: El, pageUrl: URL, site: string[]): boolean {
  const text = textOf($, el).toLowerCase();
  if (!text) return true;
  if (site.includes(text)) return true;
  const link = $(el).find("a[href]").first().attr("href");
  if (link) {
    const abs = absoluteUrl(link, pageUrl.origin);
    if (abs && new URL(abs).pathname === "/" && isSameSite(new URL(abs).hostname, pageUrl.hostname)) return true;
  }
  return /(?:^|[\s_-])(?:logo|site-?title|site-?name)(?:$|[\s_-])/i.test(`${attrOf(el, "class")} ${attrOf(el, "id")}`);
}

// Headings that say the page is not a title.
// A heading that is one of these words and nothing else, or an error page's
// phrase. ("Home Alone" and "Tags of Love" are titles; "Home" is a page.)
const NOT_A_TITLE = /^(?:404|error|oops|not found|page not found|gallery not found|access denied|forbidden|log ?in|sign ?in|login required|search|search results?|home|homepage|welcome|tags?|artists?|categories|browse|galleries|(?:latest|newest|new|popular|recent|top|random|all|trending)(?: (?:galleries|uploads|updates|titles|manga|doujinshi|comics|hentai|releases))?)[\s.!:]*$|^(?:404\b|error\b|oops\b|page not found|gallery not found|search results|results for\b)|^(?:(?:(?:this|the|requested)\s+)?(?:gallery|page|title|content|post|book|work|file)\s+)?(?:has been (?:removed|deleted|disabled)|is no longer available|does not exist|doesn't exist|was not found)\b|^(?:you\s+)?(?:must be logged in|please log ?in to)\b/i;

// Headings that are buttons ("Read Online", "Download") rather than a name.
const ACTION = /^(?:read(?: online| now| it)?|download(?: zip| torrent)?|favou?rite|bookmark|comments?|share|report|like|more|start reading|view|back|next|previous)$/i;

// A heading's text without the badges themes put inside it ("HOT", "NEW", "18+").
function titleText($: CheerioAPI, el: El): string {
  const c = $(el).clone();
  c.find("[class*='badge'], [class*='label'], [class*='hot'], [class*='new'], [class*='status'], sup, small.badge").each((_, b) => {
    if (cleanText($(b).text()).length <= 12) $(b).remove();
  });
  return cleanText(decodeEntities(c.text()));
}

// The title's heading. When the page has several, the one the document's own
// <title>/og:title names wins — a page's other <h1>s are buttons, related
// titles, or the site's logo.
function findHeading($: CheerioAPI, pageUrl: URL, site: string[], declaredTitle: string): El | null {
  const candidates = [
    ...$("h1").toArray(),
    ...$('[itemprop="name"], [class*="title"] h2, h2[class*="title"], h2[id*="title"], .title h2').toArray(),
    ...$("h2").toArray(),
  ].filter((el) => {
    if (inNoise(el, null) || isLogoHeading($, el, pageUrl, site)) return false;
    const t = textOf($, el);
    return t.length >= 2 && t.length <= 400 && !ACTION.test(t);
  });
  const named = fold(declaredTitle);
  if (named) {
    const match = candidates.find((el) => {
      const t = fold(textOf($, el));
      return t.length >= 4 && named.includes(t);
    });
    if (match) return match;
  }
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Links → entities
// ---------------------------------------------------------------------------

interface Hit {
  kind: EntityKind;
  name: string;
  link: string;
  count: number;
  /** "format" rows keep a genre and drop a publication format. */
  fromFormatRow: boolean;
}

// "female:big breasts", "artist: foo", "Series: bar" → [namespace, value].
function namespaced(raw: string): [string, string] | null {
  const m = raw.match(/^\s*([a-z][a-z ]{1,20}?)\s*:\s*(.+)$/i);
  return m ? [words(m[1]), m[2]] : null;
}

function meaningOf(word: string): Meaning | null {
  return WORDS[words(word)] ?? null;
}

// The row a link sits in, and that row's label. A row is the nearest li / tr /
// dd / p / div (within 4 levels) that has text of its own before the link; a
// <dd> takes its <dt>, a table cell its row's first cell.
function rowLabel($: CheerioAPI, a: El, root: El | null): string {
  let cur: El | null = (a as { parent?: El | null }).parent ?? null;
  for (let depth = 0; cur && cur !== root && depth < 5; depth++) {
    const tag = tagOf(cur);
    if (tag === "dd") {
      const dt = $(cur).prevAll("dt").first();
      if (dt.length) return textOf($, dt);
    }
    if (tag === "td" || tag === "th") {
      const first = $(cur).parent().children("td, th").first();
      if (first.length && first.get(0) !== cur) return textOf($, first);
    }
    if (["li", "tr", "p", "div", "section", "span", "dl", "ul"].includes(tag)) {
      // The label: an explicit element (b, strong, label, dt, h3–h6, span with
      // "label"/"title" in its class) or the leading text before the first link.
      const explicit = $(cur).children("b, strong, label, dt, h3, h4, h5, h6, th, .label, [class*='label'], [class*='title'], [class*='name'], .tags_text, .tc, td.tc")
        .not("a")
        .filter((_, el) => $(el).find("a").length === 0)
        .first();
      if (explicit.length) {
        const t = textOf($, explicit);
        if (t && t.length <= 40) return t;
      }
      let lead = "";
      for (const node of (cur as { children?: El[] }).children ?? []) {
        if ((node as { type?: string }).type === "text") lead += (node as { data?: string }).data ?? "";
        else if (tagOf(node) === "a" || $(node).find("a").length) break;
        else lead += $(node).text();
        if (lead.length > 60) break;
      }
      const t = cleanText(lead);
      if (t && t.length <= 40 && /[a-z]/i.test(t)) return t;
      // A row heading just above a list of links ("<h3>Tags</h3><ul>…").
      const prev = $(cur).prev();
      if (prev.length && /^h[2-6]$|^dt$|^b$|^strong$|^label$/.test(tagOf(prev.get(0)!))) {
        const pt = textOf($, prev);
        if (pt && pt.length <= 30) return pt;
      }
    }
    cur = (cur as { parent?: El | null }).parent ?? null;
  }
  return "";
}

// The words of a link's path: the LAST path word with a meaning, as long as a
// value follows it — "/browse/tags/artist/12/foo" → artists, "/tag/foo/" →
// tags; "/tags/" (the index of all tags) names no entity.
function pathMeaning(url: URL): { meaning: Meaning; value: string } | null {
  const segs = url.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let found: { meaning: Meaning; value: string } | null = null;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i].toLowerCase().replace(/\.(?:html?|php)$/, "");
    const m = meaningOf(seg);
    // A path names what an entity IS; "/page/2", "/date/2024" are pagination
    // and archives, and "/author/x" on a blog is the post's writer — a label
    // has to say "Artist" for that one (see classify).
    if (!m || m === "pages" || m === "date" || i + 1 >= segs.length) continue;
    found = { meaning: m, value: segs[i + 1].replace(/-all(?:-\d+)?(?:\.html?)?$/i, "") };
    if (/^authors?$/.test(seg)) found = { meaning: "skip", value: found.value };
  }
  if (!found) {
    // Query-shaped taxonomies: "?tag=foo", "/search?artist=foo".
    for (const [k, v] of url.searchParams) {
      const m = meaningOf(k);
      if (m && v) return { meaning: m, value: v };
    }
  }
  return found;
}

const COUNT = /^[(\[]?\s*\d[\d,.]*\s*[kKmM]?\s*[)\]]?$/;
// A count written into the name itself: "(1.2K)", "(712)", "12,345", "98.4K" —
// parenthesised, or with a thousands separator or a K/M. A bare number is part
// of the name ("Comic Market 104", "Level 5").
const TRAILING_COUNT = /^(.*?\S)\s*([(\[]\s*\d[\d,.]*\s*[kKmM]?\s*[)\]]|\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?\s*[kKmM])$/;

// A count badge inside a link: any element of its own whose whole text is a
// count ("<span class="count">21,043</span>", "<em>22,410</em>"), or a count
// written after the name.
function nameAndCount($: CheerioAPI, a: El): { name: string; count: number } {
  const el = $(a).clone();
  let count = 0;
  el.find("*").each((_, b) => {
    const t = cleanText($(b).text());
    if (t && COUNT.test(t) && $(b).children().length === 0) {
      count ||= parseCount(t);
      $(b).remove();
    }
  });
  let name = cleanText(decodeEntities(el.text()));
  const tail = name.match(TRAILING_COUNT);
  if (tail && !/^\d/.test(tail[1])) {
    count ||= parseCount(tail[2]);
    name = tail[1];
  }
  // No visible text: an icon button ("Filter out", "Favorite"), not an entity —
  // its title attribute describes the button.
  return { name, count };
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff66-\uff9f]/;

// "English Title / 日本語タイトル" → the first half. Only when the second half is
// Japanese/Chinese/Korean: "Love / Hate" is one name.
function firstOfBilingual(name: string): string {
  const at = name.search(/\s+\/\s+/);
  if (at < 0) return name;
  const rest = name.slice(at).replace(/^\s+\/\s+/, "");
  return CJK.test(rest) && !CJK.test(name.slice(0, at)) ? name.slice(0, at) : name;
}

function cleanName(raw: string, kind: EntityKind): string[] {
  let name = raw.replace(/[♀♂⚥]/g, "").replace(/\s+/g, " ").trim();
  const ns = namespaced(name);
  if (ns && WORDS[ns[0]]) name = ns[1].trim();
  if (kind === "parodies") name = name.replace(/\s+(?:dj\.?|doujinshi)$/i, "");
  // "English / 日本語" bilingual names → the first; "a | b" aliases → both.
  const first = firstOfBilingual(name);
  return first.split(/\s+\|\s+/).map((n) => n.trim()).filter((n) => n && !PLACEHOLDER.test(n) && n.length <= 80);
}

function classify($: CheerioAPI, a: El, root: El | null, pageUrl: URL): Hit[] {
  const href = attrOf(a, "href");
  const abs = absoluteUrl(href, pageUrl.toString());
  const url = abs ? parseWebUrl(abs) : null;
  if (url && !isSameSite(url.hostname, pageUrl.hostname)) return [];
  const { name: rawName, count } = nameAndCount($, a);
  if (!rawName || rawName.length > 100) return [];

  // 1. A namespace in the value — the link text or the path's value segment.
  let meaning: Meaning | null = null;
  const textNs = namespaced(rawName);
  const path = url ? pathMeaning(url) : null;
  const valueNs = path ? namespaced(path.value.replace(/\+/g, " ")) : null;
  for (const ns of [valueNs, textNs]) {
    if (ns && WORDS[ns[0]]) {
      meaning = WORDS[ns[0]];
      break;
    }
  }
  // 2. The row's label.
  const label = rowLabel($, a, root);
  const labelMeaning = label ? meaningOf(label.replace(/[:：]\s*$/, "")) : null;
  if (!meaning && labelMeaning) meaning = labelMeaning;
  // 3. The path's words.
  if (!meaning && path) meaning = path.meaning;
  if (!meaning || meaning === "skip" || meaning === "pages" || meaning === "date") return [];
  // A label that says "skip" outranks a path that says "tag" (a Languages row
  // whose links go to /tag/english/).
  if (labelMeaning === "skip" && !valueNs) return [];

  const fromFormatRow = meaning === "format";
  const kind: EntityKind = meaning === "format" ? "tags" : meaning;
  const explicitTag = !fromFormatRow && (
    [valueNs, textNs].some((ns) => ns && WORDS[ns[0]] === "tags") ||
    /^(?:tags?|tagged|taglist)$/.test(words(label)) ||
    (!labelMeaning && !!url && /(?:^|\/)tags?\//i.test(url.pathname))
  );
  const link = url && url.toString().length <= 255 && !/^javascript:/i.test(href) ? url.toString() : "";
  return cleanName(rawName, kind)
    .filter((n) => !FORMAT_WORDS.has(n.toLowerCase()) && !(!explicitTag && GENRE_FORMAT_WORDS.has(n.toLowerCase())))
    .filter((n) => !(fromFormatRow && FORMAT_IN_FORMAT_ROW.has(n.toLowerCase())))
    .map((name) => ({ kind, name, link, count, fromFormatRow }));
}

function collectEntities($: CheerioAPI, scope: Sel, root: El | null, pageUrl: URL, title: string): { hits: Hit[]; titled: Hit[] } {
  const hits: Hit[] = [];
  const titled: Hit[] = [];
  descendants($, scope, "a[href]").each((_, a) => {
    if (inNoise(a, root)) return;
    for (const hit of classify($, a, root, pageUrl)) {
      if (hit.name.toLowerCase() === title.toLowerCase()) {
        titled.push(hit);
        continue;
      }
      hits.push(hit);
    }
  });
  return { hits, titled };
}

// ---------------------------------------------------------------------------
// Page count, date, cover
// ---------------------------------------------------------------------------

// Rows whose label has a meaning ("Pages: 24", "Posted: 2013-08-10"), with the
// label taken off the text.
function labeledRows($: CheerioAPI, scope: Sel): { meaning: Meaning; text: string }[] {
  const out: { meaning: Meaning; text: string }[] = [];
  descendants($, scope, "li, tr, dd, div, p, span").each((_, row) => {
    if (inOtherWorkCard(row)) return;
    const own = textOf($, row);
    if (!own || own.length > 160) return;
    const m = own.match(/^([^\d:：]{2,24})[:：]?\s*(.+)$/);
    let label = "";
    let rest = "";
    if (m) {
      label = m[1];
      rest = m[2];
    }
    if (tagOf(row) === "tr") {
      const cells = $(row).children("td, th");
      if (cells.length >= 2) {
        label = textOf($, cells.first());
        rest = textOf($, cells.slice(1));
      }
    }
    if (tagOf(row) === "dd") {
      label = textOf($, $(row).prevAll("dt").first());
      rest = own;
    }
    const meaning = label ? meaningOf(label.replace(/[:：]\s*$/, "")) : null;
    if (meaning === "pages" || meaning === "date") out.push({ meaning, text: rest });
  });
  return out;
}

function pageCount($: CheerioAPI, scope: Sel, rows: { meaning: Meaning; text: string }[], pageUrl: URL, id: string | null): number {
  for (const r of rows) {
    if (r.meaning !== "pages") continue;
    const n = r.text.match(/(\d[\d,]*)/);
    if (n) return parseCount(n[1]);
  }
  const text = textOf($, scope);
  const inline = text.match(/\b(\d[\d,]{0,6})\s*(?:pages?|páginas?|pics|pictures|images|photos|страниц\S*)\b/i);
  if (inline) return parseCount(inline[1]);
  // Reader links: "/g/177013/1/" … "/g/177013/225/" — the highest page number.
  if (id) {
    const head = id.split("/")[0];
    let max = 0;
    $("a[href]").each((_, a) => {
      const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
      if (!abs) return;
      const m = new URL(abs).pathname.match(new RegExp(`/${head}(?:/[0-9a-f]{6,40})?/(\\d{1,5})/?$`, "i"));
      if (m) max = Math.max(max, Number(m[1]));
    });
    if (max >= 2) return max;
  }
  return 0;
}

// Unlike the count fallback, listing evidence must belong to this exact work
// on this site, outside other-work cards and navigation/related blocks.
function hasOwnReader($: CheerioAPI, pageUrl: URL, id: string | null): boolean {
  if (!id) return false;
  const head = id.split("/")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`/${head}(?:/[0-9a-f]{6,40})?/(\\d{1,5})/?$`, "i");
  return $("a[href]").toArray().some((a) => {
    if (inNoise(a, null)) return false;
    const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
    if (!abs) return false;
    const u = new URL(abs);
    const m = u.pathname.match(pattern);
    return !!m && Number(m[1]) >= 2 && isSameSite(u.hostname, pageUrl.hostname) && galleryIdOf(u) === id;
  });
}

function uploadDay($: CheerioAPI, scope: Sel, root: El | null, rows: { meaning: Meaning; text: string }[], decl: Declared): string | null {
  if (decl.date) return decl.date;
  for (const t of descendants($, scope, "time[datetime]").toArray()) {
    if (inNoise(t, root)) continue;
    const d = concreteDay(attrOf(t, "datetime"));
    if (d) return d;
  }
  for (const r of rows) {
    if (r.meaning !== "date") continue;
    const d = concreteDay(r.text);
    if (d) return d;
  }
  // An element that says what it is: class/id "date", "posted", "uploaded".
  for (const el of descendants($, scope, "[class*='date'], [id*='date'], [class*='posted'], [class*='upload'], [class*='published']").toArray()) {
    if (inNoise(el, root)) continue;
    const d = concreteDay(attrOf(el, "datetime") || attrOf(el, "content") || textOf($, el));
    if (d) return d;
  }
  return null;
}

// Judged by the file name only: a CDN path ("/default-bucket/…") says nothing.
const fileName = (url: string) => new URL(url).pathname.split("/").pop() ?? "";
const NOT_A_COVER = /^(?:logo|icon|avatar|favicon|sprite|banner|placeholder|no[-_]?image|default|blank|spacer|pixel|loading|lazy|1x1|transparent|spinner|flag|emoji|badge|button)(?:[-_.]?(?:\d+(?:x\d+)?|small|large|image))?\.[a-z\d]+$/i;

function isPlaceholderCover(url: string): boolean {
  const name = fileName(url);
  if (NOT_A_COVER.test(name)) return true;
  const tokens = name.replace(/\.[^.]+$/, "").split(/[-_.]+/).filter(Boolean);
  // Only edge tokens, including a compound no-image or size suffix. A
  // placeholder word inside a work's name (my-avatar-adventure) is harmless.
  return [tokens[0], tokens.at(-1), tokens.slice(0, 2).join("-"), tokens.slice(-2).join("-")]
    .some((edge) => !!edge && NOT_A_COVER.test(`${edge}.png`));
}

function imageUrl($: CheerioAPI, img: El, pageUrl: URL): string {
  const candidates: string[] = [];
  // Lazy loaders keep the real address in a data- attribute and a placeholder
  // in src; when there is none, src is the image. A <picture>'s <source>s are
  // the last resort — the <img> is the format every browser reads.
  // The largest candidate of a srcset is the full cover (a data-src is often
  // the theme's small thumbnail of it).
  for (const attr of ["data-srcset", "srcset"]) {
    const v = attrOf(img, attr);
    if (v) candidates.push(largestOfSrcset(v));
  }
  for (const attr of ["data-src", "data-lazy-src", "data-original", "data-url", "data-full", "data-cover"]) {
    const v = attrOf(img, attr);
    if (v) candidates.push(v);
  }
  candidates.push(attrOf(img, "src"));
  if (tagOf(img) === "img") {
    $(img).parent("picture").children("source").each((_, s) => {
      const v = attrOf(s, "srcset") || attrOf(s, "data-srcset");
      if (v) candidates.push(largestOfSrcset(v));
    });
  }
  for (const c of candidates) {
    if (!c || /^data:/i.test(c)) continue;
    const abs = absoluteUrl(c.trim(), pageUrl.toString());
    if (abs && parseWebUrl(abs) && !isPlaceholderCover(abs)) return abs;
  }
  return "";
}

function largestOfSrcset(srcset: string): string {
  let best = "";
  let bestW = -1;
  for (const part of srcset.split(",")) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 0;
    if (w > bestW) {
      best = u;
      bestW = w;
    }
  }
  return best;
}

const COVERISH = /(?:^|[\s_-])(?:cover|covers|poster|thumb-?main|main-?image|gallery-?cover|summary_image|featured|book-?cover|front)(?:$|[\s_-])|^gd1$/i;
// A profile/header/channel "cover" is site or entity artwork, not a work's
// cover. Keep its image URL fallback without using it as listing evidence.
const PROFILE_COVER = /(?:^|[\s_-])(?:profile|header|banner|channel)[_-]covers?(?:$|[\s_-])|(?:^|[\s_-])covers?[_-](?:profile|header|banner|channel)(?:$|[\s_-])/i;

function isEntityProfile($: CheerioAPI, scope: Sel, heading: El | null, url: URL, decl: Declared, titled: Hit[], title: string): boolean {
  if (titled.length > 0 || /\b(?:profilepage|person|organization|collectionpage)\b/i.test(decl.type) ||
    decl.entityNames.some((name) => fold(name) === fold(title))) return true;
  const pathKind = pathMeaning(url)?.meaning;
  if (pathKind && ["artists", "groups", "parodies", "characters", "tags"].includes(pathKind)) return true;
  const context = [...scope.toArray(), ...(heading ? [heading, ...$(heading).parents().slice(0, 4).toArray()] : [])];
  if (context.some((el) => /(?:^|[\s_-])(?:profile|(?:artist|author|entity|channel)[_-]page)(?:$|[\s_-])/i
    .test(`${attrOf(el, "class")} ${attrOf(el, "id")}`))) return true;
  // A banner next to the metadata also identifies the entity's artwork, even
  // if the same image is declared in og:image. Ignore other works' cards.
  return descendants($, scope, "[class], [id]").toArray().some((el) =>
    !inOtherWorkCard(el) && PROFILE_COVER.test(`${attrOf(el, "class")} ${attrOf(el, "id")}`));
}

function backgroundUrl(el: El, pageUrl: URL): string {
  const style = attrOf(el, "style");
  const start = style.toLowerCase().indexOf("url(");
  if (start < 0) return "";
  const value = style.slice(start + 4).trimStart();
  const quoted = value.startsWith("'") || value.startsWith('"');
  const end = value.indexOf(quoted ? value[0] : ")", quoted ? 1 : 0);
  if (end < 0 || (quoted && !/^\s*\)/.test(value.slice(end + 1)))) return "";
  const abs = absoluteUrl(value.slice(quoted ? 1 : 0, end).trim(), pageUrl.toString());
  return abs && parseWebUrl(abs) && !isPlaceholderCover(abs) ? abs : "";
}

function findCover($: CheerioAPI, scope: Sel, root: El | null, decl: Declared, pageUrl: URL): { url: string; explicit: boolean } {
  // Look in the info block, then in the blocks around it (a cover column beside
  // the info table), never inside noise.
  const areas: Sel[] = [scope, scope.parent(), scope.parent().parent(), scope.parent().parent().parent()];
  const markedCover = (el: El) =>
    [el, ...$(el).parents().slice(0, 4).toArray()].some((n) => COVERISH.test(`${attrOf(n, "class")} ${attrOf(n, "id")}`));
  const profileCover = (el: El) =>
    [el, ...$(el).parents().slice(0, 4).toArray()].some((n) => PROFILE_COVER.test(`${attrOf(n, "class")} ${attrOf(n, "id")}`));
  // …or by its own address: ".../cover/_S86341.jpg", ".../cover.jpg".
  const coverAddress = (u: string) => /(?:^|[/_.-])covers?(?:[/_.-]|$)/i.test(new URL(u).pathname);
  for (const area of areas) {
    for (const img of descendants($, area, "img").toArray()) {
      if (inNoise(img, null)) continue;
      const u = imageUrl($, img, pageUrl);
      if (u && (markedCover(img) || coverAddress(u))) return { url: u, explicit: !profileCover(img) };
    }
    for (const el of descendants($, area, "[style*='url(']").toArray()) {
      if (inNoise(el, null)) continue;
      if (!markedCover(el) && !/(?:width|height)\s*:\s*\d{3}/.test(attrOf(el, "style"))) continue;
      const u = backgroundUrl(el, pageUrl);
      if (u) return { url: u, explicit: !profileCover(el) && (markedCover(el) || coverAddress(u)) };
    }
  }
  if (decl.image) {
    const abs = absoluteUrl(decl.image, pageUrl.toString());
    if (abs && parseWebUrl(abs) && !isPlaceholderCover(abs)) return { url: abs, explicit: false };
  }
  for (const area of areas.slice(0, 3)) {
    for (const img of descendants($, area, "img").toArray()) {
      if (inNoise(img, root)) continue;
      const w = Number(attrOf(img, "width")) || 0;
      const h = Number(attrOf(img, "height")) || 0;
      if ((w && w < 80) || (h && h < 80)) continue;
      const u = imageUrl($, img, pageUrl);
      if (u) return { url: u, explicit: false };
    }
  }
  return { url: "", explicit: false };
}

// ---------------------------------------------------------------------------
// The doujin title convention
// ---------------------------------------------------------------------------

// "(C92) [Circle (Artist)] Title (Parody) [English]": the lead square bracket
// is the circle with the artist in parentheses (or the artist alone), and the
// trailing parenthesised group is the parody. Used only for what the page did
// not list itself.
const RELEASE_NOTE = /^(?:digital|(?:de|un)?censored|english|chinese|korean|full colou?r|colou?rized|\d+p|ongoing|completed?)$/i;
const RELEASE_NUMBER = /^(?:(?:part|ch(?:apter)?\.?|vol(?:ume)?\.?|episode)\s*)?\d+(?:\s*[-–,]\s*\d+)*$/i;
// Magazine issues/dates describe a release, rather than its franchise.
const ISSUE_DATE = /\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/;

function fromTitleConvention(raw: string): { groups: string[]; artists: string[]; parodies: string[] } {
  const out = { groups: [] as string[], artists: [] as string[], parodies: [] as string[] };
  const s = cleanText(raw).replace(/^(?:\([^()]*\)\s*)+/, "");
  const lead = s.match(/^\[([^\]]+)\]/);
  if (lead) {
    const inner = lead[1].match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    if (inner) {
      out.groups.push(...inner[1].split(/\s*[,、&]\s*/));
      out.artists.push(...inner[2].split(/\s*[,、&]\s*/));
    } else {
      out.artists.push(...lead[1].split(/\s*[,、&]\s*/));
    }
  }
  const rest = lead ? s.slice(lead[0].length) : s;
  const tail = rest.replace(/(?:\s*\[[^\]]*\]|\s*\{[^}]*\})+\s*$/, "").match(/\(([^()]+)\)\s*$/);
  if (tail && !RELEASE_NOTE.test(tail[1].trim()) && !RELEASE_NUMBER.test(tail[1].trim()) && !ISSUE_DATE.test(tail[1])) {
    out.parodies.push(...tail[1].split(/\s*[,、]\s*/));
  }
  const clean = (l: string[]) => l.map((x) => x.trim()).filter((x) => x && x.length <= 60 && !/^(?:english|digital|decensored)$/i.test(x));
  return { groups: clean(out.groups), artists: clean(out.artists), parodies: clean(out.parodies) };
}

// ---------------------------------------------------------------------------
// Following: content warnings, age gates, reader pages
// ---------------------------------------------------------------------------

const GATE_TEXT = /content warning|offensive|adult content|age verification|are you (?:18|over 18|an adult)|over 18|18\+|mature content|nsfw|flagged|this gallery (?:may|contains)/i;
const GATE_LINK = /^(?:view gallery|view anyway|continue|enter|proceed|yes\b|i agree|i am (?:18|over 18|an adult)|i'?m (?:18|over 18)|show (?:it|content|gallery)|confirm|ok|accept|let me in)/i;

function followLink($: CheerioAPI, pageUrl: URL, id: string | null): { url: string; why: string } | null {
  const body = textOf($, $("body"));
  if (GATE_TEXT.test(body)) {
    for (const a of $("a[href]").toArray()) {
      const t = textOf($, a);
      const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
      if (!abs || !GATE_LINK.test(t)) continue;
      const u = new URL(abs);
      if (isSameSite(u.hostname, pageUrl.hostname) && u.toString() !== pageUrl.toString()) {
        return { url: u.toString(), why: `confirmed the "${t}" warning` };
      }
    }
  }
  // A reader or chapter page links back to its gallery: the same id, a shorter path.
  if (id) {
    const here = pageUrl.pathname.split("/").filter(Boolean).length;
    let best: URL | null = null;
    for (const a of $("a[href]").toArray()) {
      const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
      const u = abs ? parseWebUrl(abs) : null;
      if (!u || !isSameSite(u.hostname, pageUrl.hostname) || galleryIdOf(u) !== id) continue;
      const depth = u.pathname.split("/").filter(Boolean).length;
      if (depth < here && (!best || depth < best.pathname.split("/").filter(Boolean).length)) best = u;
    }
    if (best) return { url: best.toString(), why: "went from the reader page to the gallery" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

// How many OTHER titles a block links to: a listing links to dozens, a gallery
// page to its own pages (the same id) and, outside its info block, to related
// titles.
function otherTitles($: CheerioAPI, scope: Sel, root: El | null, pageUrl: URL, id: string | null): number {
  const ids = new Set<string>();
  descendants($, scope, "a[href]").each((_, a) => {
    if (inNoise(a, root, false)) return;
    const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
    const u = abs ? parseWebUrl(abs) : null;
    if (!u || !isSameSite(u.hostname, pageUrl.hostname)) return;
    const other = galleryIdOf(u);
    if (other && other !== id && $(a).find("img").length + (textOf($, a).length > 20 ? 1 : 0) > 0) ids.add(other);
  });
  return ids.size;
}

// Other works' credits can sit outside their thumbnail/title link. Exclude
// the nearest container holding those credits, but never climb across the
// current page's heading. A lone Next link excludes only itself, not the
// wrapper containing the current title's split metadata.
function findOtherWorkCards($: CheerioAPI, heading: El | null, pageUrl: URL): WeakSet<object> {
  const cards = new WeakSet<object>();
  const creditContainers = new WeakMap<object, boolean>();
  const id = galleryIdOf(pageUrl);
  $("a[href]").each((_, a) => {
    if (inNoise(a, null, false)) return;
    const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
    const u = abs ? parseWebUrl(abs) : null;
    if (!u || !isSameSite(u.hostname, pageUrl.hostname)) return;
    const other = galleryIdOf(u);
    if (!other || other === id || (!$(a).find("img").length && textOf($, a).length <= 20)) return;
    cards.add(a);
    for (let cur = (a as { parent?: El | null }).parent ?? null; cur && !["body", "html"].includes(tagOf(cur)); cur = (cur as { parent?: El | null }).parent ?? null) {
      if (heading ? cur === heading || contains(cur, heading) : pageSizes?.heading.has(cur)) break;
      // Many cards share this ancestor. Cache both true and false: a broad
      // list with no credits must not be scanned again for every thumbnail.
      let credits = creditContainers.get(cur);
      if (credits === undefined) {
        credits = descendants($, $(cur), "a[href]").toArray()
          .some((link) => !inNoise(link, cur, false) && classify($, link, cur, pageUrl).length > 0);
        creditContainers.set(cur, credits);
      }
      if (credits) { cards.add(cur); break; }
    }
  });
  return cards;
}

// The info block: the nearest ancestor of the heading that holds entity links.
// When the heading is hidden (a schema.org name tucked away) or lives apart from
// the links, the block with the most labeled entity rows stands in for it.
function chooseScope($: CheerioAPI, heading: El | null, pageUrl: URL): { scope: Sel; root: El | null } {
  const count = (el: El) =>
    descendants($, $(el), "a[href]").toArray().filter((a) => !inNoise(a, el) && classify($, a, el, pageUrl).length > 0).length;

  if (heading && !isHidden($, heading)) {
    // Climb to the first block with entity links, then a little further while
    // that keeps adding them: a heading can sit in a small title box with one
    // artist link while the tag list is the box's sibling. The climb stops
    // at the page itself. Links inside other works' cards are excluded from
    // both this count and collection, so a neighboring card cannot add credits.
    let cur: El | null = heading;
    let found: { el: El; n: number } | null = null;
    for (let depth = 0, extra = 0; cur && depth < 10 && extra <= 3; depth++) {
      const tag = tagOf(cur);
      if (tag === "body" || tag === "html") break;
      const n = count(cur);
      if (found) {
        extra++;
        if (n > found.n) found = { el: cur, n };
      } else if (n > 0) {
        found = { el: cur, n };
      }
      cur = (cur as { parent?: El | null }).parent ?? null;
    }
    if (found) return { scope: $(found.el), root: found.el };
  }
  // The densest block of labeled entity links, outside noise.
  let best: El | null = null;
  let bestScore = 0;
  $("ul, ol, table, dl, div, section, article").each((_, el) => {
    if (inNoise(el, null)) return;
    const n = count(el);
    if (n === 0) return;
    // Prefer the tightest block: score by links, lightly penalise size.
    const size = pageSizes?.size.get(el) ?? descendants($, $(el), "*").length;
    const score = n * 10 - size * 0.05;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  });
  if (best) return { scope: $(best), root: best };
  if (heading) {
    const container = $(heading).parent();
    return { scope: container.length ? container : $("body"), root: container.get(0) ?? null };
  }
  return { scope: $("body"), root: null };
}

/** Read one page. `pageUrl` is where it was served from (after redirects). */
export function readPage(html: string, pageUrl: string): PageReading {
  const $ = cheerio.load(html);
  // Cheerio text/clone helpers recurse. Refuse a pathological tree before
  // calling them, instead of letting a raw RangeError escape the scraper.
  const pending: { el: El; depth: number }[] = [{ el: $.root().get(0)!, depth: 0 }];
  while (pending.length) {
    const { el, depth } = pending.pop()!;
    if (depth > 256) return { kind: "none", reason: "the page exceeds the DOM depth limit (256)" };
    for (const child of (el as { children?: El[] }).children ?? []) pending.push({ el: child, depth: depth + 1 });
  }
  try {
    const decl = declared($);
    ownTitle = fold(`${decl.title} ${textOf($, $("title"))}`);
    $("script, style, noscript, template, svg, iframe, link").remove();
    pageSizes = measure($.root().get(0)!);
    return read($, new URL(pageUrl), decl);
  } finally {
    pageSizes = null;
    ownTitle = "";
    otherWorkCards = null;
  }
}

// A reader page — the address is the gallery's plus a page number
// ("/gallery/12345/3/") — that links back to the gallery itself. Its heading
// names the title, but its image is one page and its Prev/Next links are not a
// page count, so the gallery is read instead.
function backToGallery($: CheerioAPI, pageUrl: URL, id: string | null): { url: string; why: string } | null {
  if (!id) return null;
  const here = pageUrl.pathname.split("/").filter(Boolean);
  let best: URL | null = null;
  for (const a of $("a[href]").toArray()) {
    const abs = absoluteUrl(attrOf(a, "href"), pageUrl.toString());
    const u = abs ? parseWebUrl(abs) : null;
    if (!u || !isSameSite(u.hostname, pageUrl.hostname) || galleryIdOf(u) !== id) continue;
    const there = u.pathname.split("/").filter(Boolean);
    if (there.length >= here.length) continue;
    // What the shorter address drops must include a page number.
    const dropped = here.filter((seg) => !there.includes(seg));
    if (!dropped.some((seg) => /^\d{1,4}$/.test(seg))) continue;
    if (!best || there.length < best.pathname.split("/").filter(Boolean).length) best = u;
  }
  return best ? { url: best.toString(), why: "went from the reader page to the gallery" } : null;
}

// "Title – Some Series dj": the doujin of a series, said in the title's tail
// (blogs write it this way). The series is the parody; the title is the rest.
function djTail(raw: string): { title: string; parody: string | null } {
  const m = raw.match(/^(.*\S)\s+[–—-]\s+(.+?)\s+dj\.?$/i);
  return m ? { title: m[1], parody: m[2] } : { title: raw, parody: null };
}

function read($: CheerioAPI, url: URL, decl: Declared): PageReading {
  const id = galleryIdOf(url);
  const site = siteWords(url, decl.siteName);

  const docTitle = `${decl.title} ${textOf($, $("title"))}`;
  const heading = findHeading($, url, site, docTitle);
  const headingText = heading ? titleText($, heading) : "";
  // The heading names the title when it is the page's <h1> or the document's
  // own title says the same; a lone <h2> that does neither is more likely a
  // section heading, and the declared title is the better bet.
  const headingCounts = !!heading && (tagOf(heading) === "h1" || attrOf(heading, "itemprop") === "name" ||
    (fold(headingText).length >= 4 && fold(docTitle).includes(fold(headingText))));
  const declaredText = stripSiteName(decl.title, site) || stripSiteName(textOf($, $("title")), site);
  const rawTitle = cleanText((headingCounts ? headingText : declaredText || headingText) || declaredText).slice(0, MAX_TITLE_TEXT);
  const bodyText = textOf($, $("body"));

  if (!rawTitle || NOT_A_TITLE.test(rawTitle)) {
    const follow = followLink($, url, id);
    if (follow) return { kind: "follow", ...follow };
    return { kind: "none", reason: rawTitle ? `the page is "${rawTitle.slice(0, 60)}", not a title` : "the page has no title" };
  }
  const reader = backToGallery($, url, id);
  if (reader) return { kind: "follow", ...reader };

  otherWorkCards = findOtherWorkCards($, heading, url);
  const { scope, root } = chooseScope($, heading, url);
  const { hits, titled } = collectEntities($, scope, root, url, prettyTitle(rawTitle));
  const rows = labeledRows($, scope);
  const pages = pageCount($, scope, rows, url, id) || decl.pages;
  const uploaded_at = uploadDay($, scope, root, rows, decl);
  const { url: image_link, explicit: ownCover } = findCover($, scope, root, decl, url);

  // Warning pages often repeat the title and og:image. Those declarations
  // alone must not outrank the gate when the body has no work metadata.
  if (pages === 0 && hits.length === 0 && titled.length === 0 && GATE_TEXT.test(bodyText)) {
    const follow = followLink($, url, id);
    if (follow) return { kind: "follow", ...follow };
  }

  const bag = new EntityBag();
  for (const h of hits) bag.add(h.kind, h.name, h.link, h.count);
  const linked = bag.result();
  const linkedKinds = (["artists", "groups", "parodies", "characters"] as const).filter((k) => linked[k].length > 0).length;
  const linkedTags = linked.tags.length;
  // A link named like the title is no evidence the page IS a title (an artist's
  // or a tag's own page is headed with its name), but on a page that is one it
  // is still the page's word for a kind it otherwise left empty — and it
  // outranks the title's brackets below.
  const titledKinds = new Set<string>();
  for (const h of titled) {
    if (h.kind === "tags" || (linked[h.kind].length > 0 && !titledKinds.has(h.kind))) continue;
    titledKinds.add(h.kind);
    bag.add(h.kind, h.name, h.link, h.count);
  }
  // What the title's own brackets (and a "– Series dj" tail) say, for kinds the
  // page did not list.
  const tail = djTail(prettyTitle(rawTitle));
  const conv = fromTitleConvention(rawTitle.replace(/\s+[–—-]\s+[^[\]()]+?\s+dj\.?(?=\s*(?:\[[^\]]*\]\s*)*$)/i, ""));
  if (tail.parody) conv.parodies.push(tail.parody);
  const fromConvention = conv.groups.length + conv.artists.length + conv.parodies.length > 0;
  if (!linked.groups.length && !titledKinds.has("groups")) conv.groups.forEach((n) => bag.add("groups", n, ""));
  // A declared author is an artist only on a declared book/comic — on an
  // article it is whoever wrote the article.
  const looksLikeWork = /book|comic|manga/i.test(decl.type);
  if (!linked.artists.length && !titledKinds.has("artists")) [...conv.artists, ...(looksLikeWork ? decl.authors : [])].forEach((n) => bag.add("artists", n, ""));
  if (!linked.parodies.length && !titledKinds.has("parodies")) conv.parodies.forEach((n) => bag.add("parodies", n, ""));
  const entities = bag.result();
  // A tag that names the title's own parody, artist, group or character is that
  // entity listed twice (a blog files the post under its series as a category).
  const named = new Set((["parodies", "artists", "groups", "characters"] as const).flatMap((k) => entities[k].map((e) => e.name)));
  entities.tags = entities.tags.filter((t) => !named.has(t.name));

  // Enough to be a title: what the PAGE says — entity links, a page count, a
  // cover — not just a heading that reads like a doujin's name (a content
  // warning repeats the gallery's name and says nothing else). Tags and a cover
  // alone are what a news article has too, so they need a second voice: the
  // title convention, a declared book/comic, or a page count.
  // A page that declares itself an article (news, a blog post) is about a work
  // more often than it is one: its links to characters and series are what the
  // article mentions. It is a title only when it also reads like one — a page
  // count, the doujin title convention, or a declared book/comic.
  // Listing cards may sit beside a profile's metadata rather than inside it.
  // Count across the page when its own metadata could still be a profile.
  // Strong work evidence outranks recommendations beside a gallery's info.
  const others = otherTitles($, $("body"), null, url, id);
  const cover = !!image_link;
  // A bare slug may name a fandom/artist with credits and aggregate Pages.
  // Its own cover plus metadata, or reader links for this same work, gives a
  // second voice. A numeric gallery identity plus a count is also work-shaped;
  // keep sparse numbered galleries without treating a slug's Pages as proof.
  const numberedWork = /^\d+(?:\/[0-9a-f]{6,40})?$/i.test(id ?? "");
  // A declared image corroborated by an author and several descriptive tags
  // can identify a work without a marked DOM cover. Profiles have their own
  // entity name/type/context, rather than just metadata about other names.
  const describedWork = others >= 5 && !!decl.image && cover &&
    image_link === absoluteUrl(decl.image, url.toString()) && linked.artists.length > 0 && linkedTags >= 2 &&
    !isEntityProfile($, scope, heading, url, decl, titled, prettyTitle(rawTitle));
  const listing = others >= 5 && !(looksLikeWork ||
    (ownCover && (pages > 0 || linkedKinds > 0 || linkedTags > 0 || fromConvention)) ||
    (numberedWork && pages > 0) || describedWork || hasOwnReader($, url, id));
  const isArticle = /article|blogposting|newsarticle|report/i.test(decl.type);
  // A parenthesized suffix alone is common in news headlines ("Updated",
  // "Video", even a series name). Only the convention's credit brackets
  // add work evidence to an article.
  const strong = pages > 0 || conv.artists.length > 0 || conv.groups.length > 0 || looksLikeWork;
  const isGallery =
    !!id &&
    !listing &&
    (isArticle
      ? strong && (linkedKinds > 0 || linkedTags > 0 || cover)
      : linkedKinds > 0 ||
        pages > 0 ||
        (cover && (fromConvention || looksLikeWork)) ||
        (linkedTags >= 3 && fromConvention));

  if (!isGallery) {
    const follow = followLink($, url, id);
    if (follow) return { kind: "follow", ...follow };
    if (!id) return { kind: "none", reason: "the address does not name a single title" };
    // A password field that is part of the page — not a sign-in dialog the site
    // keeps hidden on every page.
    const passwordOnPage = $("input[type=password]").toArray().some((el) =>
      !isHidden($, el) && !$(el).closest("[class*='modal'], [class*='popup'], [class*='dialog'], [class*='overlay'], [role='dialog']").length);
    if (passwordOnPage && /log ?in|sign ?in|logged in/i.test(bodyText)) {
      return { kind: "none", reason: "the page is a login wall" };
    }
    if (listing) return { kind: "none", reason: "the page lists other titles — a listing, not a title" };
    return { kind: "none", reason: "the page has no title data (no artists, tags, page count or cover)" };
  }

  return {
    kind: "gallery",
    title: {
      title_name: clip(prettyTitle(firstOfBilingual(tail.title))),
      image_link: image_link.length <= 1024 ? image_link : "",
      pages: pages > 0 && pages <= 100_000 ? pages : 0,
      uploaded_at,
      ...entities,
    },
  };
}
