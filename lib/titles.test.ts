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
    $executeRaw: vi.fn(async () => 1),
    title: {
      findMany, count,
      findUnique: reply<unknown>(null),
      findUniqueOrThrow: reply({ hashtag: 42, readCount: 1 }),
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
  deleteTitle, deleteTitles, getDataset, getGhostIndex, getGhostTagsFor, getSimilar,
  getStats, getTagAffinity, getTitle, getTitlesByHashtags, getTitlesByRefs, getUnnamedHashtags, markRead,
  queryTitles, updateAlterName, upsertScrapedTitle, type QueryParams,
} from "./titles";
import type { ScrapeResult } from "./scrape-payload";
import { COMMIT_LIMIT, READ_DEDUPE_MINUTES, READ_LIMIT, UsageLimitError } from "./usage-limits";

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
    if (text.includes("UPDATE titles SET read_count")) return [{ read_count: 1 }];
    if (text.includes("INSERT INTO usage_budget")) return [{ used: BigInt(1) }];
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

describe("search across sites", () => {
  const orOf = async (search: string) =>
    ((await whereFor({ search })) as { AND: [{ OR: unknown[] }] }).AND[0].OR;

  it("matches a number as an nhentai key and as any site's id", async () => {
    const or = await orOf("1234567");
    expect(or).toContainEqual({ hashtag: 1234567 });
    expect(or).toContainEqual({ sourceId: "1234567" });
    expect(or).toContainEqual({ sourceId: { startsWith: "1234567/" } }); // an E-Hentai gid
  });

  it("never sends a number too large for the key column", async () => {
    const or = await orOf("12345678901");
    expect(or.some((c) => "hashtag" in (c as object))).toBe(false);
    expect(or).toContainEqual({ sourceId: "12345678901" });
  });

  it("finds a title by a pasted gallery link", async () => {
    expect(await orOf("https://hitomi.la/reader/1234567.html#3")).toContainEqual({ source: "hitomi", sourceId: "1234567" });
  });

  it("finds a title from any site by its link, filed under the site's host", async () => {
    expect(await orOf("https://3hentai.net/d/612345/3")).toContainEqual({ source: "3hentai.net", sourceId: "612345" });
    expect(await orOf("https://www.myreadingmanga.info/some-title-english/"))
      .toContainEqual({ source: "myreadingmanga.info", sourceId: "some-title-english" });
    // typed without its scheme
    expect(await orOf("e-hentai.org/g/899557/edd545586a/")).toContainEqual({ source: "ehentai", sourceId: "899557/edd545586a" });
  });

  it("finds a title by its legacy `source:id` text", async () => {
    expect(await orOf("hitomi:1234567")).toContainEqual({ source: "hitomi", sourceId: "1234567" });
  });

  it("adds no title clause for a link that names no title", async () => {
    for (const q of ["https://3hentai.net/tags/big-breasts", "https://nhentai.net/", "netorare"]) {
      expect((await orOf(q)).some((c) => "source" in (c as object))).toBe(false);
    }
  });
});

const NH = "https://nhentai.net";
const scrape: ScrapeResult = {
  source: "nhentai",
  source_id: "42",
  url: `${NH}/g/42/`,
  title_name: "Shared source title",
  image_link: "https://t.nhentai.net/galleries/1/cover.jpg",
  pages: 20,
  uploaded_at: "2026-01-01",
  artists: [{ name: "artist", link: `${NH}/artist/artist/`, total_works: 10 }],
  groups: [{ name: "group", link: `${NH}/group/group/`, total_works: 10 }],
  characters: [{ name: "character", link: `${NH}/character/character/`, total_works: 10 }],
  parodies: [{ name: "parody", link: `${NH}/parody/parody/`, total_works: 10 }],
  tags: [{ name: "tag", link: `${NH}/tag/tag/`, total_works: 10 }],
};

describe("scrape payload validation", () => {
  it.each([
    null,
    { ...scrape, pages: 1.5 },
    { ...scrape, pages: Infinity },
    { ...scrape, source_id: "2147483648" },
    { ...scrape, source: "example" },
    { ...scrape, source: "nhentai.xxx" }, // the address is on nhentai.net
    { ...scrape, source_id: "42 " },
    { ...scrape, url: "https://evil.example/g/42/" },
    { ...scrape, url: `${NH}/g/43/` },
    { ...scrape, url: `${NH}/tag/tag/` },
    { ...scrape, source: "3hentai.net", source_id: "612345", url: undefined },
    { ...scrape, image_link: "javascript:alert(1)" },
    { ...scrape, image_link: "/galleries/1/cover.jpg" },
    { ...scrape, title_name: "x".repeat(256) },
    { ...scrape, tags: [null] },
    { ...scrape, artists: [{ ...scrape.artists[0], total_works: -1 }] },
    { ...scrape, groups: [{ ...scrape.groups[0], link: false }] },
  ])("rejects malformed payload %# before starting a transaction", async (payload) => {
    await expect(upsertScrapedTitle(USER, payload)).rejects.toMatchObject({ name: "ValidationError" });
    expect(transaction).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // An nhentai id is its hashtag, an INT4 the database keeps below 1e9. The
  // boundary refuses one that cannot be (400) rather than let the insert fail
  // in Postgres (500).
  it.each([
    { ...scrape, source_id: "2147483648", url: `${NH}/g/2147483648/` },
    { ...scrape, source_id: "1000000000", url: undefined },
  ])("rejects an nhentai id that cannot be a hashtag (%#) before starting a transaction", async (payload) => {
    await expect(upsertScrapedTitle(USER, payload)).rejects.toMatchObject({ name: "ValidationError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts a cover on any CDN", async () => {
    queryRaw.mockImplementation(async (q) =>
      q.strings.join("").includes("INSERT INTO titles") ? [{ hashtag: 42 }] : [{ id: 7, name: q.values[1] }]);
    await upsertScrapedTitle(USER, { ...scrape, image_link: "https://cdn.some-other-host.net/x/cover.webp?sig=1" });
    const title = queryRaw.mock.calls.map(([q]) => q).find((q) => q.strings.join("").includes("INSERT INTO titles"))!;
    expect(title.values).toContain("https://cdn.some-other-host.net/x/cover.webp?sig=1");
  });

  it("drops an entity link off the title's site instead of refusing the title", async () => {
    queryRaw.mockImplementation(async (q) =>
      q.strings.join("").includes("INSERT INTO titles") ? [{ hashtag: 42 }] : [{ id: 7, name: q.values[1] }]);
    await upsertScrapedTitle(USER, {
      ...scrape,
      groups: [{ ...scrape.groups[0], link: "https://evil.example/group/" }],
      tags: [{ name: "tag", link: "javascript:alert(1)", total_works: 3 }],
    });
    expect(transaction).toHaveBeenCalledOnce();
    const groups = queryRaw.mock.calls.map(([q]) => q).find((q) => q.strings.join("").includes('INSERT INTO "groups"'))!;
    expect(groups.values).toEqual([USER, "group", "", 10]);
    const tags = queryRaw.mock.calls.map(([q]) => q).find((q) => q.strings.join("").includes('INSERT INTO "tags"'))!;
    expect(tags.values).toEqual([USER, "tag", "", 3]);
    // links on the site are kept
    const artists = queryRaw.mock.calls.map(([q]) => q).find((q) => q.strings.join("").includes('INSERT INTO "artists"'))!;
    expect(artists.values).toEqual([USER, "artist", `${NH}/artist/artist/`, 10]);
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

  it("scopes delete, rename, and every part of a read transaction", async () => {
    await deleteTitle(USER, 42);
    await updateAlterName(USER, 42, "  My title  ");
    await markRead(USER, 42);
    expect(db.title.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, hashtag: 42 } });
    expect(db.title.update).toHaveBeenCalledWith({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } },
      data: { alterName: "My title" },
    });
    const read = queryRaw.mock.calls[0][0];
    expect(read.strings.join("?")).toContain("WHERE user_id = ? AND hashtag = ?");
    expect(read.values).toEqual([USER, 42, READ_DEDUPE_MINUTES]);
    expect(db.readLog.create).toHaveBeenCalledWith({ data: { userId: USER, hashtag: 42 } });
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0][0]).toBeTypeOf("function");
    expect(db.$executeRaw).toHaveBeenCalledBefore(queryRaw);
    expect(queryRaw.mock.calls[1][0].values).toEqual(expect.arrayContaining(["read", USER, READ_LIMIT]));
  });

  // The entity upserts answer with ids; the title upsert answers with the key
  // the row ended up under.
  const answerUpserts = (hashtag: number) =>
    queryRaw.mockImplementation(async (q) =>
      q.strings.join("").includes("INSERT INTO titles") ? [{ hashtag }] : [{ id: 7, name: q.values[1] }]);
  const titleStatement = () =>
    queryRaw.mock.calls.map(([q]) => q).find((q) => q.strings.join("").includes("INSERT INTO titles"))!;

  it("upserts entities, the title, and replacement links under the same owner", async () => {
    answerUpserts(42);
    await upsertScrapedTitle(USER, scrape);
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(6);
    for (const [q] of queryRaw.mock.calls) {
      expect(q.strings.join("?")).toContain("(user_id,");
      expect(q.strings.join("?")).toContain("ON CONFLICT (user_id,");
      expect(q.values[0]).toBe(USER);
    }
    // nhentai keeps its gallery id as the key; the scrape never writes alterName.
    const title = titleStatement();
    expect(title.strings.join("?")).toContain("ON CONFLICT (user_id, source, source_id) DO UPDATE");
    expect(title.strings.join("?")).not.toContain("alter_name");
    expect(title.strings.join("?")).not.toContain("nextval");
    expect(title.values.slice(0, 5)).toEqual([USER, 42, "nhentai", "42", `${NH}/g/42/`]);
    // A re-scrape refreshes the address along with the rest of the scrape.
    expect(title.strings.join("?")).toMatch(/DO UPDATE SET[\s\S]*\burl = EXCLUDED\.url/);
    // …and keeps what its page no longer shows (run for real in prisma/migration.test.ts).
    for (const kept of [
      "image_link = COALESCE(NULLIF(EXCLUDED.image_link, ''), titles.image_link)",
      "pages = COALESCE(NULLIF(EXCLUDED.pages, 0), titles.pages)",
      "uploaded_at = COALESCE(EXCLUDED.uploaded_at, titles.uploaded_at)",
    ]) expect(title.strings.join("?")).toContain(kept);
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

  it("files another site's title under the key the database hands out", async () => {
    answerUpserts(1_000_000_005);
    await upsertScrapedTitle(USER, {
      ...scrape,
      source: "3hentai.net",
      source_id: "612345",
      url: "https://3hentai.net/d/612345",
      image_link: "https://s5.3hentai.net/d612345/cover.jpg",
      uploaded_at: null,
      artists: [], groups: [], characters: [], parodies: [],
      tags: [{ name: "tag", link: "https://3hentai.net/tags/tag", total_works: 0 }],
    });
    const title = titleStatement();
    const sql = title.strings.join("?");
    // Reuse the row's key, else draw one — never trust a key from the payload.
    expect(sql).toMatch(/COALESCE\(\s*\(SELECT hashtag FROM titles WHERE user_id = \? AND source = \? AND source_id = \?\),\s*nextval\('titles_foreign_hashtag_seq'\)\)/);
    expect(title.values).toEqual([
      USER, USER, "3hentai.net", "612345", "3hentai.net", "612345", "https://3hentai.net/d/612345",
      scrape.title_name, "https://s5.3hentai.net/d612345/cover.jpg", 20, null,
      USER, "3hentai.net", "612345", USER, 5000,
    ]);
    expect(db.titleTag.createMany).toHaveBeenCalledWith({
      data: [{ userId: USER, hashtag: 1_000_000_005, idTag: 7 }],
      skipDuplicates: true,
    });
  });

  it("files a legacy site's title under its legacy key, at its canonical page", async () => {
    answerUpserts(1_000_000_006);
    // The seven-site shape older hosts send: a legacy key, no url.
    await upsertScrapedTitle(USER, {
      ...scrape,
      source: "hitomi",
      source_id: "1234567",
      url: undefined,
      image_link: "",
      uploaded_at: null,
      artists: [], groups: [], characters: [], parodies: [],
      tags: [{ name: "tag", link: "https://hitomi.la/tag/tag-all.html", total_works: 0 }],
    });
    expect(titleStatement().values).toEqual([
      USER, USER, "hitomi", "1234567", "hitomi", "1234567", "https://hitomi.la/galleries/1234567.html",
      scrape.title_name, "", 20, null,
      USER, "hitomi", "1234567", USER, 5000,
    ]);
  });

  it("writes the rebuilt page for a legacy nhentai payload without a url", async () => {
    answerUpserts(42);
    await upsertScrapedTitle(USER, { ...scrape, url: undefined });
    expect(titleStatement().values.slice(0, 5)).toEqual([USER, 42, "nhentai", "42", `${NH}/g/42/`]);
  });

  it("does not let a site without counts zero another site's count", async () => {
    answerUpserts(42);
    await upsertScrapedTitle(USER, scrape);
    const tags = queryRaw.mock.calls.map(([q]) => q.strings.join("?")).find((q) => q.includes('INSERT INTO "tags"'))!;
    expect(tags).toContain('total_works = COALESCE(NULLIF(EXCLUDED.total_works, 0), "tags".total_works)');
  });

  it("looks titles up by where they come from, inside the collection", async () => {
    await getTitlesByRefs(USER, [
      { source: "hitomi", id: "1" }, { source: "nhentai", id: "2" }, { source: "myreadingmanga.info", id: "some-title" },
    ]);
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        userId: USER,
        OR: [
          { source: "hitomi", sourceId: "1" },
          { source: "nhentai", sourceId: "2" },
          { source: "myreadingmanga.info", sourceId: "some-title" },
        ],
      },
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

  it("hands the most-read titles their page, rebuilding a legacy row's", async () => {
    queryRaw.mockResolvedValue([]);
    const most = (over: Record<string, unknown>) => ({
      hashtag: 1, source: "nhentai", sourceId: "1", url: null, titleName: "t", alterName: null, pages: 10,
      readCount: 2, imageLink: "", artists: [], ...over,
    });
    findMany.mockResolvedValueOnce([
      most({ hashtag: 177013, sourceId: "177013" }),
      most({ hashtag: 1_000_000_001, source: "hitomi", sourceId: "1234567" }),
      most({ hashtag: 1_000_000_002, source: "3hentai.net", sourceId: "612345", url: "https://3hentai.net/d/612345" }),
    ]);
    const { mostRead } = await getStats(USER, "UTC");
    expect(mostRead.map((m) => [m.label, m.url])).toEqual([
      ["#177013", "https://nhentai.net/g/177013/"],
      ["hitomi 1234567", "https://hitomi.la/galleries/1234567.html"],
      ["3hentai 612345", "https://3hentai.net/d/612345"],
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ url: true }) }));
  });

  it("hands similar titles their page", async () => {
    const sim = (over: Record<string, unknown>) => ({
      hashtag: 1, title_name: "t", alter_name: null, image_link: "", source: "nhentai", source_id: "1", url: null,
      pages: 10, shared: BigInt(3), ...over,
    });
    queryRaw.mockResolvedValueOnce([
      sim({ hashtag: 177013, source_id: "177013" }),
      sim({ hashtag: 1_000_000_002, source: "3hentai.net", source_id: "612345", url: "https://3hentai.net/d/612345" }),
    ]);
    const items = await getSimilar(USER, 42);
    expect(items.map((i) => i.url)).toEqual(["https://nhentai.net/g/177013/", "https://3hentai.net/d/612345"]);
    expect(items[0]).toEqual({
      hashtag: 177013, titleName: "t", alterName: "", imageLink: "", url: "https://nhentai.net/g/177013/", pages: 10, shared: 3,
    });
    expect(queryRaw.mock.calls[0][0].strings.join("?")).toMatch(/SELECT [^;]*\bt\.url\b/);
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
      () => getUnnamedHashtags(userId), () => deleteTitles(userId, [42]),
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

describe("shared write quotas", () => {
  function answerWrite(created: boolean) {
    queryRaw.mockImplementation(async (q) => {
      const sql = q.strings.join("");
      if (sql.includes("INSERT INTO titles")) return [{ hashtag: 42, created }];
      if (sql.includes("INSERT INTO usage_budget")) return [{ used: BigInt(1) }];
      return [{ id: 7, name: q.values[1] }];
    });
  }

  it("charges a new title exactly once, after the title and before entities, in its transaction", async () => {
    answerWrite(true);
    await upsertScrapedTitle(USER, scrape);
    expect(db.$executeRaw).toHaveBeenCalledBefore(queryRaw);
    const queries = queryRaw.mock.calls.map(([q]) => q);
    expect(queries[0].strings.join("")).toContain("INSERT INTO titles");
    expect(queries[1].values).toEqual(expect.arrayContaining(["commit", USER, 1, COMMIT_LIMIT]));
    expect(queries[2].strings.join("")).toContain('INSERT INTO "artists"');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("allows re-scraping existing titles without ever touching the commit budget", async () => {
    answerWrite(false);
    await upsertScrapedTitle(USER, scrape);
    expect(queryRaw.mock.calls.some(([q]) => q.strings.join("").includes("usage_budget"))).toBe(false);
    expect(db.title.findUniqueOrThrow).toHaveBeenCalled();
  });

  it("a title-cap denial aborts before creating entities or spending a commit", async () => {
    queryRaw.mockResolvedValue([]);
    await expect(upsertScrapedTitle(USER, scrape)).rejects.toThrow("Title limit reached (5000)");
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(db.titleTag.createMany).not.toHaveBeenCalled();
  });

  it("a new-title budget denial throws inside the title transaction before creating entities", async () => {
    queryRaw.mockResolvedValueOnce([{ hashtag: 42, created: true }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 200 }]);
    await expect(upsertScrapedTitle(USER, scrape)).rejects.toEqual(
      new UsageLimitError("New-title limit reached (240/hour). Try again later.", 200),
    );
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(db.titleTag.createMany).not.toHaveBeenCalled();
  });

  it("dedupes a repeat read without changing its budget, log or read counter", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await markRead(USER, 42)).toBe(1);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][0].strings.join("")).toContain("last_read_at <=");
    expect(db.readLog.create).not.toHaveBeenCalled();
    expect(db.title.update).not.toHaveBeenCalled();
    expect(db.title.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { userId_hashtag: { userId: USER, hashtag: 42 } }, select: { readCount: true },
    });
  });

  it("returns the actual recorded count for the client's optimistic update", async () => {
    queryRaw.mockResolvedValueOnce([{ read_count: 3 }]).mockResolvedValueOnce([{ used: BigInt(1) }]);
    expect(await markRead(USER, 42)).toBe(3);
    expect(db.readLog.create).toHaveBeenCalledExactlyOnceWith({ data: { userId: USER, hashtag: 42 } });
  });

  it("a daily-cap denial rolls back the read counter and never appends a log", async () => {
    queryRaw.mockResolvedValueOnce([{ hashtag: 42 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 99 }]);
    await expect(markRead(USER, 42)).rejects.toThrow("Read history limit reached (500/day)");
    expect(db.readLog.create).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("swipe deck", () => {
  it("draws only the owner's titles that have no custom name", async () => {
    findMany.mockResolvedValueOnce([{ hashtag: 3 }, { hashtag: 9 }]);
    expect(await getUnnamedHashtags(USER)).toEqual([3, 9]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER, OR: [{ alterName: null }, { alterName: "" }] },
      select: { hashtag: true },
    });
  });

  it("deletes the whole list in ONE statement, scoped to the owner", async () => {
    queryRaw.mockResolvedValueOnce([{ hashtag: 5 }, { hashtag: 7 }]);
    expect(await deleteTitles(USER, [5, 7, 7, 11])).toEqual([5, 7]);
    // one statement for the batch — the serialized-write contract
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(db.title.deleteMany).not.toHaveBeenCalled();
    const q = queryRaw.mock.calls[0][0];
    expect(q.strings.join("?")).toMatch(/DELETE FROM titles WHERE user_id = \? AND hashtag IN \(\?,\?,\?\)\s+RETURNING hashtag/);
    expect(q.values).toEqual([USER, 5, 7, 11]);
  });

  it("drops junk ids instead of failing the list, and skips an empty one", async () => {
    queryRaw.mockResolvedValueOnce([]);
    await deleteTitles(USER, [0, -1, 1.5, 2 ** 31, 8] as number[]);
    expect(queryRaw.mock.calls[0][0].values).toEqual([USER, 8]);
    queryRaw.mockClear();
    expect(await deleteTitles(USER, [])).toEqual([]);
    expect(await deleteTitles(USER, "5" as unknown as number[])).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
