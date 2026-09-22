// Cache tags, built in one place.
//
// Every tag is scoped to a user. The cached *values* are already isolated —
// `userId` is an argument of every read in lib/titles.ts and arguments are part
// of a `"use cache"` entry's key — so scoping the tags is not what keeps one
// collection out of another's results. It keeps one person's write from
// throwing away everyone else's cached pages, which on a shared deployment is
// both wasted work and a small side channel (B's page timing would move
// whenever A adds a title).
//
// Reader and invalidator must agree on the exact string, so neither side spells
// one out: lib/titles.ts calls these to tag, app/actions.ts and
// app/api/scrape/route.ts call the same ones to invalidate.

/** Result pages of queryTitles. */
export const titlesListTag = (userId: string) => `titles-list:${userId}`;

/** getDataset, and every derived read cached under it (affinity, ghost index). */
export const datasetTag = (userId: string) => `dataset:${userId}`;

/** getStats. */
export const statsTag = (userId: string) => `stats:${userId}`;

/** One title's row, as read by getTitle. */
export const titleTag = (userId: string, hashtag: number) => `title:${userId}:${hashtag}`;

/** One title's similarity list. */
export const similarTag = (userId: string, hashtag: number) => `similar:${userId}:${hashtag}`;

/**
 * Attached to *every* similarity list of this user, alongside the per-title tag.
 *
 * Cache tags match exactly, not by prefix, so this is the only way to bust all
 * of them at once — and that is needed on any write, because a title's
 * neighbours list it in their own results (tag overlap) and would otherwise
 * stay stale forever.
 */
export const similarAnyTag = (userId: string) => `similar:${userId}`;
