import type { Item } from "./data";
import type { TitleWithRelations } from "./titles";

export type DbTitle = TitleWithRelations;

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
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
    tags: title.tags.map((r) => r.tag.tagName),
    artists: title.artists.map((r) => r.artist.artistName),
    groups: title.groups.map((r) => r.group.groupName),
    parodies: title.parodies.map((r) => r.parody.parodieName),
    characters: title.characters.map((r) => r.character.characterName),
  };
}
