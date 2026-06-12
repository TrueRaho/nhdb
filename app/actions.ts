"use server";

import { updateTag } from "next/cache";
import {
  deleteTitle, markRead, updateAlterName, upsertScrapedTitle,
  queryTitles, getStats, getSimilar, getTitle, getTitlesByHashtags,
  type QueryParams,
} from "../lib/titles";
import { dbTitleToItem } from "../lib/mappers";
import type { Item } from "../lib/data";
import type { ScrapeResult } from "../lib/scraper";

// Persist a scraped payload and invalidate caches with read-your-writes
// semantics (updateTag is only allowed in Server Actions, not Route Handlers).
export async function commitScrapedAction(scraped: ScrapeResult): Promise<Item> {
  const saved = await upsertScrapedTitle(scraped);
  updateTag("titles-list");
  updateTag("dataset");
  updateTag("stats");
  updateTag(`title-${scraped.hashtag}`);
  updateTag(`similar-${scraped.hashtag}`);
  return dbTitleToItem(saved);
}

export async function deleteTitleAction(hashtag: number) {
  await deleteTitle(hashtag);
  updateTag("titles-list");
  updateTag(`title-${hashtag}`);
  updateTag(`similar-${hashtag}`);
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
}

export async function queryTitlesAction(params: QueryParams): Promise<{ items: Item[]; total: number }> {
  const res = await queryTitles(params);
  return { items: res.items.map(dbTitleToItem), total: res.total };
}

export async function getStatsAction() {
  return getStats();
}

export async function getSimilarAction(hashtag: number, limit = 8) {
  return getSimilar(hashtag, limit);
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
