import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Human "time ago" from a whole-day count (as produced by lib/mappers `daysAgo`).
//   "long"  → "today" | "3 days ago" | "2 weeks ago" | "4 months ago" | "1.2 years ago"
//   "short" → "today" | "3d" | "2w" | "4mo"
// Returns "—" for null so callers can render it directly; guard upstream when a
// null value should hide the element instead.
export function daysAgoLabel(d: number | null, style: "long" | "short" = "long"): string {
  if (d == null) return "—"
  // Clock skew / future dates can yield negative day counts — clamp to "today".
  if (d <= 0) return "today"
  if (style === "short") {
    if (d < 7) return `${d}d`
    if (d < 30) return `${Math.floor(d / 7)}w`
    return `${Math.floor(d / 30)}mo`
  }
  if (d < 7) return `${d} days ago`
  if (d < 30) return `${Math.floor(d / 7)} weeks ago`
  if (d < 365) return `${Math.floor(d / 30)} months ago`
  return `${(d / 365).toFixed(1)} years ago`
}

// Parse "177013", "#177013" or an nhentai.net/g/<id> URL into a numeric hashtag.
// Lives here (not in scraper.ts) so client components can use it without
// pulling cheerio/playwright into the bundle.
export function extractHashtag(input: string): number | null {
  const t = input.trim()
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  const urlMatch = t.match(/nhentai\.net\/g\/(\d+)/)
  if (urlMatch) return parseInt(urlMatch[1], 10)
  const hashMatch = t.match(/^#?(\d+)$/)
  if (hashMatch) return parseInt(hashMatch[1], 10)
  return null
}

// Pull every gallery id out of an arbitrary blob of text, in paste order,
// deduped. This is the *batch* counterpart to extractHashtag: the add box is
// filled by pasting far more often than by typing, and iOS Safari's "Copy
// Links" (tab overview → long-press "N Tabs" → Copy Links) dumps every open
// tab at once, interleaving page TITLES with the URLs. Splitting such a dump
// into tokens and running extractHashtag over each one turned every word of
// every title into its own bogus entry.
//
// A /g/<id> URL is unambiguous and always counts, whatever the id's length.
// Bare numbers are trusted only as far as their company allows: when every
// token is a number the box was typed by hand, so any digit run counts; as soon
// as prose is mixed in it is a paste, where stray digits are page counts, years
// and chapter numbers, so only id-shaped runs (5-7 digits) survive. Consequence:
// a pre-10000 gallery inside a paste has to arrive as a URL, not a bare number.
export function parseInputs(text: string): number[] {
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  const typedByHand = tokens.every((t) => /^#?\d+$/.test(t))
  const bare = typedByHand ? /^#?(\d+)$/ : /^#?(\d{5,7})$/
  const ids: number[] = []
  const seen = new Set<number>()

  const push = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isSafeInteger(n) || n <= 0 || seen.has(n)) return
    seen.add(n)
    ids.push(n)
  }

  // One left-to-right pass over the tokens keeps the output in paste order. A
  // URL is matched anywhere inside its token, so surrounding punctuation
  // (markdown link syntax, a trailing slash, quotes) is fine.
  for (const token of tokens) {
    const url = token.match(/nhentai\.net\/g\/(\d+)/)
    if (url) { push(url[1]); continue }
    const m = token.match(bare)
    if (m) push(m[1])
  }
  return ids
}

// Query param that queues titles straight from a link: `/?add=177013,895243`.
// Kept short because it is typed into an iOS Shortcut by hand.
export const ADD_PARAM = "add"

// Ids carried by an `?add=` deep link, given a location.search string.
// URLSearchParams does the percent-decoding, so the param may hold bare ids, a
// comma/space separated list, or whole encoded nhentai URLs — parseInputs
// treats all three the same way it treats a paste. Repeats (`?add=1&add=2`) are
// joined rather than dropped, since a share-sheet shortcut may append instead
// of building one value.
export function readAddParam(search: string): number[] {
  const raw = new URLSearchParams(search).getAll(ADD_PARAM).join(" ")
  return raw ? parseInputs(raw) : []
}
