"use server";

import { updateTag } from "next/cache";
import { requireUserId } from "../lib/session";
import { titlesListTag, datasetTag, statsTag, titleTag, similarTag, similarAnyTag } from "../lib/cache-tags";
import {
  deleteTitle, deleteTitles, markRead, updateAlterName, upsertScrapedTitle,
  queryTitles, getStats, getSimilar, getTitle, getTitlesByHashtags, getTagAffinity,
  getGhostTagsFor, getUnnamedHashtags,
  type QueryParams, type TagAffinityParams,
} from "../lib/titles";
import { isHashtag } from "../lib/utils";
import { CARD_BATCH } from "../lib/swipe";
import { dbTitleToItem } from "../lib/mappers";
import type { Item } from "../lib/data";
import type { ScrapeResult } from "../lib/scraper";

// Persist a scraped payload and invalidate caches with read-your-writes
// semantics (updateTag is only allowed in Server Actions, not Route Handlers).
//
// `alterName` lets the quick-add screen name a title in the same round trip
// that creates it. It is applied as a separate write on purpose: the scrape
// path must never touch alterName on its own (a re-scrape would wipe the user's
// name), so upsertScrapedTitle stays unaware of it. Omitted or blank leaves any
// existing name untouched.
export async function commitScrapedAction(scraped: ScrapeResult, alterName?: string): Promise<Item> {
  const userId = await requireUserId();
  const saved = await upsertScrapedTitle(userId, scraped);
  const name = alterName?.trim();
  if (name) await updateAlterName(userId, scraped.hashtag, name);
  updateTag(titlesListTag(userId));
  updateTag(datasetTag(userId));
  updateTag(statsTag(userId));
  updateTag(titleTag(userId, scraped.hashtag));
  updateTag(similarTag(userId, scraped.hashtag));
  // Broad tag: cached similar-<other> lists of NEIGHBOR titles (tag overlap)
  // reference this title too and would otherwise go stale forever.
  updateTag(similarAnyTag(userId));
  // `saved` predates the alterName write, so patch the mapped item rather than
  // re-reading the row with all its relations.
  const item = dbTitleToItem(saved);
  return name ? { ...item, alterName: name } : item;
}

export async function deleteTitleAction(hashtag: number) {
  const userId = await requireUserId();
  await deleteTitle(userId, hashtag);
  updateTag(titlesListTag(userId));
  updateTag(titleTag(userId, hashtag));
  updateTag(similarTag(userId, hashtag));
  updateTag(similarAnyTag(userId)); // neighbors' similar lists may include the deleted title
  updateTag(datasetTag(userId));
  updateTag(statsTag(userId));
}

export async function markReadAction(hashtag: number) {
  const userId = await requireUserId();
  await markRead(userId, hashtag);
  updateTag(titlesListTag(userId));
  updateTag(titleTag(userId, hashtag));
  updateTag(statsTag(userId));
}

export async function updateAlterNameAction(hashtag: number, alterName: string) {
  const userId = await requireUserId();
  await updateAlterName(userId, hashtag, alterName);
  updateTag(titlesListTag(userId));
  updateTag(titleTag(userId, hashtag));
  updateTag(similarAnyTag(userId)); // neighbors' similar lists show this title's name
  updateTag(statsTag(userId)); // alterName feeds stats.recentSessions.name / mostRead.alterName
}

export async function queryTitlesAction(params: QueryParams): Promise<{ items: Item[]; total: number }> {
  const userId = await requireUserId();
  const res = await queryTitles(userId, params);
  return { items: res.items.map(dbTitleToItem), total: res.total };
}

// timeZone comes from the browser (Intl.resolvedOptions) — the hour-of-day and
// day-of-week charts are rendered as local wall-clock, so they must be bucketed
// in the viewer's zone rather than the database's.
export async function getStatsAction(timeZone?: string) {
  const userId = await requireUserId();
  return getStats(userId, timeZone);
}

export async function getSimilarAction(hashtag: number, limit = 8) {
  const userId = await requireUserId();
  return getSimilar(userId, hashtag, limit);
}

// Fetched on demand rather than shipped inside getDataset(): the full
// tag-to-tag matrix grows with the square of the tag count, and the dataset payload is handed to every
// client on first render — including phones, which is exactly what the split
// layout exists to keep light.
export async function getTagAffinityAction(params: TagAffinityParams) {
  const userId = await requireUserId();
  return getTagAffinity(userId, params);
}

// One title's inferred tags, for the detail view. Reads the same cached index
// the query path filters through, so an open modal costs no extra database work.
export async function getGhostTagsAction(hashtag: number) {
  const userId = await requireUserId();
  return getGhostTagsFor(userId, hashtag);
}

export async function getTitleAction(hashtag: number): Promise<Item | null> {
  const userId = await requireUserId();
  const t = await getTitle(userId, hashtag);
  return t ? dbTitleToItem(t) : null;
}

// Which of these hashtags are already in the collection? Uncached read —
// the add flow uses it to skip re-scraping known titles.
export async function findExistingTitlesAction(hashtags: number[]): Promise<Item[]> {
  const userId = await requireUserId();
  const titles = await getTitlesByHashtags(userId, hashtags);
  return titles.map(dbTitleToItem);
}

// --- The swipe deck (app/swipe): name what has no name yet, or let it go ---

// Every title without a custom name. The client shuffles — a new order on
// every open — and loads the cards a few at a time. Read only.
export async function getSwipeDeckAction(): Promise<number[]> {
  const userId = await requireUserId();
  return getUnnamedHashtags(userId);
}

// The next few cards, in the order asked for. Uncached like the add flow's
// lookup: a title deleted a moment ago simply doesn't come back.
export async function getSwipeCardsAction(hashtags: number[]): Promise<Item[]> {
  const userId = await requireUserId();
  const ids = Array.isArray(hashtags) ? hashtags.filter(isHashtag).slice(0, CARD_BATCH) : [];
  if (ids.length === 0) return [];
  const byHashtag = new Map((await getTitlesByHashtags(userId, ids)).map((t) => [t.hashtag, dbTitleToItem(t)]));
  return ids.flatMap((h) => byHashtag.get(h) ?? []);
}

// Empty the deletion list: every title in ONE statement (lib/titles.ts
// deleteTitles), then what deleteTitleAction invalidates, for each title that
// was actually deleted.
export async function deleteTitlesAction(hashtags: number[]): Promise<number[]> {
  const userId = await requireUserId();
  const deleted = await deleteTitles(userId, hashtags);
  if (deleted.length > 0) {
    updateTag(titlesListTag(userId));
    for (const hashtag of deleted) {
      updateTag(titleTag(userId, hashtag));
      updateTag(similarTag(userId, hashtag));
    }
    updateTag(similarAnyTag(userId)); // neighbours' similar lists include the deleted titles
    updateTag(datasetTag(userId));
    updateTag(statsTag(userId));
  }
  return deleted;
}
