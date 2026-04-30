import { mulberry32, type Item } from "./data";
import type { listTitles } from "./titles";

export type DbTitle = Awaited<ReturnType<typeof listTitles>>[number];

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function hashtagToPalette(hashtag: number): [string, string] {
  const rng = mulberry32(hashtag);
  const toHex = (n: number) =>
    "#" + Math.floor(n * 0xffffff).toString(16).padStart(6, "0");
  return [toHex(rng()), toHex(rng())];
}

export function dbTitleToItem(title: DbTitle): Item {
  return {
    hashtag: title.hashtag,
    titleName: title.titleName,
    alterName: title.alterName ?? "",
    imageLink: title.imageLink,
    pages: title.pages,
    uploadedAt: daysAgo(title.uploadedAt),
    addedAt: daysAgo(title.createdAt),
    readCount: title.readCount,
    lastReadAt: title.lastReadAt != null ? daysAgo(title.lastReadAt) : null,
    palette: hashtagToPalette(title.hashtag),
    tags: title.tags.map((r) => r.tag.tag_name),
    artists: title.artists.map((r) => r.artist.artist_name),
    groups: title.groups.map((r) => r.group.group_name),
    parodies: title.parodies.map((r) => r.parody.parodie_name),
    characters: title.characters.map((r) => r.character.character_name),
    seed: title.hashtag,
  };
}
