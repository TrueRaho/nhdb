// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrapeJobsProvider, useScrapeJobs, type ScrapeJob } from "./ScrapeJobsProvider";
import { parseTitleRef, type TitleRef } from "../lib/sources";

const STORAGE_KEY = "nhdb.scrapeJobs.v3:user-a";

// Server actions go through the network in the real app — stub the module.
vi.mock("../app/actions", () => ({
  findExistingTitlesAction: vi.fn(async () => []),
  commitScrapedAction: vi.fn(async (raw: { source_id: string }) => saved(Number(raw.source_id))),
}));
import { commitScrapedAction, findExistingTitlesAction } from "../app/actions";

// What the actions hand back for a stored nhentai title (only the fields the
// provider reads). Hoisted: the vi.mock factory above runs before this line.
function saved(hashtag: number) {
  return { hashtag, source: "nhentai", sourceId: String(hashtag), url: nhUrl(hashtag) } as never;
}

// An nhentai title's page — what a job sends /api/scrape since jobs carry the
// page address (ref.url) rather than the `source:id` key. Hoisted, like saved().
function nhUrl(hashtag: number) {
  return `https://nhentai.net/g/${hashtag}/`;
}

// The payload a scraper host answers with for one title. `url` is part of it:
// the write boundary re-derives the id from that address.
const scrapedOf = (ref: TitleRef) => ({
  source: ref.source,
  source_id: ref.id,
  url: ref.url,
  title_name: `t${ref.id}`,
  image_link: "",
  pages: 10,
  uploaded_at: "2024-01-01",
  tags: [],
  artists: [],
  groups: [],
  characters: [],
  parodies: [],
});
const scrapedFor = (hashtag: number) => scrapedOf({ source: "nhentai", id: String(hashtag), url: nhUrl(hashtag) });

// A fetch stub whose responses resolve only when the test says so — the only
// way to observe the pool's concurrency behavior deterministically.
function gatedFetch() {
  const pending: { input: string; respond: (r: unknown) => void }[] = [];
  const fn = vi.fn(
    (_url: string, init: { body: string }) =>
      new Promise((resolve) => {
        pending.push({
          input: (JSON.parse(init.body) as { input: string }).input,
          respond: resolve,
        });
      }),
  );
  // Answers for the title the request named, the way the route reads it: a
  // page address, or the legacy `source:id` text older stored jobs still hold.
  const ok = (p: { respond: (r: unknown) => void; input: string }) => {
    const ref = parseTitleRef(p.input);
    if (!ref) throw new Error(`the stub cannot answer for ${p.input}`);
    p.respond({ ok: true, status: 200, json: async () => ({ scraped: scrapedOf(ref), via: "impit" }) });
  };
  const fail = (p: { respond: (r: unknown) => void }, status: number, error = "boom") =>
    p.respond({ ok: false, status, statusText: String(status), json: async () => ({ error }) });
  vi.stubGlobal("fetch", fn);
  return { fn, pending, ok, fail };
}

// The provider is exercised through its context, not through UI. The capture
// happens in an effect (not during render) to satisfy react-hooks/immutability;
// the effect has no dep array, so every provider re-render refreshes the ref.
const probe = { ctx: null as unknown as ReturnType<typeof useScrapeJobs> };
function Probe() {
  const value = useScrapeJobs();
  useEffect(() => {
    probe.ctx = value;
  });
  return null;
}
const mount = () => render(<ScrapeJobsProvider userId="user-a"><Probe /></ScrapeJobsProvider>);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("scrape pool", () => {
  it("runs at most 4 scrapes concurrently and starts the next as one frees", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => {
      await probe.ctx.startScrape("111111 222222 333333 444444 555555 666666");
    });

    // 6 queued, only 4 in flight; the waiting two say so.
    expect(f.fn).toHaveBeenCalledTimes(4);
    await waitFor(() => {
      expect(probe.ctx.jobs).toHaveLength(6);
      expect(probe.ctx.jobs.filter((j) => j.note === "queued…")).toHaveLength(2);
    });

    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(f.fn).toHaveBeenCalledTimes(5));

    await act(async () => f.ok(f.pending[1]));
    await waitFor(() => expect(f.fn).toHaveBeenCalledTimes(6));
    // Each job sends its title's page, not its key.
    expect(f.pending.map((p) => p.input).sort()).toEqual(
      [111111, 222222, 333333, 444444, 555555, 666666].map(nhUrl),
    );
  });

  it("folds a success into a ready job under its real key", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => {
      expect(probe.ctx.jobs).toEqual([
        expect.objectContaining({
          key: "nhentai:111111",
          input: nhUrl(111111),
          status: "ready",
          via: "impit",
          item: expect.objectContaining({ hashtag: 111111, url: nhUrl(111111) }),
        }),
      ]);
      expect(probe.ctx.readyCount).toBe(1);
    });
  });

  it("queues titles from any site and drops listings, home pages and prose", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape(`https://hitomi.la/reader/1234567.html#2
      https://hentaifox.com/search/?q=quill+mfnd
      https://e-hentai.org/g/899557/edd545586a/ https://example.com/whatever 111111
      some page title https://example.com/ https://example.com/tag/big-breasts/ 2024`));
    // Looked up by `source:id`: the seven old sites keep their short keys, any
    // other site is keyed by its host.
    const keys = ["hitomi:1234567", "ehentai:899557/edd545586a", "example.com:whatever", "nhentai:111111"];
    expect(findExistingTitlesAction).toHaveBeenCalledWith(keys);
    // Scraped by page address: an old site's canonical page (a reader page
    // becomes the gallery's), any other site's link as pasted, minus the fragment.
    expect(f.pending.map((p) => p.input)).toEqual([
      "https://hitomi.la/galleries/1234567.html",
      "https://e-hentai.org/g/899557/edd545586a/",
      "https://example.com/whatever",
      nhUrl(111111),
    ]);
    expect(probe.ctx.jobs.map((j) => j.key)).toEqual(keys);
  });

  it("scrapes a site it has never seen by the page's own address, keyed by its host", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("https://www.somesite.org/gallery/42/?utm_source=share#page-3"));
    expect(findExistingTitlesAction).toHaveBeenCalledWith(["somesite.org:42"]);
    // Tracking noise and the fragment never reach the scraper.
    expect(f.pending.map((p) => p.input)).toEqual(["https://www.somesite.org/gallery/42/"]);
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(probe.ctx.jobs).toEqual([
      expect.objectContaining({
        key: "somesite.org:42",
        status: "ready",
        item: expect.objectContaining({ hashtag: 0, source: "somesite.org", url: "https://www.somesite.org/gallery/42/" }),
      }),
    ]));
    vi.mocked(commitScrapedAction).mockResolvedValueOnce(
      { hashtag: 1_000_000_003, source: "somesite.org", sourceId: "42", url: "https://www.somesite.org/gallery/42/" } as never,
    );
    await act(async () => {
      await probe.ctx.commitReady();
    });
    // The payload goes back with its address, which the write boundary re-checks.
    expect(commitScrapedAction).toHaveBeenCalledWith(
      expect.objectContaining({ source: "somesite.org", source_id: "42", url: "https://www.somesite.org/gallery/42/" }),
    );
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("clears another site's preview once it is saved, though it had no key before", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("hitomi:1234567"));
    // Legacy `source:id` text is turned into the title's page before it is sent.
    expect(f.pending[0].input).toBe("https://hitomi.la/galleries/1234567.html");
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(probe.ctx.jobs).toEqual([
      expect.objectContaining({ key: "hitomi:1234567", status: "ready", item: expect.objectContaining({ hashtag: 0 }) }),
    ]));
    vi.mocked(commitScrapedAction).mockResolvedValueOnce(
      { hashtag: 1_000_000_001, source: "hitomi", sourceId: "1234567" } as never,
    );
    await act(async () => {
      await probe.ctx.commitReady();
    });
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("does not double-drive an id that is already scraping", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    // Different spellings of one title share its key.
    await act(async () => probe.ctx.startScrape("111111, nhentai.net/g/111111 https://nhentai.net/g/111111/3/#x"));
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(probe.ctx.jobs).toHaveLength(1);
  });

  it("marks known titles duplicate without scraping them", async () => {
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([
      saved(111111),
    ]);
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222"));
    expect(f.pending.map((p) => p.input)).toEqual([nhUrl(222222)]);
    await waitFor(() =>
      expect(probe.ctx.jobs).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "nhentai:111111", status: "duplicate" })]),
      ),
    );
  });

  it("matches a known title from any site by its key, not its address", async () => {
    // Stored under another spelling of the same page — the key is what matches.
    vi.mocked(findExistingTitlesAction).mockResolvedValueOnce([
      { hashtag: 1_000_000_004, source: "somesite.org", sourceId: "42", url: "https://somesite.org/gallery/42/" } as never,
    ]);
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("https://m.somesite.org/gallery/42/2/"));
    expect(findExistingTitlesAction).toHaveBeenCalledWith(["somesite.org:42"]);
    expect(f.fn).not.toHaveBeenCalled();
    expect(probe.ctx.jobs).toEqual([
      expect.objectContaining({ key: "somesite.org:42", status: "duplicate", item: expect.objectContaining({ hashtag: 1_000_000_004 }) }),
    ]);
  });

  it("lands a definitive 4xx as an error after exactly one attempt", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.fail(f.pending[0], 404, "Title not found"));
    await waitFor(() =>
      expect(probe.ctx.jobs[0]).toMatchObject({ status: "error", error: "Title not found" }),
    );
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it("schedules a retry (with a note) on a transient 5xx instead of failing", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.fail(f.pending[0], 503));
    await waitFor(() => expect(probe.ctx.jobs[0].note).toMatch(/waking scraper/));
    expect(probe.ctx.jobs[0].status).toBe("scraping"); // still alive, not error
  });

  it("dismissing a queued job prevents its fetch entirely", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222 333333 444444 555555"));
    expect(f.fn).toHaveBeenCalledTimes(4); // #555555 waits in the queue
    await act(async () => probe.ctx.dismiss("nhentai:555555"));
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(4));
    expect(f.fn).toHaveBeenCalledTimes(4);
    expect(f.pending.map((p) => p.input)).not.toContain(nhUrl(555555));
  });

  it("resumes a job left scraping in storage from a previous session", async () => {
    localStorage.setItem(
      "nhdb.scrapeJobs.v3:user-a",
      JSON.stringify([
        { key: "somesite.org:42", input: "https://somesite.org/gallery/42/", status: "scraping" },
        // A job an older tab stored holds the `source:id` text, which the
        // route still reads — it is resent as it was, not dropped.
        { key: "nhentai:777777", input: "nhentai:777777", status: "scraping" },
      ]),
    );
    const f = gatedFetch();
    mount();
    await waitFor(() => expect(f.fn).toHaveBeenCalledTimes(2));
    expect(f.pending.map((p) => p.input)).toEqual(["https://somesite.org/gallery/42/", "nhentai:777777"]);
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.jobs.map((j) => [j.key, j.status]).sort()).toEqual([
      ["nhentai:777777", "ready"],
      ["somesite.org:42", "ready"],
    ]));
  });

  it("keeps a finished-but-unsaved scrape across a tab close, payload and all", async () => {
    // Closing the tab between "scraped" and "add" must not throw the result
    // away: the scraped payload is what commitReady saves, so losing it would
    // silently cost a second scrape.
    localStorage.setItem(
      "nhdb.scrapeJobs.v3:user-a",
      JSON.stringify([
        {
          key: "nhentai:888888",
          input: nhUrl(888888),
          status: "ready",
          item: { hashtag: 888888, source: "nhentai", sourceId: "888888", url: nhUrl(888888), titleName: "t888888", tags: [], artists: [] },
          raw: scrapedFor(888888),
        },
      ]),
    );
    const f = gatedFetch();
    mount();

    expect(probe.ctx.readyCount).toBe(1);
    expect(f.fn).not.toHaveBeenCalled(); // nothing to re-scrape

    let result: Awaited<ReturnType<typeof probe.ctx.commitReady>>;
    await act(async () => {
      result = await probe.ctx.commitReady();
    });
    expect(result!.saved.map((s) => s.hashtag)).toEqual([888888]);
  });

  it("ignores corrupt persisted state instead of crashing", async () => {
    localStorage.setItem("nhdb.scrapeJobs.v3:user-a", '{"not":"an array"}');
    gatedFetch();
    mount();
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("commitReady saves every ready job and sweeps the list", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222"));
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(2));

    let result: Awaited<ReturnType<typeof probe.ctx.commitReady>>;
    await act(async () => {
      result = await probe.ctx.commitReady();
    });
    expect(vi.mocked(commitScrapedAction)).toHaveBeenCalledTimes(2);
    expect(result!.saved.map((s) => s.hashtag).sort()).toEqual([111111, 222222]);
    expect(result!.failedMsg).toBeNull();
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("commits strictly one at a time — concurrent commits race the DB stat triggers", async () => {
    // The COUNT(*)-recompute triggers on titlestotags lose updates under
    // concurrent transactions; serialized commits are the fix. Gate the first
    // commit and assert the second doesn't start until it resolves.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    vi.mocked(commitScrapedAction)
      .mockImplementationOnce(async (raw: { source_id: string }) => {
        await gate;
        return saved(Number(raw.source_id));
      })
      .mockImplementationOnce(async (raw: { source_id: string }) => saved(Number(raw.source_id)));

    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222"));
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(2));

    let done = false;
    let commitPromise!: Promise<unknown>;
    await act(async () => {
      commitPromise = probe.ctx.commitReady().then((r) => { done = true; return r; });
      await Promise.resolve(); // give the first commit a chance to start
    });
    expect(vi.mocked(commitScrapedAction)).toHaveBeenCalledTimes(1); // second waits
    expect(done).toBe(false);
    await act(async () => {
      releaseFirst();
      await commitPromise;
    });
    expect(vi.mocked(commitScrapedAction)).toHaveBeenCalledTimes(2);
  });

  it("keeps a ready job whose commit failed so a retry can still save it", async () => {
    vi.mocked(commitScrapedAction)
      .mockResolvedValueOnce(saved(111111))
      .mockRejectedValueOnce(new Error("db down"));
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222"));
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(2));

    let result: Awaited<ReturnType<typeof probe.ctx.commitReady>>;
    await act(async () => {
      result = await probe.ctx.commitReady();
    });
    expect(result!.saved.map((s) => s.hashtag)).toEqual([111111]);
    expect(result!.failedMsg).toMatch(/db down/);
    expect(probe.ctx.jobs).toEqual([expect.objectContaining({ key: "nhentai:222222", status: "ready" })]);
  });
});

// The `storage` event fires only in OTHER documents, so a test drives it by
// hand: write what the peer tab would have written, then dispatch the event.
function peerWrites(jobs: Partial<ScrapeJob>[]) {
  const value = JSON.stringify(jobs);
  localStorage.setItem(STORAGE_KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: value }));
}

describe("cross-tab sync", () => {
  it("adopts a peer's jobs instead of letting the last writer win", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(1));

    // Peer queued a different title and mirrored its own list.
    await act(async () => {
      peerWrites([
        { key: "nhentai:111111", input: nhUrl(111111), status: "ready" },
        { key: "nhentai:222222", input: nhUrl(222222), status: "scraping" },
      ]);
    });
    expect(probe.ctx.jobs.map((j) => j.key).sort()).toEqual(["nhentai:111111", "nhentai:222222"]);
  });

  it("does not fetch a job the peer is already driving", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: nhUrl(222222), status: "scraping" }]);
    });
    // Visible in this tab...
    expect(probe.ctx.jobs.map((j) => j.key)).toEqual(["nhentai:222222"]);
    // ...but the peer owns the fetch.
    await new Promise((r) => setTimeout(r, 50));
    expect(f.fn).not.toHaveBeenCalled();
  });

  it("never downgrades a local terminal status to a peer's stale 'scraping'", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(1));
    const readyJob = probe.ctx.jobs[0];

    await act(async () => {
      peerWrites([{ key: "nhentai:111111", input: nhUrl(111111), status: "scraping" }]);
    });
    // The scraped payload survives — losing it would strand an unsavable job.
    expect(probe.ctx.jobs[0].status).toBe("ready");
    expect(probe.ctx.jobs[0].raw).toEqual(readyJob.raw);
  });

  it("takes a peer's terminal status over its own 'scraping' (symmetric rule)", async () => {
    gatedFetch();
    mount();
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: nhUrl(222222), status: "scraping" }]);
    });
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: nhUrl(222222), status: "error", error: "not found" }]);
    });
    expect(probe.ctx.jobs[0]).toMatchObject({ status: "error", error: "not found" });
  });

  it("propagates a peer's dismissal of a job this tab is not driving", async () => {
    gatedFetch();
    mount();
    await act(async () => {
      peerWrites([
        { key: "nhentai:111111", input: nhUrl(111111), status: "ready" },
        { key: "nhentai:222222", input: nhUrl(222222), status: "ready" },
      ]);
    });
    expect(probe.ctx.jobs).toHaveLength(2);
    await act(async () => {
      peerWrites([{ key: "nhentai:111111", input: nhUrl(111111), status: "ready" }]);
    });
    expect(probe.ctx.jobs.map((j) => j.key)).toEqual(["nhentai:111111"]);
  });

  it("keeps its own in-flight job the peer has never heard of", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => {
      peerWrites([{ key: "nhentai:999999", input: nhUrl(999999), status: "ready" }]);
    });
    // Our in-flight #111111 must not vanish just because the peer's snapshot
    // predates it — that was the original data-loss bug.
    expect(probe.ctx.jobs.map((j) => j.key).sort()).toEqual(["nhentai:111111", "nhentai:999999"]);
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => expect(probe.ctx.jobs.find((j) => j.key === "nhentai:111111")?.status).toBe("ready"));
  });

  it("ignores a corrupt peer write rather than dropping the queue", async () => {
    gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => {
      const value = "{not json";
      localStorage.setItem(STORAGE_KEY, value);
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: value }));
    });
    expect(probe.ctx.jobs.map((j) => j.key)).toEqual(["nhentai:111111"]);
  });

  it("does not echo an adopted list back to storage", async () => {
    gatedFetch();
    mount();
    const remote: Partial<ScrapeJob>[] = [{ key: "nhentai:222222", input: nhUrl(222222), status: "ready" }];
    await act(async () => peerWrites(remote));
    // Byte-identical to what the peer wrote: no write-back, so no event storm.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(remote));
  });
});


describe("account isolation", () => {
  it("never restores the legacy queue or another account's queue", () => {
    const job = { key: "nhentai:111111", input: nhUrl(111111), status: "ready", raw: scrapedFor(111111) };
    localStorage.setItem("nhdb.scrapeJobs.v1", JSON.stringify([job]));
    localStorage.setItem("nhdb.scrapeJobs.v3:user-b", JSON.stringify([job]));
    mount();
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("resets jobs when the account changes and ignores foreign storage events", async () => {
    const job = { key: "nhentai:111111", input: nhUrl(111111), status: "ready", raw: scrapedFor(111111) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([job]));
    const view = mount();
    expect(probe.ctx.jobs).toHaveLength(1);
    view.rerender(<ScrapeJobsProvider userId="user-b"><Probe /></ScrapeJobsProvider>);
    expect(probe.ctx.jobs).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: JSON.stringify([job]) }));
    });
    expect(probe.ctx.jobs).toEqual([]);
    expect(localStorage.getItem("nhdb.scrapeJobs.v3:user-b")).toBe("[]");
  });
});
