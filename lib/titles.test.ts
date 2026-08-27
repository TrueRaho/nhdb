import { beforeEach, describe, expect, it, vi } from "vitest";

// queryTitles reaches the database and, being a "use cache" function, the
// request-scoped cache API. Both are stubbed so the test can inspect the
// `where` tree that buildWhere produces — the expansion's OR nesting is the
// part of this file that is easy to get subtly, silently wrong.
// vi.hoisted, because vi.mock's factory is lifted above every other statement
// in the file and would otherwise close over uninitialised bindings.
const { findMany, count, queryRaw } = vi.hoisted(() => ({
  // Typed with the args they receive so `mock.calls` keeps the `where` tree
  // this file is here to assert on.
  findMany: vi.fn<(args: { where?: unknown }) => Promise<unknown[]>>(async () => []),
  count: vi.fn<(args: { where?: unknown }) => Promise<number>>(async () => 0),
  queryRaw: vi.fn<(q: { strings?: readonly string[] }) => Promise<unknown[]>>(async () => []),
}));
vi.mock("./db", () => ({ prisma: { title: { findMany, count }, $queryRaw: queryRaw } }));
vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn() }));

import { queryTitles, type QueryParams } from "./titles";

/** The `where` queryTitles handed to Prisma for these params. */
async function whereFor(params: QueryParams) {
  await queryTitles(params);
  return findMany.mock.calls.at(-1)![0].where;
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
  findMany.mockClear();
  count.mockClear();
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
