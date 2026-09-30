import { cacheLife, cacheTag } from "next/cache";
import { Prisma } from "./generated/prisma/client";
import { prisma } from "./db";
import { datasetTag, similarAnyTag, similarTag, statsTag, titleTag, titlesListTag } from "./cache-tags";
import { MIN_SHARED_TITLES, rankAffinity, type AffinityRow, type TagAffinity } from "./affinity";
import { inferGhostTags, type GhostSource, type GhostSourceKind, type GhostTag } from "./ghost";
import type { ScrapeEntity, ScrapeResult } from "./scraper";
import { isHashtag } from "./utils";
import { DELETE_BATCH } from "./swipe";

// Session identity is resolved by callers outside cached scopes. Fail closed if
// a missing identity reaches this boundary: Prisma omits undefined filters.
function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("A user ID is required to access the collection");
  }
}

// One generic batch-upsert for all five entity kinds: a single
// INSERT … ON CONFLICT (user_id, name) DO UPDATE … RETURNING per category, so a
// re-scrape refreshes link/total_works on existing rows and RETURNING yields
// every id in one round trip. (The previous createMany({ skipDuplicates }) +
// findMany-by-name pair never refreshed existing rows, and any row skipped by
// the *link* unique was silently dropped from the id list.)
//
// The table/column identifiers are hardcoded literals from the five callers
// below (never user input), so embedding them via Prisma.raw is safe; entity
// name/link/total_works values are parameterized through Prisma.sql.
// Note: tags.title_count is trigger-owned (maintained by triggers on
// titlestotags), so it is deliberately absent from both the INSERT column
// list (defaults to 0 on insert) and the DO UPDATE SET (stays untouched).
async function batchUpsertEntities(
  db: Prisma.TransactionClient,
  userId: string,
  items: ScrapeEntity[],
  table: string,
  idCol: string,
  nameCol: string,
  linkCol: string,
): Promise<number[]> {
  if (items.length === 0) return [];
  // Dedup by name (last occurrence wins): a single INSERT … ON CONFLICT DO
  // UPDATE errors with "cannot affect row a second time" on duplicate names.
  const deduped = [...new Map(items.map((e) => [e.name, e])).values()];
  const rows = await db.$queryRaw<{ id: number; name: string }[]>(Prisma.sql`
    INSERT INTO ${Prisma.raw(`"${table}" (user_id, "${nameCol}", "${linkCol}", total_works)`)}
    VALUES ${Prisma.join(deduped.map((e) => Prisma.sql`(${userId}, ${e.name}, ${e.link}, ${e.total_works})`))}
    ON CONFLICT (user_id, ${Prisma.raw(`"${nameCol}"`)}) DO UPDATE
      SET ${Prisma.raw(`"${linkCol}" = EXCLUDED."${linkCol}"`)}, total_works = EXCLUDED.total_works
    RETURNING ${Prisma.raw(`"${idCol}" AS id, "${nameCol}" AS name`)}
  `);
  // RETURNING with DO UPDATE emits every affected row (inserted or updated),
  // so each input name resolves — ids come back in input order, no drops.
  const map = new Map(rows.map((r) => [r.name, r.id]));
  return items.map((e) => map.get(e.name)!);
}

const batchUpsertArtists = (db: Prisma.TransactionClient, userId: string, items: ScrapeEntity[]) =>
  batchUpsertEntities(db, userId, items, "artists", "id_artist", "artist_name", "artist_link");

const batchUpsertGroups = (db: Prisma.TransactionClient, userId: string, items: ScrapeEntity[]) =>
  batchUpsertEntities(db, userId, items, "groups", "id_group", "group_name", "group_link");

const batchUpsertCharacters = (db: Prisma.TransactionClient, userId: string, items: ScrapeEntity[]) =>
  batchUpsertEntities(db, userId, items, "characters", "id_character", "character_name", "character_link");

const batchUpsertParodies = (db: Prisma.TransactionClient, userId: string, items: ScrapeEntity[]) =>
  batchUpsertEntities(db, userId, items, "parodies", "id_parodie", "parodie_name", "parodie_link");

const batchUpsertTags = (db: Prisma.TransactionClient, userId: string, items: ScrapeEntity[]) =>
  batchUpsertEntities(db, userId, items, "tags", "id_tag", "tag_name", "tag_link");

// Thrown for a malformed client-supplied scrape payload. `name` is set to
// "ValidationError" so the /api/scrape route's isValidationError() maps it to
// HTTP 400 (not 500) — matching on the message would misfire on Prisma errors,
// whose messages often contain "Invalid".
class ScrapePayloadError extends Error {
  name = "ValidationError";
}

// Both the Server Action and the /api/scrape route pass client-supplied data
// here, so validate the payload shape before touching the database.
function assertValidScrapePayload(s: ScrapeResult): void {
  if (!s || typeof s !== "object")
    throw new ScrapePayloadError("Invalid scrape payload: expected an object");
  const isDbInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
  const isDbString = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 255;
  if (!isDbInteger(s.hashtag) || s.hashtag === 0)
    throw new ScrapePayloadError(`Invalid scrape payload: hashtag must be a positive integer, got ${s.hashtag}`);
  if (!isDbString(s.title_name))
    throw new ScrapePayloadError("Invalid scrape payload: title_name must be a string of at most 255 characters");
  if (!isDbString(s.image_link))
    throw new ScrapePayloadError("Invalid scrape payload: image_link must be a string of at most 255 characters");
  if (!isDbInteger(s.pages))
    throw new ScrapePayloadError(`Invalid scrape payload: pages must be a non-negative integer, got ${s.pages}`);
  for (const key of ["tags", "artists", "groups", "characters", "parodies"] as const) {
    if (!Array.isArray(s[key]))
      throw new ScrapePayloadError(`Invalid scrape payload: ${key} must be an array`);
    for (const entity of s[key]) {
      if (!entity || typeof entity !== "object" || !isDbString(entity.name) ||
          !isDbString(entity.link) || !isDbInteger(entity.total_works))
        throw new ScrapePayloadError(`Invalid scrape payload: ${key} contains an invalid entity`);
    }
  }
  if (typeof s.uploaded_at !== "string" || isNaN(new Date(s.uploaded_at).getTime()))
    throw new ScrapePayloadError(`Invalid scrape payload: uploaded_at is not a valid date, got ${s.uploaded_at}`);
}

export async function upsertScrapedTitle(userId: string, s: ScrapeResult) {
  assertUserId(userId);
  assertValidScrapePayload(s);

  return prisma.$transaction(async (tx) => {
    // Entity upserts live INSIDE the transaction on purpose: creating an
    // entity in autocommit and linking it in a later transaction leaves a
    // window where the entity exists with zero links — a concurrently
    // committing delete's deferred orphan sweep (migration 4) could reap it
    // and FK-abort this upsert. Created-and-linked atomically, a new entity
    // is invisible to other transactions until it already has its links.
    // Sequential awaits on purpose: Prisma discourages Promise.all inside an
    // interactive transaction — every tx query serializes on one connection
    // anyway, and concurrent awaits have caused ordering issues on some
    // adapters.
    const artistIds = await batchUpsertArtists(tx, userId, s.artists);
    const groupIds = await batchUpsertGroups(tx, userId, s.groups);
    const characterIds = await batchUpsertCharacters(tx, userId, s.characters);
    const parodyIds = await batchUpsertParodies(tx, userId, s.parodies);
    const tagIds = await batchUpsertTags(tx, userId, s.tags);

    // alterName is user-managed (set manually via updateAlterName) — the
    // scrape path never writes it, neither on create nor on re-scrape.
    const titleData = {
      titleName: s.title_name,
      imageLink: s.image_link,
      pages: s.pages,
      uploadedAt: new Date(s.uploaded_at),
    };

    await tx.title.upsert({
      where: { userId_hashtag: { userId, hashtag: s.hashtag } },
      create: { userId, hashtag: s.hashtag, ...titleData },
      update: titleData,
    });

    await tx.titleArtist.deleteMany({ where: { userId, hashtag: s.hashtag } });
    await tx.titleGroup.deleteMany({ where: { userId, hashtag: s.hashtag } });
    await tx.titleCharacter.deleteMany({ where: { userId, hashtag: s.hashtag } });
    await tx.titleParody.deleteMany({ where: { userId, hashtag: s.hashtag } });
    await tx.titleTag.deleteMany({ where: { userId, hashtag: s.hashtag } });

    if (artistIds.length)
      await tx.titleArtist.createMany({
        data: artistIds.map((idArtist) => ({ userId, hashtag: s.hashtag, idArtist })),
        skipDuplicates: true,
      });
    if (groupIds.length)
      await tx.titleGroup.createMany({
        data: groupIds.map((idGroup) => ({ userId, hashtag: s.hashtag, idGroup })),
        skipDuplicates: true,
      });
    if (characterIds.length)
      await tx.titleCharacter.createMany({
        data: characterIds.map((idCharacter) => ({ userId, hashtag: s.hashtag, idCharacter })),
        skipDuplicates: true,
      });
    if (parodyIds.length)
      await tx.titleParody.createMany({
        data: parodyIds.map((idParodie) => ({ userId, hashtag: s.hashtag, idParodie })),
        skipDuplicates: true,
      });
    if (tagIds.length)
      await tx.titleTag.createMany({
        data: tagIds.map((idTag) => ({ userId, hashtag: s.hashtag, idTag })),
        skipDuplicates: true,
      });

    return tx.title.findUniqueOrThrow({
      where: { userId_hashtag: { userId, hashtag: s.hashtag } },
      include: titleInclude,
    });
  });
}

const titleInclude = {
  artists: { include: { artist: true } },
  groups: { include: { group: true } },
  characters: { include: { character: true } },
  parodies: { include: { parody: true } },
  tags: { include: { tag: true } },
} as const;

export type TitleWithRelations = Prisma.TitleGetPayload<{ include: typeof titleInclude }>;

export type SortField =
  | "added-at" | "last-read-at" | "uploaded-at" | "read-count" | "pages"
  | "hashtag" | "title" | "tag-count" | "avg-tag-value" | "random";

// "and" = title must have every selected value in the category; "or" = any.
export type MatchMode = "and" | "or";
export type MatchModes = {
  tags?: MatchMode; artists?: MatchMode; groups?: MatchMode;
  characters?: MatchMode; parodies?: MatchMode;
};

export type QueryParams = {
  search?: string;
  tags?: string[];
  /**
   * Related tags OR-ed onto the tag filter — the "suggestions" expansion. Kept
   * separate from `tags` (rather than merged client-side) so the two stay
   * distinguishable: only these widen the result set, and the UI has to be able
   * to show which values it added on the user's behalf.
   */
  tagsExpanded?: string[];
  /**
   * Let inferred ("ghost") tags satisfy the tag filter and the search box, so a
   * thinly-tagged title is findable by the tags its artist's other works carry.
   * Opt-in: roughly two in five ghosts are wrong (see lib/ghost.ts), which is a
   * fine trade when asked for and a bad default.
   */
  ghostTags?: boolean;
  artists?: string[];
  groups?: string[];
  characters?: string[];
  parodies?: string[];
  matchModes?: MatchModes;
  pageMin?: number;
  pageMax?: number;
  read?: "read" | "unread";
  /** Keep only titles with no alter name set (null or empty). */
  noAlter?: boolean;
  sortField?: SortField;
  sortDir?: "asc" | "desc";
  /** Shuffle seed for sortField "random" — keeps pagination stable within one shuffle. */
  seed?: number;
  limit?: number;
  offset?: number;
};

/**
 * @param ghostByTag the ghost index's tag→hashtags map, or undefined when the
 * caller did not ask for ghost tags. Passed in rather than fetched here because
 * buildWhere is synchronous and the index is a cached async read.
 */
function buildWhere(userId: string, p: QueryParams, ghostByTag?: Record<string, number[]>): Prisma.TitleWhereInput {
  const where: Prisma.TitleWhereInput = { userId };
  const and: Prisma.TitleWhereInput[] = [];

  // Titles that ghost-carry any of `names`. Null when ghosts are off or none
  // match, so callers can skip the OR branch entirely.
  const ghostsFor = (names: string[]): number[] | null => {
    if (!ghostByTag) return null;
    const hits = new Set<number>();
    for (const n of names) for (const h of ghostByTag[n] ?? []) hits.add(h);
    return hits.size ? [...hits] : null;
  };
  const orGhosts = (clause: Prisma.TitleWhereInput, names: string[]): Prisma.TitleWhereInput => {
    const hits = ghostsFor(names);
    return hits ? { OR: [clause, { hashtag: { in: hits } }] } : clause;
  };

  // AND = title must have every selected value (one `some` per value);
  // OR  = title matches any selected value (a single `some … in`).
  const multiClauses = (
    values: string[] | undefined,
    mode: MatchMode,
    clause: (name: string | Prisma.StringFilter) => Prisma.TitleWhereInput,
  ): Prisma.TitleWhereInput[] => {
    if (!values?.length) return [];
    if (mode === "and") return values.map((v) => clause(v));
    return [clause({ in: values })];
  };

  const pushMulti = (
    values: string[] | undefined,
    mode: MatchMode,
    clause: (name: string | Prisma.StringFilter) => Prisma.TitleWhereInput,
  ) => and.push(...multiClauses(values, mode, clause));

  const m = p.matchModes ?? {};

  const tagClause = (n: string | Prisma.StringFilter): Prisma.TitleWhereInput =>
    ({ tags: { some: { tag: { tagName: n } } } });
  // Not multiClauses: a ghost has to satisfy its own tag, so in "all" mode the
  // OR goes *inside* each per-tag clause ("really has it, or ghost-has it")
  // rather than around the group. Wrapping the group instead would let one
  // ghost stand in for the whole selection.
  const tagMode = m.tags ?? "or";
  const tagClauses: Prisma.TitleWhereInput[] = !p.tags?.length
    ? []
    : tagMode === "and"
      ? p.tags.map((t) => orGhosts(tagClause(t), [t]))
      : [orGhosts(tagClause({ in: p.tags }), p.tags)];
  // The expansion always *widens*: a title carrying a related tag is kept even
  // when it fails the selected-tag clause. So the OR wraps the base clause as a
  // whole instead of joining it — in "all" mode the base is several clauses
  // that must hold together, and OR-ing them individually would silently
  // downgrade "all" to "any".
  const expanded = p.tagsExpanded?.filter((t) => !p.tags?.includes(t)) ?? [];
  const expandedClause = expanded.length ? orGhosts(tagClause({ in: expanded }), expanded) : null;
  if (tagClauses.length && expandedClause) {
    and.push({ OR: [{ AND: tagClauses }, expandedClause] });
  } else if (tagClauses.length) {
    and.push(...tagClauses);
  } else if (expandedClause) {
    and.push(expandedClause);
  }

  pushMulti(p.artists, m.artists ?? "or", (n) => ({ artists: { some: { artist: { artistName: n } } } }));
  pushMulti(p.groups, m.groups ?? "or", (n) => ({ groups: { some: { group: { groupName: n } } } }));
  pushMulti(p.characters, m.characters ?? "or", (n) => ({ characters: { some: { character: { characterName: n } } } }));
  pushMulti(p.parodies, m.parodies ?? "or", (n) => ({ parodies: { some: { parody: { parodieName: n } } } }));

  if (p.pageMin != null && p.pageMin > 0) and.push({ pages: { gte: p.pageMin } });
  if (p.pageMax != null) and.push({ pages: { lte: p.pageMax } });
  if (p.read === "unread") and.push({ readCount: 0 });
  if (p.read === "read") and.push({ readCount: { gt: 0 } });
  if (p.noAlter) and.push({ OR: [{ alterName: null }, { alterName: "" }] });

  if (p.search && p.search.trim()) {
    const q = p.search.trim();
    const orClauses: Prisma.TitleWhereInput[] = [
      { titleName: { contains: q, mode: "insensitive" } },
      { alterName: { contains: q, mode: "insensitive" } },
      { artists: { some: { artist: { artistName: { contains: q, mode: "insensitive" } } } } },
      { tags: { some: { tag: { tagName: { contains: q, mode: "insensitive" } } } } },
    ];
    // Only match hashtag when the digit string fits INT4 — a longer number
    // would overflow the column type and make Prisma reject the whole query.
    if (/^\d+$/.test(q) && q.length <= 9) orClauses.push({ hashtag: parseInt(q, 10) });
    // Ghosts reach the search box too — typing a tag name is the first thing
    // anyone does when a title has gone missing, and that is exactly the case
    // ghost tags exist for. Scanning tag names per query is inexpensive.
    if (ghostByTag) {
      const needle = q.toLowerCase();
      const hits = new Set<number>();
      for (const [name, hashtags] of Object.entries(ghostByTag)) {
        if (name.toLowerCase().includes(needle)) for (const h of hashtags) hits.add(h);
      }
      if (hits.size) orClauses.push({ hashtag: { in: [...hits] } });
    }
    and.push({ OR: orClauses });
  }

  if (and.length) where.AND = and;
  return where;
}

// "desc" consistently means newest / most / biggest first, matching the UI labels.
// Every sort ends with the unique `hashtag` as a tiebreaker: OFFSET pagination is
// only stable across separately-cached pages when the total order is deterministic.
function buildOrderBy(field: SortField, dir: "asc" | "desc"): Prisma.TitleOrderByWithRelationInput[] {
  switch (field) {
    case "added-at": return [{ createdAt: dir }, { hashtag: "desc" }];
    case "last-read-at": return [{ lastReadAt: { sort: dir, nulls: "last" } }, { hashtag: "desc" }];
    case "uploaded-at": return [{ uploadedAt: dir }, { hashtag: "desc" }];
    case "read-count": return [{ readCount: dir }, { hashtag: "desc" }];
    case "pages": return [{ pages: dir }, { hashtag: "desc" }];
    case "hashtag": return [{ hashtag: dir }];
    case "title": return [{ titleName: dir }, { hashtag: "desc" }];
    case "tag-count": return [{ tags: { _count: dir } }, { hashtag: "desc" }];
    // avg_tag_value is denormalized on titles and kept current by DB triggers,
    // so this is a plain indexed sort. hashtag breaks the many ties for stable
    // pagination. Nulls (tag-less titles) sink to the bottom.
    case "avg-tag-value": return [{ avgTagValue: { sort: dir, nulls: "last" } }, { hashtag: "desc" }];
    default: return [{ createdAt: "desc" }, { hashtag: "desc" }];
  }
}

export type QueryResult = {
  items: TitleWithRelations[];
  total: number;
};

// mulberry32-style integer mix — stable shuffle key for (hashtag, seed).
function hashMix(h: number, seed: number): number {
  let t = (h ^ seed) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export async function queryTitles(userId: string, p: QueryParams): Promise<QueryResult> {
  "use cache";
  assertUserId(userId);
  cacheTag(titlesListTag(userId));
  cacheLife("max");

  const limit = Math.min(Math.max(Math.floor(p.limit ?? 60), 1), 200);
  const offset = Math.max(Math.floor(p.offset ?? 0), 0);
  // Only pay for the index when the query actually asks for ghosts; it is a
  // cached read, so the cost is a cache lookup on every query after the first.
  const ghostByTag = p.ghostTags ? (await getGhostIndex(userId)).byTag : undefined;
  const where = buildWhere(userId, p, ghostByTag);
  const sortField = p.sortField ?? "added-at";
  const sortDir = p.sortDir ?? "desc";

  if (sortField === "random") {
    // Deterministic per-seed shuffle of the *filtered* set: "load more" pages stay
    // consistent, a new seed (per client query) reshuffles, and filters apply.
    // Plain ORDER BY random() would be frozen by "use cache".
    const seed = p.seed ?? 0;
    const matching = await prisma.title.findMany({ where, select: { hashtag: true } });
    const shuffled = matching
      .map(({ hashtag }) => ({ hashtag, key: hashMix(hashtag, seed) }))
      .sort((a, b) => a.key - b.key || a.hashtag - b.hashtag)
      .slice(offset, offset + limit)
      .map((r) => r.hashtag);
    if (shuffled.length === 0) return { items: [], total: matching.length };
    const items = await prisma.title.findMany({
      where: { userId, hashtag: { in: shuffled } },
      include: titleInclude,
    });
    const order = new Map(shuffled.map((h, i) => [h, i]));
    items.sort((a, b) => (order.get(a.hashtag) ?? 0) - (order.get(b.hashtag) ?? 0));
    return { items, total: matching.length };
  }

  const [items, total] = await Promise.all([
    prisma.title.findMany({
      where,
      orderBy: buildOrderBy(sortField, sortDir),
      include: titleInclude,
      take: limit,
      skip: offset,
    }),
    prisma.title.count({ where }),
  ]);
  return { items, total };
}

/**
 * Hashtags of every title without a custom name — the swipe deck (app/swipe),
 * which the client shuffles. Uncached: the deck is drawn fresh on every open,
 * and a name saved a moment ago must already keep its title out.
 */
export async function getUnnamedHashtags(userId: string): Promise<number[]> {
  assertUserId(userId);
  const rows = await prisma.title.findMany({
    where: { userId, OR: [{ alterName: null }, { alterName: "" }] },
    select: { hashtag: true },
  });
  return rows.map((r) => r.hashtag);
}

// Deliberately uncached: the add flow uses this to decide whether to skip a
// re-scrape, so it must always reflect the current DB state.
export async function getTitlesByHashtags(userId: string, hashtags: number[]) {
  assertUserId(userId);
  if (hashtags.length === 0) return [];
  return prisma.title.findMany({
    where: { userId, hashtag: { in: hashtags } },
    include: titleInclude,
  });
}

export async function getTitle(userId: string, hashtag: number) {
  "use cache";
  assertUserId(userId);
  cacheTag(titleTag(userId, hashtag));
  cacheLife("max");
  return prisma.title.findUnique({
    where: { userId_hashtag: { userId, hashtag } },
    include: titleInclude,
  });
}

export async function deleteTitle(userId: string, hashtag: number) {
  assertUserId(userId);
  // Cascade removes every join row; DB triggers recompute tag stats and delete
  // any now-orphaned entities (migration 4_orphan_cleanup_triggers, deferred so
  // the re-scrape delete+recreate path doesn't FK-violate).
  await prisma.title.deleteMany({ where: { userId, hashtag } });
}

/**
 * Delete several titles in ONE statement — the swipe deck's deletion list.
 * One statement, never a loop of deleteTitle: the migration-3 count triggers
 * are statement-level and concurrent writers overwrite each other's counts (the
 * serialized-write contract), and one DELETE also runs the cascade and the
 * deferred orphan sweep once for the whole batch. Returns what was actually
 * deleted, so the caller invalidates exactly that.
 */
export async function deleteTitles(userId: string, hashtags: number[]): Promise<number[]> {
  assertUserId(userId);
  // Client input: drop junk rather than let one bad id fail the whole list.
  const ids = Array.isArray(hashtags) ? [...new Set(hashtags.filter(isHashtag))].slice(0, DELETE_BATCH) : [];
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<{ hashtag: number }[]>(Prisma.sql`
    DELETE FROM titles WHERE user_id = ${userId} AND hashtag IN (${Prisma.join(ids)})
    RETURNING hashtag
  `);
  return rows.map((r) => r.hashtag);
}

export async function markRead(userId: string, hashtag: number) {
  assertUserId(userId);
  return prisma.$transaction([
    prisma.title.update({
      where: { userId_hashtag: { userId, hashtag } },
      data: { readCount: { increment: 1 }, lastReadAt: new Date() },
    }),
    prisma.readLog.create({ data: { userId, hashtag } }),
  ]);
}

export type DatasetPayload = {
  allTags: string[];
  allArtists: string[];
  allGroups: string[];
  allCharacters: string[];
  allParodies: string[];
  tagCounts: Record<string, number>;
  artistCounts: Record<string, number>;
  groupCounts: Record<string, number>;
  charCounts: Record<string, number>;
  parodyCounts: Record<string, number>;
  pageMin: number;
  pageMax: number;
  total: number;
};

export async function getDataset(userId: string): Promise<DatasetPayload> {
  "use cache";
  assertUserId(userId);
  cacheTag(datasetTag(userId));
  cacheLife("max");

  const [tagRows, artistRows, groupRows, charRows, parodyRows, pageAgg, total] = await Promise.all([
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT t.tag_name AS name, COUNT(*)::bigint AS n
      FROM titlestotags tt JOIN tags t USING (user_id, id_tag)
      WHERE tt.user_id = ${userId}
      GROUP BY t.tag_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT a.artist_name AS name, COUNT(*)::bigint AS n
      FROM titlestoartists ta JOIN artists a USING (user_id, id_artist)
      WHERE ta.user_id = ${userId}
      GROUP BY a.artist_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT g.group_name AS name, COUNT(*)::bigint AS n
      FROM titlestogroups tg JOIN groups g USING (user_id, id_group)
      WHERE tg.user_id = ${userId}
      GROUP BY g.group_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT c.character_name AS name, COUNT(*)::bigint AS n
      FROM titlestocharacters tc JOIN characters c USING (user_id, id_character)
      WHERE tc.user_id = ${userId}
      GROUP BY c.character_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT p.parodie_name AS name, COUNT(*)::bigint AS n
      FROM titlestoparodies tp JOIN parodies p USING (user_id, id_parodie)
      WHERE tp.user_id = ${userId}
      GROUP BY p.parodie_name ORDER BY n DESC, name ASC
    `),
    prisma.title.aggregate({ where: { userId }, _min: { pages: true }, _max: { pages: true } }),
    prisma.title.count({ where: { userId } }),
  ]);

  const toMaps = (rows: { name: string; n: bigint }[]) => {
    const counts: Record<string, number> = {};
    const all: string[] = [];
    for (const r of rows) {
      counts[r.name] = Number(r.n);
      all.push(r.name);
    }
    // Keep the SQL order (most-used first): the mobile filter list renders this
    // order directly, so popular entries stay near the top. Desktop and Stats
    // re-sort for their own needs, so they're unaffected.
    return { all, counts };
  };

  const tags = toMaps(tagRows);
  const artists = toMaps(artistRows);
  const groups = toMaps(groupRows);
  const chars = toMaps(charRows);
  const parodies = toMaps(parodyRows);

  return {
    allTags: tags.all,
    allArtists: artists.all,
    allGroups: groups.all,
    allCharacters: chars.all,
    allParodies: parodies.all,
    tagCounts: tags.counts,
    artistCounts: artists.counts,
    groupCounts: groups.counts,
    charCounts: chars.counts,
    parodyCounts: parodies.counts,
    pageMin: pageAgg._min.pages ?? 0,
    pageMax: pageAgg._max.pages ?? 999,
    total,
  };
}

export async function updateAlterName(userId: string, hashtag: number, alterName: string) {
  assertUserId(userId);
  return prisma.title.update({
    where: { userId_hashtag: { userId, hashtag } },
    data: { alterName: alterName.trim() || null },
  });
}

export type StatsPayload = {
  total: number;
  totalPages: number;
  totalReads: number;
  readPages: number;
  unread: number;
  avgPages: number;
  medianPages: number;
  longestPages: number;
  pageBuckets: { label: string; count: number }[];
  monthlyReads: { idx: number; count: number }[];
  hourlyReads: { h: number; count: number }[];
  dowReads: { d: number; count: number }[];
  recentSessions: { hashtag: number; readAt: string; name: string }[];
  additions: { label: string; count: number }[];
  mostRead: { hashtag: number; titleName: string; alterName: string; pages: number; readCount: number; firstArtist: string; imageLink: string }[];
};

// An unknown zone makes Postgres throw, and the value arrives from the client,
// so validate before it reaches SQL. Intl is the authority on IANA names.
function normalizeTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * @param timeZone IANA zone the wall-clock buckets (hour-of-day, day-of-week,
 * month) are computed in. Pass the viewer's zone — the client renders these as
 * local time, so bucketing them in UTC mislabels every read. Defaults to UTC.
 */
export async function getStats(userId: string, timeZone?: string): Promise<StatsPayload> {
  "use cache";
  assertUserId(userId);
  cacheTag(statsTag(userId));
  // Time-bounded (not "max"): the NOW()/AGE() buckets below are relative to the
  // query time, so the entry must self-refresh or the buckets freeze forever.
  cacheLife("hours");

  const tz = normalizeTimeZone(timeZone);
  // read_at / created_at are `timestamp` (no zone) holding UTC wall-clock, so
  // reaching the viewer's local time takes two hops: label the naive value as
  // UTC, then shift it into their zone. Comparisons against NOW() go through
  // `NOW() AT TIME ZONE 'UTC'` for the same reason — mixing timestamptz with a
  // naive column silently uses the DB session's TimeZone, which is not ours to
  // rely on.
  const localRead = Prisma.sql`(read_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;
  const nowUtc = Prisma.sql`(NOW() AT TIME ZONE 'UTC')`;
  const nowLocal = Prisma.sql`(NOW() AT TIME ZONE ${tz})`;

  const [
    aggRow,
    medianRow,
    pageBucketRows,
    monthRows,
    hourRows,
    dowRows,
    recentRows,
    additionRows,
    mostReadRows,
  ] = await Promise.all([
    prisma.$queryRaw<{
      total: bigint; total_pages: bigint | null; total_reads: bigint | null;
      read_pages: bigint | null; unread: bigint; longest: number | null;
    }[]>(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS total,
        COALESCE(SUM(pages), 0)::bigint AS total_pages,
        COALESCE(SUM(read_count), 0)::bigint AS total_reads,
        COALESCE(SUM(CASE WHEN read_count > 0 THEN pages * read_count ELSE 0 END), 0)::bigint AS read_pages,
        COALESCE(SUM(CASE WHEN read_count = 0 THEN 1 ELSE 0 END), 0)::bigint AS unread,
        MAX(pages) AS longest
      FROM titles WHERE user_id = ${userId}
    `),
    prisma.$queryRaw<{ median: number | null }[]>(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pages)::int AS median FROM titles WHERE user_id = ${userId}
    `),
    prisma.$queryRaw<{ label: string; count: bigint }[]>(Prisma.sql`
      SELECT label, COUNT(*)::bigint AS count FROM (
        SELECT
          CASE
            WHEN pages < 25 THEN '<25'
            WHEN pages < 50 THEN '25-49'
            WHEN pages < 100 THEN '50-99'
            WHEN pages < 150 THEN '100-149'
            ELSE '150+'
          END AS label,
          CASE
            WHEN pages < 25 THEN 0
            WHEN pages < 50 THEN 1
            WHEN pages < 100 THEN 2
            WHEN pages < 150 THEN 3
            ELSE 4
          END AS ord
        FROM titles WHERE user_id = ${userId}
      ) s GROUP BY label, ord ORDER BY ord
    `),
    prisma.$queryRaw<{ idx: number; count: bigint }[]>(Prisma.sql`
      SELECT
        EXTRACT(YEAR FROM AGE(${nowLocal}, ${localRead}))::int * 12
          + EXTRACT(MONTH FROM AGE(${nowLocal}, ${localRead}))::int AS idx,
        COUNT(*)::bigint AS count
      FROM read_logs
      WHERE user_id = ${userId} AND read_at > ${nowUtc} - INTERVAL '12 months'
      GROUP BY idx
      ORDER BY idx
    `),
    prisma.$queryRaw<{ h: number; count: bigint }[]>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM ${localRead})::int AS h, COUNT(*)::bigint AS count
      FROM read_logs WHERE user_id = ${userId} GROUP BY h ORDER BY h
    `),
    prisma.$queryRaw<{ d: number; count: bigint }[]>(Prisma.sql`
      SELECT EXTRACT(DOW FROM ${localRead})::int AS d, COUNT(*)::bigint AS count
      FROM read_logs WHERE user_id = ${userId} GROUP BY d ORDER BY d
    `),
    // read_at is formatted in SQL rather than handed over as a Date: the driver
    // parses a naive `timestamp` in the *server process's* zone, which would
    // shift every rendered session time off a non-UTC host. The column holds
    // UTC, so stamping a literal Z yields the correct instant everywhere.
    prisma.$queryRaw<{ hashtag: number; read_at: string; title_name: string; alter_name: string | null }[]>(Prisma.sql`
      SELECT r.hashtag,
             to_char(r.read_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at,
             t.title_name, t.alter_name
      FROM read_logs r LEFT JOIN titles t USING (user_id, hashtag)
      WHERE r.user_id = ${userId}
      ORDER BY r.read_at DESC LIMIT 20
    `),
    prisma.$queryRaw<{ bucket: number; count: bigint }[]>(Prisma.sql`
      SELECT bucket, COUNT(*)::bigint AS count FROM (
        SELECT FLOOR(EXTRACT(EPOCH FROM (${nowUtc} - created_at)) / 86400 / 60)::int AS bucket
        FROM titles
        WHERE user_id = ${userId} AND created_at > ${nowUtc} - INTERVAL '360 days'
      ) s WHERE bucket BETWEEN 0 AND 5 GROUP BY bucket ORDER BY bucket
    `),
    prisma.title.findMany({
      where: { userId, readCount: { gt: 0 } },
      orderBy: { readCount: "desc" },
      take: 5,
      select: {
        hashtag: true, titleName: true, alterName: true, pages: true,
        readCount: true, imageLink: true,
        artists: { take: 1, include: { artist: { select: { artistName: true } } } },
      },
    }),
  ]);

  const agg = aggRow[0];
  const total = Number(agg?.total ?? 0);
  const totalPages = Number(agg?.total_pages ?? 0);
  const median = medianRow[0]?.median ?? 0;

  const monthMap = new Map(monthRows.map((r) => [Number(r.idx), Number(r.count)]));
  const monthlyReads = Array.from({ length: 12 }, (_, i) => ({
    idx: i,
    count: monthMap.get(11 - i) ?? 0,
  }));

  const hourMap = new Map(hourRows.map((r) => [Number(r.h), Number(r.count)]));
  const hourlyReads = Array.from({ length: 24 }, (_, h) => ({ h, count: hourMap.get(h) ?? 0 }));

  const dowMap = new Map(dowRows.map((r) => [Number(r.d), Number(r.count)]));
  const dowReads = Array.from({ length: 7 }, (_, i) => {
    const pgDow = (i + 1) % 7;
    return { d: i, count: dowMap.get(pgDow) ?? 0 };
  });

  const pageBucketMap = new Map(pageBucketRows.map((r) => [r.label, Number(r.count)]));
  const pageBuckets = ["<25", "25-49", "50-99", "100-149", "150+"].map((label) => ({
    label,
    count: pageBucketMap.get(label) ?? 0,
  }));

  const additionMap = new Map(additionRows.map((r) => [Number(r.bucket), Number(r.count)]));
  const additions = Array.from({ length: 6 }, (_, i) => {
    const bucket = 5 - i;
    return { label: `${(bucket + 1) * 60}d`, count: additionMap.get(bucket) ?? 0 };
  });

  return {
    total,
    totalPages,
    totalReads: Number(agg?.total_reads ?? 0),
    readPages: Number(agg?.read_pages ?? 0),
    unread: Number(agg?.unread ?? 0),
    avgPages: total ? Math.round(totalPages / total) : 0,
    medianPages: Number(median ?? 0),
    longestPages: agg?.longest ?? 0,
    pageBuckets,
    monthlyReads,
    hourlyReads,
    dowReads,
    recentSessions: recentRows.map((r) => ({
      hashtag: r.hashtag,
      readAt: r.read_at,
      name: r.alter_name || r.title_name || `#${r.hashtag}`,
    })),
    additions,
    mostRead: mostReadRows.map((m) => ({
      hashtag: m.hashtag,
      titleName: m.titleName,
      alterName: m.alterName ?? "",
      pages: m.pages,
      readCount: m.readCount,
      imageLink: m.imageLink,
      firstArtist: m.artists[0]?.artist.artistName ?? "",
    })),
  };
}

export type SimilarItem = {
  hashtag: number;
  titleName: string;
  alterName: string;
  imageLink: string;
  pages: number;
  shared: number;
};

export async function getSimilar(userId: string, hashtag: number, limit = 8): Promise<SimilarItem[]> {
  "use cache";
  assertUserId(userId);
  // Writes invalidate all similarity lists for this user, including neighbours
  // whose overlap changes when this title changes.
  cacheTag(similarTag(userId, hashtag));
  cacheTag(similarAnyTag(userId));
  cacheLife("max");

  const take = Math.min(Math.max(Math.floor(limit) || 1, 1), 50);

  const rows = await prisma.$queryRaw<{
    hashtag: number; title_name: string; alter_name: string | null;
    image_link: string; pages: number; shared: bigint;
  }[]>(Prisma.sql`
    SELECT t.hashtag, t.title_name, t.alter_name, t.image_link, t.pages,
           COUNT(*)::bigint AS shared
    FROM titlestotags a
    JOIN titlestotags b ON a.user_id = b.user_id AND a.id_tag = b.id_tag AND a.hashtag <> b.hashtag
    JOIN titles t ON t.user_id = b.user_id AND t.hashtag = b.hashtag
    WHERE a.user_id = ${userId} AND a.hashtag = ${hashtag}
    GROUP BY t.hashtag, t.title_name, t.alter_name, t.image_link, t.pages
    HAVING COUNT(*) >= 2
    ORDER BY shared DESC
    LIMIT ${take}
  `);

  return rows.map((r) => ({
    hashtag: r.hashtag,
    titleName: r.title_name,
    alterName: r.alter_name ?? "",
    imageLink: r.image_link,
    pages: r.pages,
    shared: Number(r.shared),
  }));
}

export type TagAffinityParams = {
  /** Seed tags — the tags currently selected in the filter. */
  tags: string[];
  /**
   * How the seed *set of titles* is defined, mirroring the tag filter's own
   * match mode: "and" = titles carrying every seed, "or" = titles carrying any.
   * Suggestions computed against the wrong seed set describe a population the
   * user is not looking at.
   */
  mode?: MatchMode;
  limit?: number;
};

/**
 * Tags characteristic of the titles matching `tags`, best first.
 *
 * Cached under the existing `dataset` tag rather than a new one: every write
 * that can move these numbers (commit, delete) already invalidates it, so there
 * is no fresh call site to forget. Reads that don't touch tags — markRead,
 * updateAlterName — correctly leave it alone.
 *
 * Pair counts are computed on demand over the seed set. Evaluation found
 * round-trip latency dominated computation; materialising the matrix would
 * add a write-path trigger for little benefit at this scale.
 */
export async function getTagAffinity(userId: string, p: TagAffinityParams): Promise<TagAffinity[]> {
  "use cache";
  assertUserId(userId);
  cacheTag(datasetTag(userId));
  cacheLife("max");

  const names = [...new Set(p.tags.map((t) => t.trim()).filter(Boolean))];
  if (names.length === 0) return [];
  const take = Math.min(Math.max(Math.floor(p.limit ?? 8) || 1, 1), 50);

  // "and" needs every seed present on the title; "or" needs the grouping only
  // to dedupe hashtags. COUNT(DISTINCT id_tag) is exact because tag_name is
  // unique, so a title cannot match one seed name through two rows.
  const seedHaving =
    (p.mode ?? "or") === "and"
      ? Prisma.sql`HAVING COUNT(DISTINCT t.id_tag) = ${names.length}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<
    (AffinityRow & { seed_count: number; collection: number })[]
  >(Prisma.sql`
    WITH sel AS (
      SELECT tt.hashtag
      FROM titlestotags tt JOIN tags t USING (user_id, id_tag)
      WHERE tt.user_id = ${userId} AND t.tag_name IN (${Prisma.join(names)})
      GROUP BY tt.hashtag
      ${seedHaving}
    ),
    counts AS (
      SELECT (SELECT COUNT(*) FROM sel)::int AS seed_count,
             (SELECT COUNT(*) FROM titles WHERE user_id = ${userId})::int AS collection
    )
    SELECT t.tag_name AS name,
           COUNT(*)::int AS co,
           t.title_count AS total,
           counts.seed_count,
           counts.collection
    FROM sel
    JOIN titlestotags b ON b.user_id = ${userId} AND b.hashtag = sel.hashtag
    JOIN tags t ON t.user_id = b.user_id AND t.id_tag = b.id_tag
    CROSS JOIN counts
    WHERE t.tag_name NOT IN (${Prisma.join(names)})
    GROUP BY t.tag_name, t.title_count, counts.seed_count, counts.collection
    HAVING COUNT(*) >= ${MIN_SHARED_TITLES}
  `);

  if (rows.length === 0) return [];
  return rankAffinity(rows, rows[0].seed_count, rows[0].collection).slice(0, take);
}

/**
 * Every title's inferred tags, plus the inverted index the query path filters
 * through. One pass produces both, because building either alone would read the
 * same three tables anyway.
 */
export type GhostIndex = {
  /** hashtag → its ghost tags, best first. String keys, for serialisation. */
  byTitle: Record<string, GhostTag[]>;
  /** tag name → hashtags that ghost-carry it. */
  byTag: Record<string, number[]>;
};

/**
 * Compute ghost tags for the whole collection.
 *
 * Whole-collection on purpose: filtering has to answer "which titles ghost-carry
 * this tag?", which no per-title computation can serve, and the per-title lists
 * fall out of the same pass for free. Cached under `dataset` like every other
 * derived read — any write that changes a tag or an entity link already
 * invalidates it.
 *
 * Deliberately **not** a materialised table. Adding one work by an artist moves
 * the ghosts of every other work by that artist, so a stored table would need a
 * recompute on the write path — and that path is already constrained by the
 * serialized-write contract the stat triggers impose.
 */
export async function getGhostIndex(userId: string): Promise<GhostIndex> {
  "use cache";
  assertUserId(userId);
  cacheTag(datasetTag(userId));
  cacheLife("max");

  const [tagRows, entityRows, totalRow] = await Promise.all([
    prisma.$queryRaw<{ hashtag: number; name: string; total: number }[]>(Prisma.sql`
      SELECT tt.hashtag, t.tag_name AS name, t.title_count AS total
      FROM titlestotags tt JOIN tags t USING (user_id, id_tag)
      WHERE tt.user_id = ${userId}
    `),
    // One UNION rather than four round trips — the shapes are identical and the
    // scorer treats all four categories the same way.
    prisma.$queryRaw<{ kind: GhostSourceKind; hashtag: number; name: string }[]>(Prisma.sql`
      SELECT 'artist' AS kind, ta.hashtag, a.artist_name AS name
        FROM titlestoartists ta JOIN artists a USING (user_id, id_artist)
        WHERE ta.user_id = ${userId}
      UNION ALL
      SELECT 'group', tg.hashtag, g.group_name
        FROM titlestogroups tg JOIN groups g USING (user_id, id_group)
        WHERE tg.user_id = ${userId}
      UNION ALL
      SELECT 'parody', tp.hashtag, p.parodie_name
        FROM titlestoparodies tp JOIN parodies p USING (user_id, id_parodie)
        WHERE tp.user_id = ${userId}
      UNION ALL
      SELECT 'character', tc.hashtag, c.character_name
        FROM titlestocharacters tc JOIN characters c USING (user_id, id_character)
        WHERE tc.user_id = ${userId}
    `),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM titles WHERE user_id = ${userId}`),
  ]);

  const collectionCount = totalRow[0]?.n ?? 0;
  if (collectionCount === 0) return { byTitle: {}, byTag: {} };

  const tagsOf = new Map<number, string[]>();
  const tagTotals = new Map<string, number>();
  for (const r of tagRows) {
    const list = tagsOf.get(r.hashtag);
    if (list) list.push(r.name);
    else tagsOf.set(r.hashtag, [r.name]);
    tagTotals.set(r.name, r.total);
  }

  // entity key → the titles carrying it. The tag tally is built once per entity
  // and the scored title subtracted from it below, rather than re-tallied for
  // every title the entity touches.
  const entityTitles = new Map<string, number[]>();
  const entityKind = new Map<string, GhostSourceKind>();
  const entityName = new Map<string, string>();
  const linksOf = new Map<number, string[]>();
  for (const r of entityRows) {
    const key = `${r.kind}\0${r.name}`;
    const titles = entityTitles.get(key);
    if (titles) titles.push(r.hashtag);
    else {
      entityTitles.set(key, [r.hashtag]);
      entityKind.set(key, r.kind);
      entityName.set(key, r.name);
    }
    const links = linksOf.get(r.hashtag);
    if (links) links.push(key);
    else linksOf.set(r.hashtag, [key]);
  }

  const entityTally = new Map<string, Map<string, number>>();
  for (const [key, hashtags] of entityTitles) {
    const tally = new Map<string, number>();
    for (const h of hashtags) for (const t of tagsOf.get(h) ?? []) tally.set(t, (tally.get(t) ?? 0) + 1);
    entityTally.set(key, tally);
  }

  const byTitle: Record<string, GhostTag[]> = {};
  const byTag: Record<string, number[]> = {};

  for (const [hashtag, keys] of linksOf) {
    const own = tagsOf.get(hashtag) ?? [];
    const ownSet = new Set(own);
    const sources: GhostSource[] = [];
    for (const key of keys) {
      const peers = (entityTitles.get(key)?.length ?? 0) - 1; // never counts itself
      if (peers <= 0) continue;
      // The shared tally includes this title, so take its own tags back out —
      // a work must never become evidence for itself.
      const shared = entityTally.get(key)!;
      const tally = new Map<string, number>();
      for (const [name, n] of shared) {
        const adjusted = ownSet.has(name) ? n - 1 : n;
        if (adjusted > 0) tally.set(name, adjusted);
      }
      sources.push({ kind: entityKind.get(key)!, name: entityName.get(key)!, peers, tally });
    }
    const ghosts = inferGhostTags(own, sources, tagTotals, collectionCount);
    if (ghosts.length === 0) continue;
    byTitle[hashtag] = ghosts;
    for (const g of ghosts) (byTag[g.name] ??= []).push(hashtag);
  }

  return { byTitle, byTag };
}

/** One title's ghost tags. Reads the shared index — no separate query path. */
export async function getGhostTagsFor(userId: string, hashtag: number): Promise<GhostTag[]> {
  assertUserId(userId);
  const index = await getGhostIndex(userId);
  return index.byTitle[String(hashtag)] ?? [];
}
