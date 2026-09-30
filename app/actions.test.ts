import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/session", () => ({ requireUserId: vi.fn() }));
vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("../lib/titles", () => ({
  deleteTitle: vi.fn(), markRead: vi.fn(), updateAlterName: vi.fn(), upsertScrapedTitle: vi.fn(),
  queryTitles: vi.fn(), getStats: vi.fn(), getSimilar: vi.fn(), getTitle: vi.fn(),
  getTitlesByHashtags: vi.fn(), getTagAffinity: vi.fn(), getGhostTagsFor: vi.fn(),
  getUnnamedHashtags: vi.fn(), deleteTitles: vi.fn(),
}));
import * as actions from "./actions";
import * as titles from "../lib/titles";
import { requireUserId } from "../lib/session";
import { updateTag } from "next/cache";
import type { ScrapeResult } from "../lib/scraper";

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
  ["existing", () => actions.findExistingTitlesAction([1])],
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
  const title = (hashtag: number) => ({
    hashtag, titleName: `t${hashtag}`, alterName: null, imageLink: "", pages: 1,
    uploadedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01"), readCount: 0, lastReadAt: null,
    artists: [], groups: [], characters: [], parodies: [], tags: [],
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
