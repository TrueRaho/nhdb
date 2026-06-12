import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
