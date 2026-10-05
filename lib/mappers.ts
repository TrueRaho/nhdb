import type { Item } from "./data";
import type { ScrapeResult } from "./scrape-payload";
import { isSourceKey, titleUrl } from "./sources";
import type { TitleWithRelations } from "./titles";

export type DbTitle = TitleWithRelations;

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

export function dbTitleToItem(title: DbTitle): Item {
  return {
    hashtag: title.hashtag,
    // The column is written only by the validated upsert; the guard keeps a
    // hand-edited row from handing the client a source it cannot render.
    source: isSourceKey(title.source) ? title.source : "nhentai",
    sourceId: title.sourceId,
    url: titleUrl(title.source, title.sourceId, title.url),
    titleName: title.titleName,
    alterName: title.alterName ?? "",
    imageLink: title.imageLink,
    pages: title.pages,
    uploadedAt: title.uploadedAt ? daysAgo(title.uploadedAt) : null,
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

/**
 * A scraped, not-yet-saved title as the client shows it (the add list, the
 * quick-add screen). Client-safe: only type imports above, besides sources.
 */
export function scrapedToItem(s: ScrapeResult): Item {
  return {
    // nhentai's key is known before the save; another site's is not.
    hashtag: s.source === "nhentai" ? Number(s.source_id) : 0,
    source: s.source,
    sourceId: s.source_id,
    url: s.url,
    titleName: s.title_name,
    alterName: "",
    imageLink: s.image_link,
    pages: s.pages,
    uploadedAt: s.uploaded_at ? daysAgo(new Date(s.uploaded_at)) : null,
    addedAt: 0,
    readCount: 0,
    lastReadAt: null,
    tags: s.tags.map((t) => t.name),
    artists: s.artists.map((a) => a.name),
    groups: s.groups.map((g) => g.name),
    characters: s.characters.map((c) => c.name),
    parodies: s.parodies.map((p) => p.name),
  };
}
