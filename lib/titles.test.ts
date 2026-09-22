import { beforeEach, describe, expect, it, vi } from "vitest";

// queryTitles reaches the database and, being a "use cache" function, the
// request-scoped cache API. Both are stubbed so the test can inspect the
// `where` tree that buildWhere produces — the expansion's OR nesting is the
// part of this file that is easy to get subtly, silently wrong.
// vi.hoisted, because vi.mock's factory is lifted above every other statement
// in the file and would otherwise close over uninitialised bindings.
type RawQuery = { strings: readonly string[]; values: unknown[] };
const { findMany, count, queryRaw, db, transaction } = vi.hoisted(() => {
  const findMany = vi.fn<(args: { where?: unknown }) => Promise<unknown[]>>(async () => []);
  const count = vi.fn<(args: { where?: unknown }) => Promise<number>>(async () => 0);
  const queryRaw = vi.fn<(q: RawQuery) => Promise<unknown[]>>(async () => []);
  const reply = <T,>(value: T) => vi.fn<(args: unknown) => Promise<T>>(async () => value);
  const join = () => ({
    deleteMany: reply({ count: 0 }),
    createMany: reply({ count: 0 }),
  });
  const db = {
    title: {
      findMany, count,
      findUnique: reply<unknown>(null),
      findUniqueOrThrow: reply({ hashtag: 42 }),
      update: reply({ hashtag: 42 }),
      upsert: reply({ hashtag: 42 }),
      deleteMany: reply({ count: 0 }),
      aggregate: reply({ _min: { pages: 0 }, _max: { pages: 100 } }),
    },
    titleArtist: join(), titleGroup: join(), titleCharacter: join(),
    titleParody: join(), titleTag: join(),
    readLog: { create: reply({ id: 1 }) },
    $queryRaw: queryRaw,
  };
  const transaction = vi.fn(async (input: unknown) => {
    if (typeof input === "function") return input(db);
    return Promise.all(input as Promise<unknown>[]);
  });
  return { findMany, count, queryRaw, db, transaction };
});
vi.mock("./db", () => ({ prisma: { ...db, $transaction: transaction } }));
vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn() }));

import { cacheTag } from "next/cache";
import {
  deleteTitle, getDataset, getGhostIndex, getGhostTagsFor, getSimilar,
  getStats, getTagAffinity, getTitle, getTitlesByHashtags, markRead,
  queryTitles, updateAlterName, upsertScrapedTitle, type QueryParams,
} from "./titles";
import type { ScrapeResult } from "./scraper";

const USER = "alice";

/** Inspect the filter after independently checking its mandatory owner scope. */
async function whereFor(params: QueryParams) {
  await queryTitles(USER, params);
  const { userId, ...filters } = findMany.mock.calls.at(-1)![0].where as Record<string, unknown>;
  expect(userId).toBe(USER);
  expect(count).toHaveBeenLastCalledWith({ where: { userId, ...filters } });
  return filters;
}

const tag = (name: unknown) => ({ tags: { some: { tag: { tagName: name } } } });

// A four-title collection, all by one artist. #1 carries only `x`; #2–#4 carry
// `x`, `y` and `z`. So `y` and `z` are on 3 of #1's 3 peers and nothing else in
// the collection — exactly the thinly-tagged title ghost tags exist for.
const TAG_ROWS = [
  { hashtag: 1, name: "x", total: 4 },
  { hashtag: 2, name: "x", total: 4 }, { hashtag: 2, name: "y", total: 3 }, { hashtag: 2, name: "z", total: 3 },
  { hashtag: 3, name: "x", total: 4 }, { hashtag: 3, name: "y", total: 3 }, { hashtag: 3, name: "z", total: 3 },
  { hashtag: 4, name: "x", total: 4 }, { hashtag: 4, name: "y", total: 3 }, { hashtag: 4, name: "z", total: 3 },
];
const ENTITY_ROWS = [1, 2, 3, 4].map((hashtag) => ({ kind: "artist", hashtag, name: "solo artist" }));

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockImplementation(async () => []);
  // Routed on the SQL text rather than call order: getGhostIndex fires its
  // three reads through Promise.all, so the order is not ours to rely on.
  queryRaw.mockImplementation(async (q) => {
    const text = (q.strings ?? []).join(" ");
    if (text.includes("titlestoartists")) return ENTITY_ROWS;
    if (text.includes("FROM titlestotags")) return TAG_ROWS;
    if (text.includes("FROM titles")) return [{ n: 100 }];
    return [];
  });
});

describe("queryTitles — tag filter", () => {
  it("defaults to OR: one `in` clause for every selected tag", async () => {
    expect(await whereFor({ tags: ["netorare", "cheating"] }))
      .toEqual({ AND: [tag({ in: ["netorare", "cheating"] })] });
  });

  it("AND mode emits one clause per tag", async () => {
    expect(await whereFor({
      tags: ["netorare", "cheating"],
      matchModes: { tags: "and" },
    })).toEqual({ AND: [tag("netorare"), tag("cheating")] });
  });
});

describe("queryTitles — related-tag expansion", () => {
  it("widens an OR selection with a single extra branch", async () => {
    expect(await whereFor({ tags: ["netorare"], tagsExpanded: ["milf", "hidden sex"] }))
      .toEqual({
        AND: [{
          OR: [
            { AND: [tag({ in: ["netorare"] })] },
            tag({ in: ["milf", "hidden sex"] }),
          ],
        }],
      });
  });

  it("keeps AND mode intact under the expansion", async () => {
    // The whole point of nesting the base clauses under their own AND: OR-ing
    // them individually alongside the expansion would quietly turn "has all
    // selected" into "has any selected".
    const where = await whereFor({
      tags: ["netorare", "cheating"],
      matchModes: { tags: "and" },
      tagsExpanded: ["milf"],
    });
    expect(where).toEqual({
      AND: [{
        OR: [
          { AND: [tag("netorare"), tag("cheating")] },
          tag({ in: ["milf"] }),
        ],
      }],
    });
  });

  it("never lets a suggestion duplicate an explicitly selected tag", async () => {
    // The expansion is computed from the selection, so a seed can come back in
    // its own suggestion list after the user selects it mid-flight.
    expect(await whereFor({ tags: ["netorare"], tagsExpanded: ["netorare", "milf"] }))
      .toEqual({
        AND: [{
          OR: [{ AND: [tag({ in: ["netorare"] })] }, tag({ in: ["milf"] })],
        }],
      });
  });

  it("collapses to the plain tag clause when the expansion is empty", async () => {
    expect(await whereFor({ tags: ["netorare"], tagsExpanded: [] }))
      .toEqual({ AND: [tag({ in: ["netorare"] })] });
  });

  it("still filters when an expansion arrives without a selection", async () => {
    expect(await whereFor({ tags: [], tagsExpanded: ["milf"] }))
      .toEqual({ AND: [tag({ in: ["milf"] })] });
  });

  it("leaves the other categories alone", async () => {
    const where = await whereFor({
      tags: ["netorare"],
      tagsExpanded: ["milf"],
      artists: ["a", "b"],
      matchModes: { artists: "and" },
    });
    expect(where).toEqual({
      AND: [
        { OR: [{ AND: [tag({ in: ["netorare"] })] }, tag({ in: ["milf"] })] },
        { artists: { some: { artist: { artistName: "a" } } } },
        { artists: { some: { artist: { artistName: "b" } } } },
      ],
    });
  });
});

describe("queryTitles — ghost tags", () => {
  const ghostOf = (hashtags: number[]) => ({ hashtag: { in: hashtags } });

  it("is off unless asked for", async () => {
    expect(await whereFor({ tags: ["y"] })).toEqual({ AND: [tag({ in: ["y"] })] });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("lets a title match a tag it only ghost-carries", async () => {
    expect(await whereFor({ tags: ["y"], ghostTags: true })).toEqual({
      AND: [{ OR: [tag({ in: ["y"] }), ghostOf([1])] }],
    });
  });

  it("requires every tag separately in AND mode", async () => {
    // The nesting that matters: one OR per selected tag, so a title still has
    // to satisfy BOTH — really or by inference. A single OR around the group
    // would let one ghost stand in for the entire selection.
    expect(await whereFor({
      tags: ["y", "z"],
      matchModes: { tags: "and" },
      ghostTags: true,
    })).toEqual({
      AND: [
        { OR: [tag("y"), ghostOf([1])] },
        { OR: [tag("z"), ghostOf([1])] },
      ],
    });
  });

  it("adds no branch for a tag nothing ghost-carries", async () => {
    // `x` is on every title outright, so no title infers it.
    expect(await whereFor({ tags: ["x"], ghostTags: true }))
      .toEqual({ AND: [tag({ in: ["x"] })] });
  });

  it("covers the related-tag expansion too", async () => {
    expect(await whereFor({ tags: ["x"], tagsExpanded: ["y"], ghostTags: true })).toEqual({
      AND: [{
        OR: [
          { AND: [tag({ in: ["x"] })] },
          { OR: [tag({ in: ["y"] }), ghostOf([1])] },
        ],
      }],
    });
  });

  it("reaches the search box, so a thinly-tagged title still turns up", async () => {
    const where = await whereFor({ search: "y", ghostTags: true }) as { AND: [{ OR: unknown[] }] };
    expect(where.AND[0].OR).toContainEqual(ghostOf([1]));
  });

  it("leaves search alone when no tag name matches the query", async () => {
    const where = await whereFor({ search: "nothing-like-this", ghostTags: true }) as { AND: [{ OR: unknown[] }] };
    expect(where.AND[0].OR.some(c => JSON.stringify(c).includes("hashtag"))).toBe(false);
  });
});

const scrape: ScrapeResult = {
  hashtag: 42,
  title_name: "Shared source title",
  image_link: "https://example.test/cover.jpg",
  pages: 20,
  uploaded_at: "2026-01-01",
  artists: [{ name: "artist", link: "/artist/artist/", total_works: 10 }],
  groups: [{ name: "group", link: "/group/group/", total_works: 10 }],
  characters: [{ name: "character", link: "/character/character/", total_works: 10 }],
  parodies: [{ name: "parody", link: "/parody/parody/", total_works: 10 }],
  tags: [{ name: "tag", link: "/tag/tag/", total_works: 10 }],
};

describe("scrape payload validation", () => {
  it.each([
    null,
    { ...scrape, pages: 1.5 },
    { ...scrape, pages: Infinity },
    { ...scrape, hashtag: 2_147_483_648 },
    { ...scrape, uploaded_at: null },
    { ...scrape, title_name: "x".repeat(256) },
    { ...scrape, tags: [null] },
    { ...scrape, artists: [{ ...scrape.artists[0], total_works: -1 }] },
    { ...scrape, groups: [{ ...scrape.groups[0], link: false }] },
  ])("rejects malformed payload %# before starting a transaction", async (payload) => {
    await expect(upsertScrapedTitle(USER, payload as ScrapeResult)).rejects.toMatchObject({ name: "ValidationError" });
    expect(transaction).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("collection ownership", () => {
  it("keeps both stages of random pagination in the requested collection", async () => {
    // The same source hashtag is allowed in two collections. Filtering only
    // the first query would leak the other user's row during hydration.
    const rows = [{ userId: USER, hashtag: 42 }, { userId: "bob", hashtag: 42 }];
    findMany.mockImplementation(async ({ where }) => {
      const owner = (where as { userId?: string }).userId;
      return rows.filter((r) => !owner || r.userId === owner);
    });

    const result = await queryTitles(USER, { sortField: "random" });
    expect(result.total).toBe(1);
    expect(result.items).toEqual([rows[0]]);
    expect(findMany.mock.calls).toHaveLength(2);
    for (const [args] of findMany.mock.calls) expect(args.where).toMatchObject({ userId: USER });
  });

  it("scopes existing-title checks and detail reads, including identical hashtags", async () => {
    await getTitlesByHashtags(USER, [42]);
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId: USER, hashtag: { in: [42] } } }));
    await getTitle(USER, 42);
    await getTitle("bob", 42);
    expect(db.title.findUnique.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ where: { userId_hashtag: { userId: USER, hashtag: 42 } } }),
      expect.objectContaining({ where: { userId_hashtag: { userId: "bob", hashtag: 42 } } }),
    ]);
    expect(cacheTag).toHaveBeenCalledWith("title:alice:42");
    expect(cacheTag).toHaveBeenCalledWith("title:bob:42");
  });

  it("scopes delete, rename, and both parts of a read transaction", async () => {
    await deleteTitle(USER, 42);
    await updateAlterName(USER, 42, "  My title  ");
    await markRead(USER, 42);
    expect(db.title.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, hashtag: 42 } });
    expect(db.title.update).toHaveBeenCalledWith({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } },
      data: { alterName: "My title" },
    });
    expect(db.title.update).toHaveBeenLastCalledWith({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } },
      data: { readCount: { increment: 1 }, lastReadAt: expect.any(Date) },
    });
    expect(db.readLog.create).toHaveBeenCalledWith({ data: { userId: USER, hashtag: 42 } });
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("upserts entities, the title, and replacement links under the same owner", async () => {
    queryRaw.mockImplementation(async (q) => [{ id: 7, name: q.values[1] }]);
    await upsertScrapedTitle(USER, scrape);
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(5);
    for (const [q] of queryRaw.mock.calls) {
      expect(q.strings.join("?")).toContain("(user_id,");
      expect(q.strings.join("?")).toContain("ON CONFLICT (user_id,");
      expect(q.values[0]).toBe(USER);
    }
    expect(db.title.upsert).toHaveBeenCalledWith({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } },
      create: expect.objectContaining({ userId: USER, hashtag: 42 }),
      update: expect.not.objectContaining({ userId: expect.anything(), alterName: expect.anything() }),
    });
    for (const model of [db.titleArtist, db.titleGroup, db.titleCharacter, db.titleParody, db.titleTag]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, hashtag: 42 } });
      expect(model.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: USER, hashtag: 42 })],
        skipDuplicates: true,
      });
    }
    expect(db.title.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } },
    }));
  });

  it("scopes dataset aggregates and every entity category", async () => {
    queryRaw.mockResolvedValue([]);
    await getDataset(USER);
    expect(queryRaw).toHaveBeenCalledTimes(5);
    for (const [q] of queryRaw.mock.calls) {
      expect(q.values).toEqual([USER]);
      expect(q.strings.join("?")).toMatch(/WHERE \w+\.user_id = \?/);
      expect(q.strings.join("?")).toContain("USING (user_id,");
    }
    expect(db.title.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER } }));
    expect(count).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(cacheTag).toHaveBeenCalledWith("dataset:alice");
  });

  it("scopes every statistics query and joins read sessions on owner and hashtag", async () => {
    queryRaw.mockResolvedValue([]);
    await getStats(USER, "Europe/Berlin");
    expect(queryRaw).toHaveBeenCalledTimes(8);
    for (const [q] of queryRaw.mock.calls) {
      expect(q.values).toContain(USER);
      expect(q.strings.join("?")).toMatch(/WHERE (?:r\.)?user_id = \?/);
    }
    const recent = queryRaw.mock.calls.find(([q]) => q.strings.join("").includes("LEFT JOIN"))![0];
    expect(recent.strings.join("?")).toContain("USING (user_id, hashtag)");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER, readCount: { gt: 0 } } }));
    expect(cacheTag).toHaveBeenCalledWith("stats:alice");
  });

  it("cannot join similar titles across users sharing a hashtag", async () => {
    queryRaw.mockResolvedValue([]);
    await getSimilar(USER, 42);
    const q = queryRaw.mock.calls[0][0];
    expect(q.values).toEqual([USER, 42, 8]);
    expect(q.strings.join("?")).toContain("a.user_id = b.user_id");
    expect(q.strings.join("?")).toContain("t.user_id = b.user_id");
    expect(q.strings.join("?")).toContain("WHERE a.user_id = ?");
    expect(cacheTag).toHaveBeenCalledWith("similar:alice:42");
    expect(cacheTag).toHaveBeenCalledWith("similar:alice");
  });

  it("scopes affinity seeds, collection size, and candidate links independently", async () => {
    queryRaw.mockResolvedValue([]);
    await getTagAffinity(USER, { tags: ["seed"] });
    const q = queryRaw.mock.calls[0][0];
    expect(q.values.filter((v) => v === USER)).toHaveLength(3);
    expect(q.strings.join("?")).toContain("WHERE tt.user_id = ?");
    expect(q.strings.join("?")).toContain("FROM titles WHERE user_id = ?");
    expect(q.strings.join("?")).toContain("ON b.user_id = ? AND b.hashtag = sel.hashtag");
    expect(q.strings.join("?")).toContain("t.user_id = b.user_id");
    expect(cacheTag).toHaveBeenCalledWith("dataset:alice");
  });

  it("uses only the requested owner's peers when deriving ghost tags", async () => {
    queryRaw.mockImplementation(async (q) => {
      // Alice has enough peers to infer ghosts; Bob's collection is empty.
      if (!q.values.every((v) => v === USER)) return [];
      const sql = q.strings.join("?");
      if (sql.includes("titlestoartists")) return ENTITY_ROWS;
      if (sql.includes("FROM titlestotags")) return TAG_ROWS;
      return [{ n: 100 }];
    });
    expect((await getGhostTagsFor(USER, 1)).map((g) => g.name)).toEqual(expect.arrayContaining(["y", "z"]));
    expect(await getGhostTagsFor("bob", 1)).toEqual([]);
    const union = queryRaw.mock.calls.find(([q]) => q.strings.join("").includes("UNION ALL"))![0];
    expect(union.values).toEqual([USER, USER, USER, USER]);
    expect(union.strings.join("?").match(/WHERE \w+\.user_id = \?/g)).toHaveLength(4);
    expect(cacheTag).toHaveBeenCalledWith("dataset:alice");
    expect(cacheTag).toHaveBeenCalledWith("dataset:bob");
  });

  it.each([undefined, null, "", "   "])("rejects missing identity %s before reaching the database", async (badId) => {
    const userId = badId as string;
    const readsAndWrites = [
      () => queryTitles(userId, {}), () => getTitlesByHashtags(userId, [42]),
      () => getTitle(userId, 42), () => getDataset(userId), () => getStats(userId),
      () => getSimilar(userId, 42), () => getTagAffinity(userId, { tags: ["x"] }),
      () => getGhostIndex(userId), () => getGhostTagsFor(userId, 42),
      () => deleteTitle(userId, 42), () => updateAlterName(userId, 42, "x"),
      () => markRead(userId, 42), () => upsertScrapedTitle(userId, scrape),
    ];
    for (const call of readsAndWrites) await expect(call()).rejects.toThrow("A user ID is required");
    for (const model of Object.values(db)) {
      if (typeof model === "function") expect(model).not.toHaveBeenCalled();
      else for (const method of Object.values(model)) expect(method).not.toHaveBeenCalled();
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});
