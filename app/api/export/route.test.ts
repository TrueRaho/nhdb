import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../lib/session", () => ({ requireUserId: vi.fn(), UnauthorizedError: class UnauthorizedError extends Error {} }));
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(), $transaction: vi.fn(),
  title: { findMany: vi.fn(), aggregate: vi.fn() },
  readLog: { findMany: vi.fn(), aggregate: vi.fn() },
  scraperEndpoint: { findMany: vi.fn() },
}));
vi.mock("../../../lib/db", () => ({ prisma: db }));
import { requireUserId, UnauthorizedError } from "../../../lib/session";
import { EXPORT_LIMIT } from "../../../lib/usage-limits";
import { TITLE_EXPORT_BATCH, READ_LOG_EXPORT_BATCH } from "../../../lib/collection-export";
import { GET } from "./route";

const START = new Date("2026-10-17T10:00:00Z");
const title = (userId: string, hashtag = 101) => ({
  userId, hashtag, source: "nhentai", sourceId: String(hashtag), url: null,
  titleName: `${userId} title`, alterName: "custom", imageLink: "https://example.org/cover.jpg", pages: 42,
  uploadedAt: null, createdAt: new Date("2026-01-02T03:00:00Z"), readCount: 2,
  lastReadAt: new Date("2026-02-03T04:00:00Z"),
  artists: [{ artist: { artistName: "artist", artistLink: "/artist", totalWorks: 10 } }],
  groups: [{ group: { groupName: "group", groupLink: "/group", totalWorks: null } }],
  parodies: [{ parody: { parodieName: "parody", parodieLink: "/parody", totalWorks: 3 } }],
  characters: [{ character: { characterName: "character", characterLink: "", totalWorks: 1 } }],
  tags: [{ tag: { tagName: "tag", tagLink: "/tag", totalWorks: 2 } }],
});
type Log = { userId: string; id: number; hashtag: number; readAt: Date };
let titles: ReturnType<typeof title>[];
let logs: Log[];

// In-memory Prisma boundary: apply owner/bounds/keysets and project only selected fields.
type Row = Record<string, unknown>;
type Query = { where: Row; select?: Row; orderBy?: Row | Row[]; take?: number };
const comparable = (value: unknown) => value instanceof Date ? value.getTime() : value as number | string;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "OR") return (filter as Row[]).some((part) => matches(row, part));
    if (filter && typeof filter === "object" && !(filter instanceof Date)) {
      const ops = filter as Row;
      return (ops.lte === undefined || comparable(row[key]) <= comparable(ops.lte)) &&
        (ops.gt === undefined || comparable(row[key]) > comparable(ops.gt));
    }
    return comparable(row[key]) === comparable(filter);
  });
}
function selected(rows: Row[], args: Query) {
  const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
  return rows.filter((row) => matches(row, args.where)).sort((a, b) => {
    for (const clause of order) for (const [key, direction] of Object.entries(clause)) {
      const x = comparable(a[key]), y = comparable(b[key]);
      if (x !== y) return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
    }
    return 0;
  }).slice(0, args.take).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => args.select?.[key])));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  titles = [title("user-a"), title("user-b")];
  logs = [
    { userId: "user-a", id: 1, hashtag: 101, readAt: new Date("2026-02-03T04:00:00Z") },
    { userId: "user-b", id: 2, hashtag: 101, readAt: new Date("2026-03-01T00:00:00Z") },
  ];
  vi.mocked(requireUserId).mockResolvedValue("user-a");
  vi.mocked(db.$queryRaw).mockResolvedValue([{ used: BigInt(1) }]);
  db.title.aggregate.mockImplementation(async (args: { where: Row }) => {
    const keys = titles.filter((t) => matches(t, args.where)).map((t) => t.hashtag);
    return { _max: { hashtag: keys.length ? Math.max(...keys) : null } };
  });
  db.readLog.aggregate.mockImplementation(async (args: { where: Row }) => {
    const keys = logs.filter((l) => matches(l, args.where)).map((l) => l.id);
    return { _max: { id: keys.length ? Math.max(...keys) : null } };
  });
  vi.mocked(db.title.findMany).mockImplementation(async (args: Query) => selected(titles, args));
  vi.mocked(db.readLog.findMany).mockImplementation(async (args: Query) => selected(logs, args));
});
afterEach(() => vi.useRealTimers());

describe("collection export GET", () => {
  it("streams the same session-owned JSON shape, metadata and logs without secrets", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toContain('attachment; filename="nhdb-collection.json"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(db.title.findMany).not.toHaveBeenCalled();
    const data = await response.json();
    expect(data).toEqual({
      version: 1, exportedAt: START.toISOString(),
      titles: [{
        hashtag: 101, source: "nhentai", sourceId: "101", url: "https://nhentai.net/g/101/",
        titleName: "user-a title", alterName: "custom", imageLink: "https://example.org/cover.jpg", pages: 42,
        uploadedAt: null, createdAt: "2026-01-02T03:00:00.000Z", readCount: 2, lastReadAt: "2026-02-03T04:00:00.000Z",
        artists: [{ name: "artist", link: "/artist", totalWorks: 10 }],
        groups: [{ name: "group", link: "/group", totalWorks: null }],
        parodies: [{ name: "parody", link: "/parody", totalWorks: 3 }],
        characters: [{ name: "character", link: "", totalWorks: 1 }],
        tags: [{ name: "tag", link: "/tag", totalWorks: 2 }],
      }],
      readLog: [{ id: 1, hashtag: 101, readAt: "2026-02-03T04:00:00.000Z" }],
    });
    expect(db.title.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user-a" }) }));
    expect(db.readLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user-a" }) }));
    expect(JSON.stringify(data)).not.toMatch(/user-b|userId|secret|ciphertext|bearer|scraperEndpoint|usageBudget/i);
    expect(db.scraperEndpoint.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    const charge = vi.mocked(db.$queryRaw).mock.calls[0][0] as { values: unknown[] };
    expect(charge.values).toEqual(expect.arrayContaining(["export", "user-a", EXPORT_LIMIT, "day", 1]));
    expect(vi.mocked(db.$queryRaw).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(db.title.aggregate).mock.invocationCallOrder[0]);
  });
  it("refuses an unauthenticated request without charging or reading data", async () => {
    vi.mocked(requireUserId).mockRejectedValue(new UnauthorizedError("Unauthorized"));
    expect((await GET()).status).toBe(401);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.title.aggregate).not.toHaveBeenCalled();
  });
  it("returns 429 and Retry-After before creating any stream or reading collection data", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 123 }]);
    const response = await GET();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("123");
    expect(await response.json()).toEqual({ error: "Export limit reached (20/day). Try again tomorrow." });
    expect(db.title.aggregate).not.toHaveBeenCalled();
    expect(db.readLog.aggregate).not.toHaveBeenCalled();
    expect(db.title.findMany).not.toHaveBeenCalled();
    expect(db.readLog.findMany).not.toHaveBeenCalled();
  });
  it("returns an empty collection for a different signed-in owner", async () => {
    vi.mocked(requireUserId).mockResolvedValue("user-c");
    expect(await (await GET()).json()).toMatchObject({ titles: [], readLog: [] });
  });
  it("does not leak database or scraper details on a failure before streaming", async () => {
    vi.mocked(db.title.aggregate).mockRejectedValue(new Error("database-secret"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database-secret");
  });
  it("emits a collection larger than 4.5 MB in small chunks with keyset batches and backpressure", async () => {
    titles = Array.from({ length: 5000 }, (_, i) => ({ ...title("user-a", i + 1),
      tags: Array.from({ length: 8 }, (_, tag) => ({ tag: {
        tagName: `tag-${tag}`, tagLink: `https://example.org/tag/${"x".repeat(180)}`, totalWorks: 1,
      } })),
    }));
    // Tied timestamps across three pages exercise the (read_at, id) keyset.
    logs = Array.from({ length: 2101 }, (_, i) => ({ userId: "user-a", id: i + 1, hashtag: 1, readAt: START }));
    const response = await GET();
    const reader = response.body!.getReader();
    let bytes = 0, count = 0, maxChunk = 0, titleCount = 0, logCount = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength; count++; maxChunk = Math.max(maxChunk, value.byteLength);
      if (count === 2) expect(db.title.findMany).toHaveBeenCalledTimes(1);
      const record = decoder.decode(value).replace(/^,/, "");
      if (record.startsWith('{"hashtag"')) {
        expect(JSON.parse(record).hashtag).toBe(++titleCount);
      } else if (record.startsWith('{"id"')) {
        expect(JSON.parse(record).id).toBe(++logCount);
      }
    }
    expect(bytes).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(maxChunk).toBeLessThan(16 * 1024);
    expect(count).toBe(5000 + 2101 + 3);
    expect(titleCount).toBe(5000); expect(logCount).toBe(2101);
    expect(db.title.findMany).toHaveBeenCalledTimes(20);
    expect(db.readLog.findMany).toHaveBeenCalledTimes(3);
    for (const [args] of vi.mocked(db.title.findMany).mock.calls) expect(args?.take).toBe(TITLE_EXPORT_BATCH);
    for (const [args] of vi.mocked(db.readLog.findMany).mock.calls) expect(args?.take).toBe(READ_LOG_EXPORT_BATCH);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("excludes additions after the captured start and key bounds, including backdated logs", async () => {
    const response = await GET();
    titles.push(title("user-a", 102)); // Below the time bound but above the captured key.
    titles.push({ ...title("user-a", 100), createdAt: new Date(START.getTime() + 1) });
    logs.push({ userId: "user-a", id: 3, hashtag: 101, readAt: new Date("2026-01-01T00:00:00Z") });
    logs.push({ userId: "user-a", id: 0, hashtag: 101, readAt: new Date(START.getTime() + 1) });
    const data = await response.json();
    expect(data.titles.map((t: { hashtag: number }) => t.hashtag)).toEqual([101]);
    expect(data.readLog.map((l: { id: number }) => l.id)).toEqual([1]);
    expect(db.title.aggregate).toHaveBeenCalledWith({ where: { userId: "user-a", createdAt: { lte: START } }, _max: { hashtag: true } });
    expect(db.readLog.aggregate).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: { lte: START } }, _max: { id: true } });
  });
  it("stops loading batches after the download is cancelled", async () => {
    titles = Array.from({ length: 501 }, (_, i) => title("user-a", i + 1));
    const reader = (await GET()).body!.getReader();
    await reader.read(); // Header.
    await reader.read(); // First title of the first batch.
    await reader.cancel();
    expect(db.title.findMany).toHaveBeenCalledTimes(1);
    expect(db.readLog.findMany).not.toHaveBeenCalled();
  });
  it("aborts a failed stream without leaking database details or returning valid partial JSON", async () => {
    vi.mocked(db.title.findMany).mockRejectedValue(new Error("database-secret"));
    const response = await GET();
    expect(response.status).toBe(200); // Headers precede the failed batch query.
    await expect(response.text()).rejects.toThrow("Collection export interrupted. Download it again.");
  });
});
