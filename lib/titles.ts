import { cacheLife, cacheTag } from "next/cache";
import { Prisma } from "./generated/prisma/client";
import { prisma } from "./db";
import type { ScrapeEntity, ScrapeResult } from "./scraper";

// One generic batch-upsert for all five entity kinds: a single
// INSERT … ON CONFLICT (name) DO UPDATE … RETURNING per category, so a
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
  const rows = await prisma.$queryRaw<{ id: number; name: string }[]>(Prisma.sql`
    INSERT INTO ${Prisma.raw(`"${table}" ("${nameCol}", "${linkCol}", total_works)`)}
    VALUES ${Prisma.join(deduped.map((e) => Prisma.sql`(${e.name}, ${e.link}, ${e.total_works})`))}
    ON CONFLICT (${Prisma.raw(`"${nameCol}"`)}) DO UPDATE
      SET ${Prisma.raw(`"${linkCol}" = EXCLUDED."${linkCol}"`)}, total_works = EXCLUDED.total_works
    RETURNING ${Prisma.raw(`"${idCol}" AS id, "${nameCol}" AS name`)}
  `);
  // RETURNING with DO UPDATE emits every affected row (inserted or updated),
  // so each input name resolves — ids come back in input order, no drops.
  const map = new Map(rows.map((r) => [r.name, r.id]));
  return items.map((e) => map.get(e.name)!);
}

const batchUpsertArtists = (items: ScrapeEntity[]) =>
  batchUpsertEntities(items, "artists", "id_artist", "artist_name", "artist_link");

const batchUpsertGroups = (items: ScrapeEntity[]) =>
  batchUpsertEntities(items, "groups", "id_group", "group_name", "group_link");

const batchUpsertCharacters = (items: ScrapeEntity[]) =>
  batchUpsertEntities(items, "characters", "id_character", "character_name", "character_link");

const batchUpsertParodies = (items: ScrapeEntity[]) =>
  batchUpsertEntities(items, "parodies", "id_parodie", "parodie_name", "parodie_link");

const batchUpsertTags = (items: ScrapeEntity[]) =>
  batchUpsertEntities(items, "tags", "id_tag", "tag_name", "tag_link");

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
  if (!Number.isInteger(s.hashtag) || s.hashtag <= 0)
    throw new ScrapePayloadError(`Invalid scrape payload: hashtag must be a positive integer, got ${s.hashtag}`);
  if (typeof s.title_name !== "string")
    throw new ScrapePayloadError("Invalid scrape payload: title_name must be a string");
  if (typeof s.image_link !== "string")
    throw new ScrapePayloadError("Invalid scrape payload: image_link must be a string");
  if (typeof s.pages !== "number" || Number.isNaN(s.pages) || s.pages < 0)
    throw new ScrapePayloadError(`Invalid scrape payload: pages must be a non-negative number, got ${s.pages}`);
  for (const key of ["tags", "artists", "groups", "characters", "parodies"] as const) {
    if (!Array.isArray(s[key]))
      throw new ScrapePayloadError(`Invalid scrape payload: ${key} must be an array`);
  }
  if (isNaN(new Date(s.uploaded_at).getTime()))
    throw new ScrapePayloadError(`Invalid scrape payload: uploaded_at is not a valid date, got ${s.uploaded_at}`);
}

export async function upsertScrapedTitle(s: ScrapeResult) {
  assertValidScrapePayload(s);

  const [artistIds, groupIds, characterIds, parodyIds, tagIds] = await Promise.all([
    batchUpsertArtists(s.artists),
    batchUpsertGroups(s.groups),
    batchUpsertCharacters(s.characters),
    batchUpsertParodies(s.parodies),
    batchUpsertTags(s.tags),
  ]);

  return prisma.$transaction(async (tx) => {
    // alterName is user-managed (set manually via updateAlterName) — the
    // scrape path never writes it, neither on create nor on re-scrape.
    const titleData = {
      titleName: s.title_name,
      imageLink: s.image_link,
      pages: s.pages,
      uploadedAt: new Date(s.uploaded_at),
    };

    await tx.title.upsert({
      where: { hashtag: s.hashtag },
      create: { hashtag: s.hashtag, ...titleData },
      update: titleData,
    });

    // Sequential awaits on purpose: Prisma discourages Promise.all inside an
    // interactive transaction — every tx query serializes on one connection
    // anyway, and concurrent awaits have caused ordering issues on some
    // adapters.
    await tx.titleArtist.deleteMany({ where: { hashtag: s.hashtag } });
    await tx.titleGroup.deleteMany({ where: { hashtag: s.hashtag } });
    await tx.titleCharacter.deleteMany({ where: { hashtag: s.hashtag } });
    await tx.titleParody.deleteMany({ where: { hashtag: s.hashtag } });
    await tx.titleTag.deleteMany({ where: { hashtag: s.hashtag } });

    if (artistIds.length)
      await tx.titleArtist.createMany({
        data: artistIds.map((idArtist) => ({ hashtag: s.hashtag, idArtist })),
        skipDuplicates: true,
      });
    if (groupIds.length)
      await tx.titleGroup.createMany({
        data: groupIds.map((idGroup) => ({ hashtag: s.hashtag, idGroup })),
        skipDuplicates: true,
      });
    if (characterIds.length)
      await tx.titleCharacter.createMany({
        data: characterIds.map((idCharacter) => ({ hashtag: s.hashtag, idCharacter })),
        skipDuplicates: true,
      });
    if (parodyIds.length)
      await tx.titleParody.createMany({
        data: parodyIds.map((idParodie) => ({ hashtag: s.hashtag, idParodie })),
        skipDuplicates: true,
      });
    if (tagIds.length)
      await tx.titleTag.createMany({
        data: tagIds.map((idTag) => ({ hashtag: s.hashtag, idTag })),
        skipDuplicates: true,
      });

    return tx.title.findUniqueOrThrow({
      where: { hashtag: s.hashtag },
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

function buildWhere(p: QueryParams): Prisma.TitleWhereInput {
  const where: Prisma.TitleWhereInput = {};
  const and: Prisma.TitleWhereInput[] = [];

  // AND = title must have every selected value (one `some` per value);
  // OR  = title matches any selected value (a single `some … in`).
  const pushMulti = (
    values: string[] | undefined,
    mode: MatchMode,
    clause: (name: string | Prisma.StringFilter) => Prisma.TitleWhereInput,
  ) => {
    if (!values?.length) return;
    if (mode === "and") for (const v of values) and.push(clause(v));
    else and.push(clause({ in: values }));
  };

  const m = p.matchModes ?? {};
  pushMulti(p.tags, m.tags ?? "or", (n) => ({ tags: { some: { tag: { tagName: n } } } }));
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

export async function queryTitles(p: QueryParams): Promise<QueryResult> {
  "use cache";
  cacheTag("titles-list");
  cacheLife("max");

  const limit = Math.min(Math.max(Math.floor(p.limit ?? 60), 1), 200);
  const offset = Math.max(Math.floor(p.offset ?? 0), 0);
  const where = buildWhere(p);
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
      where: { hashtag: { in: shuffled } },
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

// Deliberately uncached: the add flow uses this to decide whether to skip a
// re-scrape, so it must always reflect the current DB state.
export async function getTitlesByHashtags(hashtags: number[]) {
  if (hashtags.length === 0) return [];
  return prisma.title.findMany({
    where: { hashtag: { in: hashtags } },
    include: titleInclude,
  });
}

export async function getTitle(hashtag: number) {
  "use cache";
  cacheTag(`title-${hashtag}`);
  cacheLife("max");
  return prisma.title.findUnique({
    where: { hashtag },
    include: titleInclude,
  });
}

export async function deleteTitle(hashtag: number) {
  // Cascade removes every join row; DB triggers recompute tag stats and delete
  // any now-orphaned entities (migration 4_orphan_cleanup_triggers, deferred so
  // the re-scrape delete+recreate path doesn't FK-violate).
  await prisma.title.deleteMany({ where: { hashtag } });
}

export async function markRead(hashtag: number) {
  return prisma.$transaction([
    prisma.title.update({
      where: { hashtag },
      data: { readCount: { increment: 1 }, lastReadAt: new Date() },
    }),
    prisma.readLog.create({ data: { hashtag } }),
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

export async function getDataset(): Promise<DatasetPayload> {
  "use cache";
  cacheTag("dataset");
  cacheLife("max");

  const [tagRows, artistRows, groupRows, charRows, parodyRows, pageAgg, total] = await Promise.all([
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT t.tag_name AS name, COUNT(*)::bigint AS n
      FROM titlestotags tt JOIN tags t USING (id_tag)
      GROUP BY t.tag_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT a.artist_name AS name, COUNT(*)::bigint AS n
      FROM titlestoartists ta JOIN artists a USING (id_artist)
      GROUP BY a.artist_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT g.group_name AS name, COUNT(*)::bigint AS n
      FROM titlestogroups tg JOIN groups g USING (id_group)
      GROUP BY g.group_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT c.character_name AS name, COUNT(*)::bigint AS n
      FROM titlestocharacters tc JOIN characters c USING (id_character)
      GROUP BY c.character_name ORDER BY n DESC, name ASC
    `),
    prisma.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT p.parodie_name AS name, COUNT(*)::bigint AS n
      FROM titlestoparodies tp JOIN parodies p USING (id_parodie)
      GROUP BY p.parodie_name ORDER BY n DESC, name ASC
    `),
    prisma.title.aggregate({ _min: { pages: true }, _max: { pages: true } }),
    prisma.title.count(),
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

export async function updateAlterName(hashtag: number, alterName: string) {
  return prisma.title.update({
    where: { hashtag },
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

export async function getStats(): Promise<StatsPayload> {
  "use cache";
  cacheTag("stats");
  // Time-bounded (not "max"): the NOW()/AGE() buckets below are relative to the
  // query time, so the entry must self-refresh or the buckets freeze forever.
  cacheLife("hours");

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
      FROM titles
    `),
    prisma.$queryRaw<{ median: number | null }[]>(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pages)::int AS median FROM titles
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
        FROM titles
      ) s GROUP BY label, ord ORDER BY ord
    `),
    prisma.$queryRaw<{ idx: number; count: bigint }[]>(Prisma.sql`
      SELECT
        EXTRACT(YEAR FROM AGE(NOW(), read_at))::int * 12
          + EXTRACT(MONTH FROM AGE(NOW(), read_at))::int AS idx,
        COUNT(*)::bigint AS count
      FROM read_logs
      WHERE read_at > NOW() - INTERVAL '12 months'
      GROUP BY idx
      ORDER BY idx
    `),
    prisma.$queryRaw<{ h: number; count: bigint }[]>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM read_at)::int AS h, COUNT(*)::bigint AS count
      FROM read_logs GROUP BY h ORDER BY h
    `),
    prisma.$queryRaw<{ d: number; count: bigint }[]>(Prisma.sql`
      SELECT EXTRACT(DOW FROM read_at)::int AS d, COUNT(*)::bigint AS count
      FROM read_logs GROUP BY d ORDER BY d
    `),
    prisma.$queryRaw<{ hashtag: number; read_at: Date; title_name: string; alter_name: string | null }[]>(Prisma.sql`
      SELECT r.hashtag, r.read_at, t.title_name, t.alter_name
      FROM read_logs r LEFT JOIN titles t USING (hashtag)
      ORDER BY r.read_at DESC LIMIT 20
    `),
    prisma.$queryRaw<{ bucket: number; count: bigint }[]>(Prisma.sql`
      SELECT bucket, COUNT(*)::bigint AS count FROM (
        SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 / 60)::int AS bucket
        FROM titles
        WHERE created_at > NOW() - INTERVAL '360 days'
      ) s WHERE bucket BETWEEN 0 AND 5 GROUP BY bucket ORDER BY bucket
    `),
    prisma.title.findMany({
      where: { readCount: { gt: 0 } },
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
      readAt: r.read_at.toISOString(),
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

export async function getSimilar(hashtag: number, limit = 8): Promise<SimilarItem[]> {
  "use cache";
  // Broad "similar" tag alongside the per-title one: write paths invalidate the
  // literal "similar" tag to bust every cached similarity list at once.
  cacheTag(`similar-${hashtag}`);
  cacheTag("similar");
  cacheLife("max");

  const take = Math.min(Math.max(Math.floor(limit) || 1, 1), 50);

  const rows = await prisma.$queryRaw<{
    hashtag: number; title_name: string; alter_name: string | null;
    image_link: string; pages: number; shared: bigint;
  }[]>(Prisma.sql`
    SELECT t.hashtag, t.title_name, t.alter_name, t.image_link, t.pages,
           COUNT(*)::bigint AS shared
    FROM titlestotags a
    JOIN titlestotags b ON a.id_tag = b.id_tag AND a.hashtag <> b.hashtag
    JOIN titles t ON t.hashtag = b.hashtag
    WHERE a.hashtag = ${hashtag}
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
