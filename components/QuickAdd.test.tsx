// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAdd } from "./QuickAdd";

// The real action returns a complete Item (dbTitleToItem), so the stub must
// too — a partial object would let a render bug hide behind a lenient mock.
vi.mock("../app/actions", () => ({
  findExistingTitlesAction: vi.fn(async () => []),
  commitScrapedAction: vi.fn(async (raw: { hashtag: number }, alterName?: string) => ({
    hashtag: raw.hashtag,
    titleName: "PenXjbs",
    alterName: alterName?.trim() ?? "",
    imageLink: "",
    pages: 225,
    tags: ["ahegao"],
    artists: ["penqech"],
    groups: [],
    characters: [],
    parodies: [],
    uploadedAt: 100,
    addedAt: 0,
    readCount: 0,
    lastReadAt: null,
  })),
  updateAlterNameAction: vi.fn(async () => {}),
}));
import { commitScrapedAction, findExistingTitlesAction, updateAlterNameAction } from "../app/actions";

const scraped = (hashtag: number) => ({
  hashtag,
  title_name: "PenXjbs",
  image_link: "",
  pages: 225,
  uploaded_at: "2016-10-18",
  tags: [{ name: "ahegao", link: "", total_works: 1 }],
  artists: [{ name: "penqech", link: "", total_works: 1 }],
  groups: [],
  characters: [],
  parodies: [],
});

const existingItem = (hashtag: number, alterName = "") => ({
  hashtag,
  titleName: "PenXjbs",
  alterName,
  imageLink: "",
  pages: 225,
  tags: ["ahegao"],
  artists: ["penqech"],
  groups: [],
  characters: [],
  parodies: [],
  uploadedAt: 100,
  addedAt: 3,
  readCount: 2,
  lastReadAt: 1,
});

/** Queues canned /api/scrape responses, one per attempt. */
function stubScrape(...responses: ({ ok: true } | { ok: false; status: number; error?: string })[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.ok) {
      return { ok: true, status: 200, json: async () => ({ scraped: scraped(177013), via: "impit" }) } as unknown as Response;
    }
    return {
      ok: false,
      status: r.status,
      statusText: String(r.status),
      json: async () => ({ error: r.error ?? "boom" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const nameField = () => screen.getByLabelText(/alternative name/i) as HTMLInputElement;
const button = () => screen.getAllByRole("button").at(-1) as HTMLButtonElement;

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("QuickAdd — title already in the collection", () => {
  it("skips the scraper entirely and leaves the name field empty", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([existingItem(661586, "Hard training") as never]);
    const fetchFn = stubScrape({ ok: true });
    render(<QuickAdd hashtag={661586} />);

    await waitFor(() => expect(screen.getByText(/already in collection/i)).toBeTruthy());
    // The whole point of the uncached collection check: no scrape for a known id.
    expect(fetchFn).not.toHaveBeenCalled();
    // Never prefilled — the stored name only shows as a hint.
    expect(nameField().value).toBe("");
    expect(nameField().placeholder).toBe("Hard training");
    expect(button().textContent).toMatch(/save name/i);
  });

  it("cannot submit an untouched field, so a stored name is never wiped", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([existingItem(661586, "Hard training") as never]);
    stubScrape({ ok: true });
    render(<QuickAdd hashtag={661586} />);
    await waitFor(() => expect(screen.getByText(/already in collection/i)).toBeTruthy());

    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(updateAlterNameAction).not.toHaveBeenCalled();
  });

  it("saves an edited name through updateAlterName, not a re-commit", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([existingItem(661586, "old") as never]);
    stubScrape({ ok: true });
    render(<QuickAdd hashtag={661586} />);
    await waitFor(() => expect(screen.getByText(/already in collection/i)).toBeTruthy());
    expect(nameField().value).toBe("");

    await act(async () => {
      const input = nameField();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "new name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button().click());

    expect(updateAlterNameAction).toHaveBeenCalledWith(661586, "new name");
    expect(commitScrapedAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/saved as "new name"/i)).toBeTruthy());
  });
});

describe("QuickAdd — new title", () => {
  it("scrapes, previews, and commits the name in the same call", async () => {
    stubScrape({ ok: true });
    render(<QuickAdd hashtag={177013} />);

    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(button().textContent).toMatch(/add to collection/i);

    await act(async () => {
      const input = nameField();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "PenEbir");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button().click());

    // One round trip creates the row AND names it.
    expect(commitScrapedAction).toHaveBeenCalledWith(expect.objectContaining({ hashtag: 177013 }), "PenEbir");
    await waitFor(() => expect(screen.getByText(/saved as "PenEbir"/i)).toBeTruthy());
  });

  it("commits with no name when the field is left empty", async () => {
    stubScrape({ ok: true });
    render(<QuickAdd hashtag={177013} />);
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    await act(async () => button().click());
    expect(commitScrapedAction).toHaveBeenCalledWith(expect.objectContaining({ hashtag: 177013 }), "");
    await waitFor(() => expect(screen.getByText(/saved to collection/i)).toBeTruthy());
  });

  it("keeps a name typed while the scrape was still running", async () => {
    // The field is editable from the first paint; a late-arriving scrape must
    // not clobber what the user already typed.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ scraped: scraped(177013), via: "impit" }) } as unknown as Response;
    }));
    render(<QuickAdd hashtag={177013} />);

    await act(async () => {
      const input = nameField();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "typed early");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(nameField().value).toBe("typed early");
  });
});

describe("QuickAdd — failures", () => {
  it("treats a 4xx as final and does not retry", async () => {
    const fetchFn = stubScrape({ ok: false, status: 404, error: "Title #177013 not found on nhentai (404)" });
    render(<QuickAdd hashtag={177013} />);
    await waitFor(() => expect(screen.getByText(/not found on nhentai/i)).toBeTruthy());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true); // nothing to save
  });

  it("retries a transient 5xx and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    const fetchFn = stubScrape({ ok: false, status: 503 }, { ok: true });
    render(<QuickAdd hashtag={177013} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("still tries to scrape when the collection check itself fails", async () => {
    vi.mocked(findExistingTitlesAction).mockRejectedValueOnce(new Error("db down"));
    const fetchFn = stubScrape({ ok: true });
    render(<QuickAdd hashtag={177013} />);
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
