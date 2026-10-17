// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAdd } from "./QuickAdd";
import type { TitleRef } from "../lib/sources";

// The real action returns a complete Item (dbTitleToItem), so the stub must
// too — a partial object would let a render bug hide behind a lenient mock.
vi.mock("../app/actions", () => ({
  findExistingTitlesAction: vi.fn(async () => []),
  commitScrapedAction: vi.fn(async (raw: { source: string; source_id: string; url: string }, alterName?: string) => ({
    // The key the database hands out: nhentai's id, else a fresh one.
    hashtag: raw.source === "nhentai" ? Number(raw.source_id) : 1_000_000_001,
    source: raw.source,
    sourceId: raw.source_id,
    url: raw.url,
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

const nhUrl = (id: number) => `https://nhentai.net/g/${id}/`;

// What a scraper host answers with — the title's page address included.
const scraped = (hashtag: number, source = "nhentai", url = nhUrl(hashtag)) => ({
  source,
  source_id: String(hashtag),
  url,
  title_name: "PenXjbs",
  image_link: "",
  pages: 225,
  uploaded_at: "2016-10-18",
  tags: [{ name: "ahegao", link: "https://nhentai.net/tag/ahegao/", total_works: 1 }],
  artists: [{ name: "penqech", link: "https://nhentai.net/artist/penqech/", total_works: 1 }],
  groups: [],
  characters: [],
  parodies: [],
});

const existingItem = (hashtag: number, alterName = "") => ({
  hashtag,
  source: "nhentai",
  sourceId: String(hashtag),
  url: nhUrl(hashtag),
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

// What the /add page hands over: parseTitleRef's key plus the page to scrape.
const nh = (id: number): TitleRef => ({ source: "nhentai", id: String(id), url: nhUrl(id) });
const HITOMI: TitleRef = { source: "hitomi", id: "1234567", url: "https://hitomi.la/galleries/1234567.html" };

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
    render(<QuickAdd titleRef={nh(661586)} />);

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
    render(<QuickAdd titleRef={nh(661586)} />);
    await waitFor(() => expect(screen.getByText(/already in collection/i)).toBeTruthy());

    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(updateAlterNameAction).not.toHaveBeenCalled();
  });

  it("saves an edited name through updateAlterName, not a re-commit", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([existingItem(661586, "old") as never]);
    stubScrape({ ok: true });
    render(<QuickAdd titleRef={nh(661586)} />);
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
  it("shows an expected quota failure returned by the Server Action", async () => {
    stubScrape({ ok: true });
    vi.mocked(commitScrapedAction).mockResolvedValueOnce({ error: "Title limit reached (5000). Delete a title." });
    render(<QuickAdd titleRef={nh(177013)} />);
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    await act(async () => button().click());
    await waitFor(() => expect(screen.getByText("Title limit reached (5000). Delete a title.")).toBeTruthy());
    expect(screen.queryByText(/saved to collection/i)).toBeNull();
  });
  it("scrapes, previews, and commits the name in the same call", async () => {
    stubScrape({ ok: true });
    render(<QuickAdd titleRef={nh(177013)} />);

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
    expect(commitScrapedAction).toHaveBeenCalledWith(
      expect.objectContaining({ source: "nhentai", source_id: "177013", url: nhUrl(177013) }),
      "PenEbir",
    );
    await waitFor(() => expect(screen.getByText(/saved as "PenEbir"/i)).toBeTruthy());
  });

  it("commits with no name when the field is left empty", async () => {
    stubScrape({ ok: true });
    render(<QuickAdd titleRef={nh(177013)} />);
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    await act(async () => button().click());
    expect(commitScrapedAction).toHaveBeenCalledWith(expect.objectContaining({ source: "nhentai", source_id: "177013" }), "");
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
    render(<QuickAdd titleRef={nh(177013)} />);

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
  it("links to Account on a missing-host verdict without retrying", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false, status: 409,
      json: async () => ({ code: "NO_SCRAPER_HOST", error: "No host" }),
    }));
    vi.stubGlobal("fetch", fetchFn);
    render(<QuickAdd titleRef={nh(177013)} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Set up a scraper host" }).getAttribute("href")).toBe("/account"));
    expect(screen.getByText(/Set up your own host in Account settings before adding titles/)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("treats a 4xx as final and does not retry", async () => {
    const fetchFn = stubScrape({ ok: false, status: 404, error: "Title #177013 not found on nhentai (404)" });
    render(<QuickAdd titleRef={nh(177013)} />);
    await waitFor(() => expect(screen.getByText(/not found on nhentai/i)).toBeTruthy());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true); // nothing to save
  });

  it("retries a transient 5xx and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    const fetchFn = stubScrape({ ok: false, status: 503 }, { ok: true });
    render(<QuickAdd titleRef={nh(177013)} />);

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
    render(<QuickAdd titleRef={nh(177013)} />);
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("QuickAdd — other sites", () => {
  it("checks the collection by the title's key, scrapes its page, and shows its site", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ scraped: { ...scraped(1234567, "hitomi", HITOMI.url), tags: [], artists: [] }, via: "impit" }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchFn);
    render(<QuickAdd titleRef={HITOMI} />);

    // Labelled as ever, and named by its host on hover.
    expect(screen.getByText("hitomi 1234567").getAttribute("title")).toBe("hitomi.la");
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(findExistingTitlesAction).toHaveBeenCalledWith(["hitomi:1234567"]);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ input: HITOMI.url, persist: false });

    await act(async () => button().click());
    expect(commitScrapedAction).toHaveBeenCalledWith(
      expect.objectContaining({ source: "hitomi", source_id: "1234567", url: HITOMI.url }),
      "",
    );
    await waitFor(() => expect(screen.getByText(/saved to collection/i)).toBeTruthy());
  });

  it("adds a title from a site it has never seen, by the address it was given", async () => {
    // No list of sites: the page the share sheet handed over is what is read.
    const page = "https://www.somesite.org/gallery/42/";
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ scraped: { ...scraped(42, "somesite.org", page), image_link: "https://cdn.somesite-img.net/42/cover.jpg" }, via: "impit" }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchFn);
    const { container } = render(<QuickAdd titleRef={{ source: "somesite.org", id: "42", url: page }} />);

    expect(screen.getByText("somesite 42").getAttribute("title")).toBe("somesite.org");
    await waitFor(() => expect(screen.getAllByText("PenXjbs").length).toBeGreaterThan(0));
    expect(findExistingTitlesAction).toHaveBeenCalledWith(["somesite.org:42"]);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ input: page, persist: false });
    // The preview's cover goes through the proxy, with the page's origin as Referer.
    const src = new URL(container.querySelector("img")!.getAttribute("src")!, window.location.href);
    expect(src.origin).toBe(window.location.origin);
    expect(`${src.pathname}${src.search}`).toBe(
      `/api/cover?src=${encodeURIComponent("https://cdn.somesite-img.net/42/cover.jpg")}&ref=${encodeURIComponent("https://www.somesite.org")}`,
    );

    await act(async () => button().click());
    expect(commitScrapedAction).toHaveBeenCalledWith(
      expect.objectContaining({ source: "somesite.org", source_id: "42", url: page }),
      "",
    );
    await waitFor(() => expect(screen.getByText(/saved to collection/i)).toBeTruthy());
  });

  it("renames a known title from another site by the key it is stored under", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([
      { ...existingItem(1_000_000_002, "old"), source: "hitomi", sourceId: "1234567", url: HITOMI.url } as never,
    ]);
    const fetchFn = stubScrape({ ok: true });
    render(<QuickAdd titleRef={HITOMI} />);
    await waitFor(() => expect(screen.getByText(/already in collection/i)).toBeTruthy());
    await act(async () => {
      const input = nameField();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "new name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button().click());
    expect(updateAlterNameAction).toHaveBeenCalledWith(1_000_000_002, "new name");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
