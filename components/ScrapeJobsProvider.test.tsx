// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrapeJobsProvider, useScrapeJobs } from "./ScrapeJobsProvider";

// Server actions go through the network in the real app — stub the module.
vi.mock("../app/actions", () => ({
  findExistingTitlesAction: vi.fn(async () => []),
  commitScrapedAction: vi.fn(async (raw: { hashtag: number }) => ({ hashtag: raw.hashtag })),
}));
import { commitScrapedAction, findExistingTitlesAction } from "../app/actions";

const scrapedFor = (hashtag: number) => ({
  hashtag,
  title_name: `t${hashtag}`,
  image_link: "x",
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
    p.respond({ ok: true, status: 200, json: async () => ({ scraped: scrapedFor(parseInt(p.input, 10)), via: "impit" }) });
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
const mount = () => render(<ScrapeJobsProvider><Probe /></ScrapeJobsProvider>);

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
    expect(f.pending.map((p) => p.input).sort()).toEqual(["111111", "222222", "333333", "444444", "555555", "666666"]);
  });

  it("folds a success into a ready job under its real key", async () => {
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111"));
    await act(async () => f.ok(f.pending[0]));
    await waitFor(() => {
      expect(probe.ctx.jobs).toEqual([
        expect.objectContaining({ key: "#111111", status: "ready", via: "impit" }),
      ]);
      expect(probe.ctx.readyCount).toBe(1);
    });
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
      { hashtag: 111111 } as never,
    ]);
    const f = gatedFetch();
    mount();
    await act(async () => probe.ctx.startScrape("111111 222222"));
    expect(f.pending.map((p) => p.input)).toEqual(["222222"]);
    await waitFor(() =>
      expect(probe.ctx.jobs).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "#111111", status: "duplicate" })]),
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
    await act(async () => probe.ctx.dismiss("#555555"));
    for (const p of [...f.pending]) await act(async () => f.ok(p));
    await waitFor(() => expect(probe.ctx.readyCount).toBe(4));
    expect(f.fn).toHaveBeenCalledTimes(4);
    expect(f.pending.map((p) => p.input)).not.toContain("555555");
  });

  it("resumes a job left scraping in storage from a previous session", async () => {
    localStorage.setItem(
      "nhdb.scrapeJobs.v1",
      JSON.stringify([{ key: "#777777", input: "777777", status: "scraping" }]),
    );
    const f = gatedFetch();
    mount();
    await waitFor(() => expect(f.fn).toHaveBeenCalledTimes(1));
    expect(f.pending[0].input).toBe("777777");
  });

  it("ignores corrupt persisted state instead of crashing", async () => {
    localStorage.setItem("nhdb.scrapeJobs.v1", '{"not":"an array"}');
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
      .mockImplementationOnce(async (raw: { hashtag: number }) => {
        await gate;
        return { hashtag: raw.hashtag } as never;
      })
      .mockImplementationOnce(async (raw: { hashtag: number }) => ({ hashtag: raw.hashtag } as never));

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
      .mockResolvedValueOnce({ hashtag: 111111 } as never)
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
    expect(probe.ctx.jobs).toEqual([expect.objectContaining({ key: "#222222", status: "ready" })]);
  });
});
