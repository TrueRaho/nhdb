import { cacheLife, cacheTag } from "next/cache";
import { Prisma } from "./generated/prisma/client";
import { prisma } from "./db";
import type { ScrapeEntity, ScrapeResult } from "./scraper";

// One generic batch-upsert for all five entity kinds. `createMany` inserts the
// scraped rows (skipDuplicates), `findIdsByName` maps entity names back to ids.
async function batchUpsertEntities(
  items: ScrapeEntity[],
  createMany: (items: ScrapeEntity[]) => Promise<unknown>,
  findIdsByName: (names: string[]) => Promise<Map<string, number>>,
): Promise<number[]> {
  if (items.length === 0) return [];
  await createMany(items);
  const map = await findIdsByName(items.map((e) => e.name));
  return items.map((e) => map.get(e.name)!).filter(Boolean);
}

const batchUpsertArtists = (items: ScrapeEntity[]) =>
  batchUpsertEntities(
    items,
    (es) => prisma.artist.createMany({
      data: es.map((e) => ({ artist_name: e.name, artist_link: e.link, total_works: e.total_works })),
      skipDuplicates: true,
    }),
    async (names) => new Map(
      (await prisma.artist.findMany({
        where: { artist_name: { in: names } },
        select: { id_artist: true, artist_name: true },
      })).map((r) => [r.artist_name, r.id_artist])
    ),
  );

const batchUpsertGroups = (items: ScrapeEntity[]) =>
  batchUpsertEntities(
    items,
    (es) => prisma.group.createMany({
      data: es.map((e) => ({ group_name: e.name, group_link: e.link, total_works: e.total_works })),
      skipDuplicates: true,
    }),
    async (names) => new Map(
      (await prisma.group.findMany({
        where: { group_name: { in: names } },
        select: { id_group: true, group_name: true },
      })).map((r) => [r.group_name, r.id_group])
    ),
  );

const batchUpsertCharacters = (items: ScrapeEntity[]) =>
  batchUpsertEntities(
    items,
    (es) => prisma.character.createMany({
      data: es.map((e) => ({ character_name: e.name, character_link: e.link, total_works: e.total_works })),
      skipDuplicates: true,
    }),
    async (names) => new Map(
      (await prisma.character.findMany({
        where: { character_name: { in: names } },
        select: { id_character: true, character_name: true },
      })).map((r) => [r.character_name, r.id_character])
    ),
  );

const batchUpsertParodies = (items: ScrapeEntity[]) =>
  batchUpsertEntities(
    items,
    (es) => prisma.parody.createMany({
      data: es.map((e) => ({ parodie_name: e.name, parodie_link: e.link, total_works: e.total_works })),
      skipDuplicates: true,
    }),
    async (names) => new Map(
      (await prisma.parody.findMany({
        where: { parodie_name: { in: names } },
        select: { id_parodie: true, parodie_name: true },
      })).map((r) => [r.parodie_name, r.id_parodie])
    ),
  );

const batchUpsertTags = (items: ScrapeEntity[]) =>
  batchUpsertEntities(
    items,
    (es) => prisma.tag.createMany({
      data: es.map((e) => ({ tag_name: e.name, tag_link: e.link, total_works: e.total_works })),
      skipDuplicates: true,
    }),
    async (names) => new Map(
      (await prisma.tag.findMany({
        where: { tag_name: { in: names } },
        select: { id_tag: true, tag_name: true },
      })).map((r) => [r.tag_name, r.id_tag])
    ),
  );

export async function upsertScrapedTitle(s: ScrapeResult) {
  const [artistIds, groupIds, characterIds, parodyIds, tagIds] = await Promise.all([
    batchUpsertArtists(s.artists),
    batchUpsertGroups(s.groups),
    batchUpsertCharacters(s.characters),
    batchUpsertParodies(s.parodies),
    batchUpsertTags(s.tags),
  ]);

  return prisma.$transaction(async (tx) => {
    const titleData = {
      titleName: s.title_name,
      alterName: s.alter_name,
      titleLink: s.title_link,
      imageLink: s.image_link,
      pages: s.pages,
      uploadedAt: new Date(s.uploaded_at),
    };

    await tx.title.upsert({
      where: { hashtag: s.hashtag },
      create: { hashtag: s.hashtag, ...titleData },
      // alterName doubles as the user's custom name — never clobber it on re-scrape
      update: { ...titleData, alterName: undefined },
    });

    await Promise.all([
      tx.titleArtist.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleGroup.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleCharacter.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleParody.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleTag.deleteMany({ where: { hashtag: s.hashtag } }),
    ]);

    await Promise.all([
      artistIds.length &&
        tx.titleArtist.createMany({
          data: artistIds.map((id_artist) => ({ hashtag: s.hashtag, id_artist })),
        }),
      groupIds.length &&
        tx.titleGroup.createMany({
          data: groupIds.map((id_group) => ({ hashtag: s.hashtag, id_group })),
        }),
      characterIds.length &&
        tx.titleCharacter.createMany({
          data: characterIds.map((id_character) => ({ hashtag: s.hashtag, id_character })),
        }),
      parodyIds.length &&
        tx.titleParody.createMany({
          data: parodyIds.map((id_parodie) => ({ hashtag: s.hashtag, id_parodie })),
        }),
      tagIds.length &&
        tx.titleTag.createMany({
          data: tagIds.map((id_tag) => ({ hashtag: s.hashtag, id_tag })),
        }),
    ]);

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
  | "hashtag" | "title" | "tag-count" | "random";

export type QueryParams = {
  search?: string;
  tags?: string[];
  artists?: string[];
  groups?: string[];
  characters?: string[];
  parodies?: string[];
  pageMin?: number;
  pageMax?: number;
  read?: "read" | "unread";
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

  if (p.tags && p.tags.length) {
    for (const t of p.tags) {
      and.push({ tags: { some: { tag: { tag_name: t } } } });
    }
  }
  if (p.artists && p.artists.length) {
    and.push({ artists: { some: { artist: { artist_name: { in: p.artists } } } } });
  }
  if (p.groups && p.groups.length) {
    and.push({ groups: { some: { group: { group_name: { in: p.groups } } } } });
  }
  if (p.characters && p.characters.length) {
    and.push({ characters: { some: { character: { character_name: { in: p.characters } } } } });
  }
  if (p.parodies && p.parodies.length) {
    and.push({ parodies: { some: { parody: { parodie_name: { in: p.parodies } } } } });
  }
  if (p.pageMin != null && p.pageMin > 0) and.push({ pages: { gte: p.pageMin } });
  if (p.pageMax != null) and.push({ pages: { lte: p.pageMax } });
  if (p.read === "unread") and.push({ readCount: 0 });
  if (p.read === "read") and.push({ readCount: { gt: 0 } });

  if (p.search && p.search.trim()) {
    const q = p.search.trim();
    const orClauses: Prisma.TitleWhereInput[] = [
      { titleName: { contains: q, mode: "insensitive" } },
      { alterName: { contains: q, mode: "insensitive" } },
      { artists: { some: { artist: { artist_name: { contains: q, mode: "insensitive" } } } } },
      { tags: { some: { tag: { tag_name: { contains: q, mode: "insensitive" } } } } },
    ];
    if (/^\d+$/.test(q)) orClauses.push({ hashtag: parseInt(q, 10) });
    and.push({ OR: orClauses });
  }

  if (and.length) where.AND = and;
  return where;
}

// "desc" consistently means newest / most / biggest first, matching the UI labels.
function buildOrderBy(field: SortField, dir: "asc" | "desc"): Prisma.TitleOrderByWithRelationInput[] {
  switch (field) {
    case "added-at": return [{ createdAt: dir }];
    case "last-read-at": return [{ lastReadAt: { sort: dir, nulls: "last" } }];
    case "uploaded-at": return [{ uploadedAt: dir }];
    case "read-count": return [{ readCount: dir }];
    case "pages": return [{ pages: dir }];
    case "hashtag": return [{ hashtag: dir }];
    case "title": return [{ titleName: dir }];
    case "tag-count": return [{ tags: { _count: dir } }];
    default: return [{ createdAt: "desc" }];
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

  const limit = Math.min(Math.max(p.limit ?? 60, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);
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
      .sort((a, b) => a.key - b.key)
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
  const title = await prisma.title.findUnique({
    where: { hashtag },
    include: titleInclude,
  });
  if (!title) return;

  const artistIds = title.artists.map(r => r.id_artist);
  const groupIds = title.groups.map(r => r.id_group);
  const characterIds = title.characters.map(r => r.id_character);
  const parodyIds = title.parodies.map(r => r.id_parodie);
  const tagIds = title.tags.map(r => r.id_tag);

  await prisma.title.delete({ where: { hashtag } });

  await Promise.all([
    artistIds.length && prisma.artist.deleteMany({
      where: { id_artist: { in: artistIds }, titles: { none: {} } },
    }),
    groupIds.length && prisma.group.deleteMany({
      where: { id_group: { in: groupIds }, titles: { none: {} } },
    }),
    characterIds.length && prisma.character.deleteMany({
      where: { id_character: { in: characterIds }, titles: { none: {} } },
    }),
    parodyIds.length && prisma.parody.deleteMany({
      where: { id_parodie: { in: parodyIds }, titles: { none: {} } },
    }),
    tagIds.length && prisma.tag.deleteMany({
      where: { id_tag: { in: tagIds }, titles: { none: {} } },
    }),
  ]);
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
    all.sort();
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
  cacheLife("max");

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
        artists: { take: 1, include: { artist: { select: { artist_name: true } } } },
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
    pageBuckets: pageBucketRows.map((r) => ({ label: r.label, count: Number(r.count) })),
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
      firstArtist: m.artists[0]?.artist.artist_name ?? "",
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
  cacheTag(`similar-${hashtag}`);
  cacheLife("max");

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
    LIMIT ${limit}
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
