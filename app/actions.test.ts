import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/session", () => ({ requireUserId: vi.fn() }));
vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("../lib/titles", () => ({
  deleteTitle: vi.fn(), markRead: vi.fn(), updateAlterName: vi.fn(), upsertScrapedTitle: vi.fn(),
  queryTitles: vi.fn(), getStats: vi.fn(), getSimilar: vi.fn(), getTitle: vi.fn(),
  getTitlesByHashtags: vi.fn(), getTitlesByRefs: vi.fn(), getTagAffinity: vi.fn(), getGhostTagsFor: vi.fn(),
  getUnnamedHashtags: vi.fn(), deleteTitles: vi.fn(),
}));
import * as actions from "./actions";
import * as titles from "../lib/titles";
import { requireUserId } from "../lib/session";
import { updateTag } from "next/cache";
import type { ScrapeResult } from "../lib/scrape-payload";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUserId).mockResolvedValue("user-a");
});

const protectedCalls: [string, () => Promise<unknown>][] = [
  ["commit", () => actions.commitScrapedAction({} as ScrapeResult)],
  ["delete", () => actions.deleteTitleAction(1)],
  ["read", () => actions.markReadAction(1)],
  ["rename", () => actions.updateAlterNameAction(1, "name")],
  ["query", () => actions.queryTitlesAction({})],
  ["stats", () => actions.getStatsAction("Europe/Berlin")],
  ["similar", () => actions.getSimilarAction(1)],
  ["affinity", () => actions.getTagAffinityAction({ tags: ["tag"] })],
  ["ghost", () => actions.getGhostTagsAction(1)],
  ["title", () => actions.getTitleAction(1)],
  ["existing", () => actions.findExistingTitlesAction(["nhentai:1"])],
  ["swipe deck", () => actions.getSwipeDeckAction()],
  ["swipe cards", () => actions.getSwipeCardsAction([1])],
  ["delete list", () => actions.deleteTitlesAction([1])],
];

describe("Server Action authorization", () => {
  it.each(protectedCalls)("%s rejects a direct unauthenticated call before any data access", async (_, call) => {
    vi.mocked(requireUserId).mockRejectedValue(new Error("Unauthorized"));
    await expect(call()).rejects.toThrow("Unauthorized");
    for (const operation of Object.values(titles)) expect(operation).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("derives the owner from the session even when a query carries a forged userId", async () => {
    vi.mocked(titles.queryTitles).mockResolvedValue({ items: [], total: 0 });
    const params = { userId: "user-b", limit: 10 };
    await actions.queryTitlesAction(params);
    expect(titles.queryTitles).toHaveBeenCalledWith("user-a", params);
  });

  it("deletes and invalidates only the authenticated collection", async () => {
    await actions.deleteTitleAction(123);
    expect(titles.deleteTitle).toHaveBeenCalledWith("user-a", 123);
    expect(vi.mocked(updateTag).mock.calls.map(([tag]) => tag)).toEqual([
      "titles-list:user-a", "title:user-a:123", "similar:user-a:123",
      "similar:user-a", "dataset:user-a", "stats:user-a",
    ]);
  });

  it("does not invalidate data when an ownership-scoped write fails", async () => {
    vi.mocked(titles.markRead).mockRejectedValue(new Error("Title not found"));
    await expect(actions.markReadAction(123)).rejects.toThrow("Title not found");
    expect(titles.markRead).toHaveBeenCalledWith("user-a", 123);
    expect(updateTag).not.toHaveBeenCalled();
  });
});

describe("swipe deck actions", () => {
  // `url` is null on rows saved before migration 9a recorded the page.
  const title = (hashtag: number) => ({
    hashtag, source: "nhentai", sourceId: String(hashtag), url: null, titleName: `t${hashtag}`, alterName: null,
    imageLink: "", pages: 1, uploadedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01"), readCount: 0,
    lastReadAt: null, artists: [], groups: [], characters: [], parodies: [], tags: [],
  });

  it("reads the deck from the authenticated collection", async () => {
    vi.mocked(titles.getUnnamedHashtags).mockResolvedValue([4, 2]);
    expect(await actions.getSwipeDeckAction()).toEqual([4, 2]);
    expect(titles.getUnnamedHashtags).toHaveBeenCalledWith("user-a");
  });

  it("returns cards in the order asked for, drops junk, and caps a call", async () => {
    vi.mocked(titles.getTitlesByHashtags).mockResolvedValue([title(2), title(9)] as never);
    const cards = await actions.getSwipeCardsAction([9, -1, 2, 404, 1.5] as number[]);
    expect(cards.map((c) => c.hashtag)).toEqual([9, 2]);
    // A row saved without its page still opens on its site's own gallery page.
    expect(cards.map((c) => c.url)).toEqual(["https://nhentai.net/g/9/", "https://nhentai.net/g/2/"]);
    expect(titles.getTitlesByHashtags).toHaveBeenCalledWith("user-a", [9, 2, 404]);
    vi.mocked(titles.getTitlesByHashtags).mockClear();
    await actions.getSwipeCardsAction(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(vi.mocked(titles.getTitlesByHashtags).mock.calls[0][1]).toHaveLength(10);
    vi.mocked(titles.getTitlesByHashtags).mockClear();
    expect(await actions.getSwipeCardsAction([])).toEqual([]);
    expect(titles.getTitlesByHashtags).not.toHaveBeenCalled();
  });

  it("invalidates what a delete does, for exactly the titles deleted", async () => {
    vi.mocked(titles.deleteTitles).mockResolvedValue([5]);
    expect(await actions.deleteTitlesAction([5, 6])).toEqual([5]);
    expect(titles.deleteTitles).toHaveBeenCalledWith("user-a", [5, 6]);
    expect(vi.mocked(updateTag).mock.calls.map(([tag]) => tag)).toEqual([
      "titles-list:user-a", "title:user-a:5", "similar:user-a:5",
      "similar:user-a", "dataset:user-a", "stats:user-a",
    ]);
  });

  it("invalidates nothing when nothing was deleted", async () => {
    vi.mocked(titles.deleteTitles).mockResolvedValue([]);
    await actions.deleteTitlesAction([404]);
    expect(updateTag).not.toHaveBeenCalled();
  });
});

describe("add flow actions", () => {
  const savedRow = (fields: Record<string, unknown>) => ({
    titleName: "t", alterName: null, imageLink: "", pages: 1, uploadedAt: null, createdAt: new Date(), readCount: 0,
    lastReadAt: null, avgTagValue: null, userId: "user-a", artists: [], groups: [], characters: [], parodies: [], tags: [],
    ...fields,
  }) as unknown as Awaited<ReturnType<typeof titles.upsertScrapedTitle>>;

  it("files a commit under the key the database returned, not one from the payload", async () => {
    vi.mocked(titles.upsertScrapedTitle).mockResolvedValue(savedRow({
      hashtag: 1_000_000_004, source: "hitomi", sourceId: "1234567", url: "https://hitomi.la/galleries/1234567.html",
    }));
    const payload = { source: "hitomi", source_id: "1234567", hashtag: 5 } as unknown as ScrapeResult;
    const item = await actions.commitScrapedAction(payload, "  my name ");
    expect(titles.upsertScrapedTitle).toHaveBeenCalledWith("user-a", payload);
    expect(titles.updateAlterName).toHaveBeenCalledWith("user-a", 1_000_000_004, "my name");
    expect(vi.mocked(updateTag).mock.calls.map(([tag]) => tag)).toContain("title:user-a:1000000004");
    expect(item).toMatchObject({
      hashtag: 1_000_000_004, source: "hitomi", url: "https://hitomi.la/galleries/1234567.html", alterName: "my name",
    });
  });

  it("returns a title from any site with the page it was saved from", async () => {
    vi.mocked(titles.upsertScrapedTitle).mockResolvedValue(savedRow({
      hashtag: 1_000_000_009, source: "some-gallery.net", sourceId: "4242", url: "https://www.some-gallery.net/g/4242/",
    }));
    const item = await actions.commitScrapedAction({ source: "some-gallery.net" } as unknown as ScrapeResult);
    expect(titles.updateAlterName).not.toHaveBeenCalled(); // no name given, none written
    expect(item).toMatchObject({
      hashtag: 1_000_000_009, source: "some-gallery.net", sourceId: "4242", url: "https://www.some-gallery.net/g/4242/",
      alterName: "",
    });
  });

  it("looks up only well-formed refs, deduped and capped", async () => {
    vi.mocked(titles.getTitlesByRefs).mockResolvedValue([]);
    await actions.findExistingTitlesAction([
      "hitomi:1", "https://hitomi.la/galleries/1.html", "nhentai:2", "garbage", 5 as unknown as string,
      ...Array.from({ length: 300 }, (_, i) => `imhentai:${i + 1}`),
    ]);
    const [, refs] = vi.mocked(titles.getTitlesByRefs).mock.calls[0];
    expect(refs.slice(0, 2)).toEqual([{ source: "hitomi", id: "1" }, { source: "nhentai", id: "2" }]);
    expect(refs.length).toBeLessThanOrEqual(200);
    expect(refs.every((r) => r.source !== undefined)).toBe(true);
  });

  it("reads the keys jobs carry for any site, and the links they came from", async () => {
    // A job's key is refKey(ref) — "some-gallery.net:4242" — while what it sends
    // to the scraper is the page address; both name the same title.
    vi.mocked(titles.getTitlesByRefs).mockResolvedValue([]);
    await actions.findExistingTitlesAction([
      "some-gallery.net:4242",
      "https://www.some-gallery.net/g/4242/?utm_source=share#page-3",
      "ehentai:899557/edd545586a",
      "https://e-hentai.org/g/899557/edd545586a/",
      "177013",
    ]);
    const [userId, refs] = vi.mocked(titles.getTitlesByRefs).mock.calls[0];
    expect(userId).toBe("user-a");
    // Keys only: the lookup never sees an address to trust.
    expect(refs).toEqual([
      { source: "some-gallery.net", id: "4242" },
      { source: "ehentai", id: "899557/edd545586a" },
      { source: "nhentai", id: "177013" },
    ]);
  });

  it("reads a key as a key even when its id holds something address-shaped", async () => {
    // "/<series>/<title>" ids keep the series slug, and a slug may hold a dot:
    // read as a link, "vol.2-special/some-title-x" is a page on the host
    // "vol.2-special" — another site, another title, never found.
    vi.mocked(titles.getTitlesByRefs).mockResolvedValue([]);
    await actions.findExistingTitlesAction([
      "manga.example.com:vol.2-special/some-title-x",
      "manga.example.com:a.b/c",
    ]);
    const [, refs] = vi.mocked(titles.getTitlesByRefs).mock.calls[0];
    expect(refs).toEqual([
      { source: "manga.example.com", id: "vol.2-special/some-title-x" },
      { source: "manga.example.com", id: "a.b/c" },
    ]);
  });

  it("does not look up keys that no title could have been saved under", async () => {
    vi.mocked(titles.getTitlesByRefs).mockResolvedValue([]);
    expect(await actions.findExistingTitlesAction([
      "not a site:1", ":1", "nhentai:", "localhost:3000", "javascript:alert(1)",
      "https://some-gallery.net/tag/big-breasts/", "https://127.0.0.1/g/1/", "https://some-gallery.net:8080/g/1/",
    ])).toEqual([]);
    expect(titles.getTitlesByRefs).not.toHaveBeenCalled();
  });

  it("does not touch the database for nothing usable", async () => {
    expect(await actions.findExistingTitlesAction(["nope", ""])).toEqual([]);
    expect(await actions.findExistingTitlesAction("hitomi:1" as unknown as string[])).toEqual([]);
    expect(titles.getTitlesByRefs).not.toHaveBeenCalled();
  });

  it("maps what it finds to items carrying their page", async () => {
    vi.mocked(titles.getTitlesByRefs).mockResolvedValue([
      savedRow({ hashtag: 1_000_000_009, source: "some-gallery.net", sourceId: "4242", url: "https://www.some-gallery.net/g/4242/" }),
      savedRow({ hashtag: 177013, source: "nhentai", sourceId: "177013", url: null }),
    ] as never);
    const items = await actions.findExistingTitlesAction(["some-gallery.net:4242", "nhentai:177013"]);
    expect(items.map((i) => [i.source, i.url])).toEqual([
      ["some-gallery.net", "https://www.some-gallery.net/g/4242/"],
      ["nhentai", "https://nhentai.net/g/177013/"],
    ]);
  });
});
