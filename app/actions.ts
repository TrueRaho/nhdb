"use server";

import { updateTag } from "next/cache";
import {
  deleteTitle, markRead, updateAlterName, upsertScrapedTitle,
  queryTitles, getStats, getSimilar, getTitle, getTitlesByHashtags, getTagAffinity,
  getGhostTagsFor,
  type QueryParams, type TagAffinityParams,
} from "../lib/titles";
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
  const saved = await upsertScrapedTitle(scraped);
  const name = alterName?.trim();
  if (name) await updateAlterName(scraped.hashtag, name);
  updateTag("titles-list");
  updateTag("dataset");
  updateTag("stats");
  updateTag(`title-${scraped.hashtag}`);
  updateTag(`similar-${scraped.hashtag}`);
  // Broad tag: cached similar-<other> lists of NEIGHBOR titles (tag overlap)
  // reference this title too and would otherwise go stale forever.
  updateTag("similar");
  // `saved` predates the alterName write, so patch the mapped item rather than
  // re-reading the row with all its relations.
  const item = dbTitleToItem(saved);
  return name ? { ...item, alterName: name } : item;
}

export async function deleteTitleAction(hashtag: number) {
  await deleteTitle(hashtag);
  updateTag("titles-list");
  updateTag(`title-${hashtag}`);
  updateTag(`similar-${hashtag}`);
  updateTag("similar"); // neighbors' similar lists may include the deleted title
  updateTag("dataset");
  updateTag("stats");
}

export async function markReadAction(hashtag: number) {
  await markRead(hashtag);
  updateTag("titles-list");
  updateTag(`title-${hashtag}`);
  updateTag("stats");
}

export async function updateAlterNameAction(hashtag: number, alterName: string) {
  await updateAlterName(hashtag, alterName);
  updateTag("titles-list");
  updateTag(`title-${hashtag}`);
  updateTag("similar"); // neighbors' similar lists show this title's name
  updateTag("stats"); // alterName feeds stats.recentSessions.name / mostRead.alterName
}

export async function queryTitlesAction(params: QueryParams): Promise<{ items: Item[]; total: number }> {
  const res = await queryTitles(params);
  return { items: res.items.map(dbTitleToItem), total: res.total };
}

// timeZone comes from the browser (Intl.resolvedOptions) — the hour-of-day and
// day-of-week charts are rendered as local wall-clock, so they must be bucketed
// in the viewer's zone rather than the database's.
export async function getStatsAction(timeZone?: string) {
  return getStats(timeZone);
}

export async function getSimilarAction(hashtag: number, limit = 8) {
  return getSimilar(hashtag, limit);
}

// Fetched on demand rather than shipped inside getDataset(): the full
// tag-to-tag matrix grows with the square of the tag count, and the dataset payload is handed to every
// client on first render — including phones, which is exactly what the split
// layout exists to keep light.
export async function getTagAffinityAction(params: TagAffinityParams) {
  return getTagAffinity(params);
}

// One title's inferred tags, for the detail view. Reads the same cached index
// the query path filters through, so an open modal costs no extra database work.
export async function getGhostTagsAction(hashtag: number) {
  return getGhostTagsFor(hashtag);
}

export async function getTitleAction(hashtag: number): Promise<Item | null> {
  const t = await getTitle(hashtag);
  return t ? dbTitleToItem(t) : null;
}

// Which of these hashtags are already in the collection? Uncached read —
// the add flow uses it to skip re-scraping known titles.
export async function findExistingTitlesAction(hashtags: number[]): Promise<Item[]> {
  const titles = await getTitlesByHashtags(hashtags);
  return titles.map(dbTitleToItem);
}
