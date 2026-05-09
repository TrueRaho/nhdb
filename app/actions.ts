"use server";

import { updateTag } from "next/cache";
import {
  deleteTitle, markRead, updateAlterName,
  queryTitles, getStats, getSimilar, getTitle,
  type QueryParams,
} from "../lib/titles";
import { dbTitleToItem } from "../lib/mappers";
import type { Item } from "../lib/data";

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
  updateTag("read-logs");
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
