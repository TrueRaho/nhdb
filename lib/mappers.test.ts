import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbTitleToItem, type DbTitle } from "./mappers";

// DbTitle is the full Prisma payload type; tests only exercise the fields the
// mapper reads, so the fixture is built loose and cast once here.
function row(overrides: Record<string, unknown> = {}): DbTitle {
  return {
    hashtag: 177013,
    titleName: "PenXjbs",
    alterName: null,
    imageLink: "https://t.nhentai.net/x/cover.jpg",
    pages: 225,
    uploadedAt: new Date("2016-10-18T00:00:00Z"),
    createdAt: new Date("2026-08-10T00:00:00Z"),
    readCount: 3,
    lastReadAt: new Date("2026-08-14T00:00:00Z"),
    avgTagValue: null,
    tags: [{ tag: { tagName: "ahegao" } }, { tag: { tagName: "dark skin" } }],
    artists: [{ artist: { artistName: "penqech" } }],
    groups: [],
    characters: [{ character: { characterName: "quill imco" } }],
    parodies: [{ parody: { parodieName: "original" } }],
    ...overrides,
  } as unknown as DbTitle;
}

describe("dbTitleToItem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts dates to whole-day 'days ago' integers", () => {
    const item = dbTitleToItem(row());
    expect(item.addedAt).toBe(6); // 2026-08-10 → 6 days
    expect(item.lastReadAt).toBe(2); // 2026-08-14 → 2 days
    expect(item.uploadedAt).toBe(Math.floor((Date.now() - new Date("2016-10-18T00:00:00Z").getTime()) / 86400000));
  });

  it("keeps null lastReadAt as null, never 'today'", () => {
    expect(dbTitleToItem(row({ lastReadAt: null })).lastReadAt).toBeNull();
  });

  it("maps a null alterName to the empty string the client expects", () => {
    expect(dbTitleToItem(row()).alterName).toBe("");
    expect(dbTitleToItem(row({ alterName: "PenEbir" })).alterName).toBe("PenEbir");
  });

  it("flattens relation rows to plain name arrays in order", () => {
    const item = dbTitleToItem(row());
    expect(item.tags).toEqual(["ahegao", "dark skin"]);
    expect(item.artists).toEqual(["penqech"]);
    expect(item.groups).toEqual([]);
    expect(item.characters).toEqual(["quill imco"]);
    expect(item.parodies).toEqual(["original"]);
  });

  it("floors partial days rather than rounding up", () => {
    // 23h59m ago is still day 0 — the UI renders 0 as "today".
    const item = dbTitleToItem(row({ createdAt: new Date("2026-08-15T12:01:00Z") }));
    expect(item.addedAt).toBe(0);
  });
});
