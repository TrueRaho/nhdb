import { seedFromString } from "./cover-art";
import { refKey, refLabel, type TitleKey } from "./sources";

// Client-facing shape of a title, produced by lib/mappers.ts from DB rows.
export type Item = {
  /**
   * The collection's key for the title. For nhentai it is the gallery id; a
   * title from another site gets one on first save (>= 1e9), so a scraped
   * preview that is not saved yet carries 0.
   */
  hashtag: number;
  /** Where the title comes from: its site (host name or legacy key) — see lib/sources.ts. */
  source: string;
  sourceId: string;
  /** The page the title is read at, on its site. */
  url: string;
  titleName: string;
  alterName: string;
  imageLink: string;
  pages: number;
  /** Days since upload, or null when the site does not say. */
  uploadedAt: number | null;
  addedAt: number;
  readCount: number;
  lastReadAt: number | null;
  tags: string[];
  artists: string[];
  groups: string[];
  parodies: string[];
  characters: string[];
};

type Sourced = Pick<Item, "source" | "sourceId">;

export const itemRef = (item: Sourced): TitleKey => ({ source: item.source, id: item.sourceId });

/** "#177013" for nhentai (as ever), "hitomi 1234567" for the rest. */
export const itemLabel = (item: Sourced): string => refLabel(itemRef(item));

/** The title's page on its own site. */
export const itemUrl = (item: Pick<Item, "url">): string => item.url;

/** Stable per-title identity for the client (job keys, dedup across a save). */
export const itemKey = (item: Sourced): string => refKey(itemRef(item));

/**
 * What /api/scrape is asked for to re-scrape a saved title: its page address.
 * A key ("3hentai.net:612345") names a title, but only the seven legacy sites'
 * keys can be turned back into an address — the rest would be refused.
 */
export const scrapeInputOf = (item: Sourced & Pick<Item, "url">): string => item.url || itemKey(item);

/**
 * Seed for the procedural cover art. nhentai titles keep their hashtag seed
 * (so every existing cover looks as it did); other sites seed from the ref,
 * which — unlike their hashtag — is the same before and after the first save.
 */
export const coverSeed = (item: Pick<Item, "hashtag" | "source" | "sourceId">): number =>
  item.source === "nhentai" ? item.hashtag : seedFromString(itemKey(item));
