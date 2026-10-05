// The swipe deck (/swipe): every title that has no custom name yet, one
// full-screen cover at a time, in a fresh random order each time it opens.
//
//   right  keep it — only with a name typed in, which is saved as its alter name,
//          so the title never comes back (the deck is "titles without a name")
//   left   onto the deletion list; nothing is deleted until the list is emptied
//   down   not now — it comes back POSTPONE_GAP cards later
//   up     not assigned yet
//   tap    open the title on its own site
//
// Everything here is pure or a thin guard around localStorage, so the rules are
// testable without a DOM. The UI is components/Swipe.tsx.

import { isHashtag } from "./utils";

export type SwipeDirection = "left" | "right" | "up" | "down";

/** Cards a postponed title waits behind before it comes back. */
export const POSTPONE_GAP = 4;

/** Covers kept loaded ahead of the current one. */
export const PREFETCH_AHEAD = 5;

/** Hashtags per card fetch; getSwipeCardsAction caps a call at this. */
export const CARD_BATCH = 10;

/** Titles per delete; lib/titles.ts deleteTitles caps a call at this, and the
 *  deletion list is emptied in chunks of it. */
export const DELETE_BATCH = 500;

/** A drag this long (px) commits a swipe; a narrow card needs a quarter of its width. */
export const SWIPE_DISTANCE = 110;

/** …or a flick this fast (px/ms), once it has moved FLICK_MIN px. */
export const SWIPE_VELOCITY = 0.5;
export const FLICK_MIN = 30;

/** Less movement than this, released this quickly, is a tap. */
export const TAP_SLOP = 10;
export const TAP_MS = 350;

/**
 * Fisher–Yates. Never mutates the input. `random` is injectable so the order
 * can be pinned in tests; the deck itself uses Math.random, reshuffling on
 * every open as asked.
 */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Move the current card (queue[0]) back so that `gap` other titles come first;
 * with fewer left than that, it goes last. A queue of one stays as it is.
 */
export function postpone(queue: readonly number[], gap = POSTPONE_GAP): number[] {
  if (queue.length <= 1) return [...queue];
  const [current, ...rest] = queue;
  const at = Math.min(gap, rest.length);
  return [...rest.slice(0, at), current, ...rest.slice(at)];
}

/**
 * What a finished drag meant. The dominant axis decides the direction; it has
 * to travel far enough (or be flicked fast enough) to count, otherwise the card
 * springs back. `width` is the card's; 0 (not measured) falls back to the
 * fixed distance.
 */
export function classifyGesture(dx: number, dy: number, ms: number, width: number): SwipeDirection | "tap" | null {
  const moved = Math.hypot(dx, dy);
  if (moved < TAP_SLOP) return ms <= TAP_MS ? "tap" : null;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const along = horizontal ? Math.abs(dx) : Math.abs(dy);
  const threshold = width > 0 ? Math.min(SWIPE_DISTANCE, width * 0.25) : SWIPE_DISTANCE;
  const flick = along >= FLICK_MIN && along / Math.max(ms, 1) >= SWIPE_VELOCITY;
  if (along < threshold && !flick) return null;
  if (horizontal) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

// ---------------------------------------------------------------------------
// The deletion list. It lives in this browser, per account, like the scrape
// queue: a list of intentions, not a change to the collection, so losing it
// (cleared storage, another device) costs nothing but a re-swipe. Enough is
// kept per entry to show the list without refetching the titles.

export type TrashEntry = {
  hashtag: number;
  /** How the list names the title ("#177013", "hitomi 1234567"). */
  label: string;
  titleName: string;
  imageLink: string;
  /** The title's page — its origin is the cover's Referer. "" on older lists. */
  url: string;
  pages: number;
};

export const trashKey = (userId: string) => `nhdb.swipe.trash.v1:${userId}`;

/** Storage can hold anything; keep only well-formed entries, first of each hashtag. */
export function parseTrash(raw: string | null): TrashEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<number>();
  const out: TrashEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const { hashtag, label, titleName, imageLink, url, pages } = e as Record<string, unknown>;
    if (!isHashtag(hashtag) || seen.has(hashtag)) continue;
    seen.add(hashtag);
    out.push({
      hashtag,
      // Lists saved before titles came from several sites carry no label.
      label: typeof label === "string" && label.length > 0 && label.length <= 80 ? label : `#${hashtag}`,
      titleName: typeof titleName === "string" ? titleName : `#${hashtag}`,
      imageLink: typeof imageLink === "string" ? imageLink : "",
      url: typeof url === "string" ? url : "",
      pages: typeof pages === "number" && Number.isFinite(pages) ? pages : 0,
    });
  }
  return out;
}

export function withEntry(list: readonly TrashEntry[], entry: TrashEntry): TrashEntry[] {
  return list.some((e) => e.hashtag === entry.hashtag) ? [...list] : [...list, entry];
}

export function withoutHashtags(list: readonly TrashEntry[], hashtags: Iterable<number>): TrashEntry[] {
  const drop = new Set(hashtags);
  return list.filter((e) => !drop.has(e.hashtag));
}

// Every access is guarded: storage can be blocked (private mode) or full, and a
// list that cannot be saved must not take the deck down with it.
export function readTrash(userId: string): TrashEntry[] {
  try {
    return parseTrash(localStorage.getItem(trashKey(userId)));
  } catch {
    return [];
  }
}

function writeTrash(userId: string, list: TrashEntry[]): void {
  try {
    if (list.length) localStorage.setItem(trashKey(userId), JSON.stringify(list));
    else localStorage.removeItem(trashKey(userId));
  } catch {}
}

// Read-modify-write against storage rather than a copy held in memory, so two
// open tabs add to one list instead of overwriting each other's.
export function addToTrash(userId: string, entry: TrashEntry): TrashEntry[] {
  const next = withEntry(readTrash(userId), entry);
  writeTrash(userId, next);
  return next;
}

export function removeFromTrash(userId: string, hashtags: Iterable<number>): TrashEntry[] {
  const next = withoutHashtags(readTrash(userId), hashtags);
  writeTrash(userId, next);
  return next;
}
