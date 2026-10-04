// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrapeJobsProvider, useScrapeJobs, type ScrapeJob } from "./ScrapeJobsProvider";

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
  return { hashtag, source: "nhentai", sourceId: String(hashtag) } as never;
}

const scrapedFor = (hashtag: number) => ({
  source: "nhentai" as const,
  source_id: String(hashtag),
  title_name: `t${hashtag}`,
  image_link: "",
  pages: 10,
  uploaded_at: "2024-01-01",
  tags: [],
  artists: [],
  groups: [],
  characters: [],
  parodies: [],
});

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
  const ok = (p: { respond: (r: unknown) => void; input: string }) =>
    p.respond({ ok: true, status: 200, json: async () => ({ scraped: scrapedFor(parseInt(p.input.split(":")[1], 10)), via: "impit" }) });
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
    expect(f.pending.map((p) => p.input).sort()).toEqual(
      ["111111", "222222", "333333", "444444", "555555", "666666"].map((id) => `nhentai:${id}`),
    );
  });

  it("folds a success into a ready job under its real key", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => {
      expect(probe.ctx.jobs).toEqual([
        expect.objectContaining({ key: "nhentai:111111", status: "ready", via: "impit" }),
      ]);
      expect(probe.ctx.readyCount).toBe(1);
    });
  });

  it("queues titles from any supported site and drops everything else", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape(`https://hitomi.la/reader/1234567.html#2
      https://hentaifox.com/search/?q=quill+mfnd
      https://e-hentai.org/g/899557/edd545586a/ https://example.com/whatever 111111`));
    expect(findExistingTitlesAction).toHaveBeenCalledWith(["hitomi:1234567", "ehentai:899557/edd545586a", "nhentai:111111"]);
    expect(f.pending.map((p) => p.input)).toEqual(["hitomi:1234567", "ehentai:899557/edd545586a", "nhentai:111111"]);
  });

  it("clears another site's preview once it is saved, though it had no key before", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("hitomi:1234567"));
    await act(async () => f.pending[0].respond({
      ok: true,
      status: 200,
      json: async () => ({ scraped: { ...scrapedFor(1), source: "hitomi", source_id: "1234567" }, via: "impit" }),
    }));
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
    await act(async () => probe.ctx.startScrape("111111, nhentai.net/g/111111"));
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
    expect(f.pending.map((p) => p.input)).toEqual(["nhentai:222222"]);
    await waitFor(() =>
      expect(probe.ctx.jobs).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "nhentai:111111", status: "duplicate" })]),
      ),
    );
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
    expect(f.pending.map((p) => p.input)).not.toContain("nhentai:555555");
  });

  it("resumes a job left scraping in storage from a previous session", async () => {
    localStorage.setItem(
      "nhdb.scrapeJobs.v3:user-a",
      JSON.stringify([{ key: "nhentai:777777", input: "nhentai:777777", status: "scraping" }]),
    );
    const f = gatedFetch();
    mount();
    await waitFor(() => expect(f.fn).toHaveBeenCalledTimes(1));
    expect(f.pending[0].input).toBe("nhentai:777777");
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
          input: "nhentai:888888",
          status: "ready",
          item: { hashtag: 888888, source: "nhentai", sourceId: "888888", titleName: "t888888", tags: [], artists: [] },
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
        { key: "nhentai:111111", input: "nhentai:111111", status: "ready" },
        { key: "nhentai:222222", input: "nhentai:222222", status: "scraping" },
      ]);
    });
    expect(probe.ctx.jobs.map((j) => j.key).sort()).toEqual(["nhentai:111111", "nhentai:222222"]);
  });

  it("does not fetch a job the peer is already driving", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: "nhentai:222222", status: "scraping" }]);
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
      peerWrites([{ key: "nhentai:111111", input: "nhentai:111111", status: "scraping" }]);
    });
    // The scraped payload survives — losing it would strand an unsavable job.
    expect(probe.ctx.jobs[0].status).toBe("ready");
    expect(probe.ctx.jobs[0].raw).toEqual(readyJob.raw);
  });

  it("takes a peer's terminal status over its own 'scraping' (symmetric rule)", async () => {
    gatedFetch();
    mount();
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: "nhentai:222222", status: "scraping" }]);
    });
    await act(async () => {
      peerWrites([{ key: "nhentai:222222", input: "nhentai:222222", status: "error", error: "not found" }]);
    });
    expect(probe.ctx.jobs[0]).toMatchObject({ status: "error", error: "not found" });
  });

  it("propagates a peer's dismissal of a job this tab is not driving", async () => {
    gatedFetch();
    mount();
    await act(async () => {
      peerWrites([
        { key: "nhentai:111111", input: "nhentai:111111", status: "ready" },
        { key: "nhentai:222222", input: "nhentai:222222", status: "ready" },
      ]);
    });
    expect(probe.ctx.jobs).toHaveLength(2);
    await act(async () => {
      peerWrites([{ key: "nhentai:111111", input: "nhentai:111111", status: "ready" }]);
    });
    expect(probe.ctx.jobs.map((j) => j.key)).toEqual(["nhentai:111111"]);
  });

  it("keeps its own in-flight job the peer has never heard of", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => {
      peerWrites([{ key: "nhentai:999999", input: "nhentai:999999", status: "ready" }]);
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
    const remote: Partial<ScrapeJob>[] = [{ key: "nhentai:222222", input: "nhentai:222222", status: "ready" }];
    await act(async () => peerWrites(remote));
    // Byte-identical to what the peer wrote: no write-back, so no event storm.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(remote));
  });
});


describe("account isolation", () => {
  it("never restores the legacy queue or another account's queue", () => {
    const job = { key: "nhentai:111111", input: "nhentai:111111", status: "ready", raw: scrapedFor(111111) };
    localStorage.setItem("nhdb.scrapeJobs.v1", JSON.stringify([job]));
    localStorage.setItem("nhdb.scrapeJobs.v3:user-b", JSON.stringify([job]));
    mount();
    expect(probe.ctx.jobs).toEqual([]);
  });

  it("resets jobs when the account changes and ignores foreign storage events", async () => {
    const job = { key: "nhentai:111111", input: "nhentai:111111", status: "ready", raw: scrapedFor(111111) };
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
