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

// A hashtag as the database stores it: a positive integer that fits the INT4
// column. For ids arriving from the client, where anything can show up.
export function isHashtag(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2_147_483_647
}
