import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/session", () => ({ requireUserId: vi.fn() }));
vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("../lib/titles", () => ({
  deleteTitle: vi.fn(), markRead: vi.fn(), updateAlterName: vi.fn(), upsertScrapedTitle: vi.fn(),
  queryTitles: vi.fn(), getStats: vi.fn(), getSimilar: vi.fn(), getTitle: vi.fn(),
  getTitlesByHashtags: vi.fn(), getTagAffinity: vi.fn(), getGhostTagsFor: vi.fn(),
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
