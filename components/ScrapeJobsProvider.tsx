"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Item } from "../lib/data";
import type { ScrapeResult, ScrapeVia } from "../lib/scraper";
import { parseInputs } from "../lib/utils";
import { commitScrapedAction, findExistingTitlesAction } from "../app/actions";

export type ScrapeJobStatus = "scraping" | "ready" | "duplicate" | "error";

export interface ScrapeJob {
  // Stable id: `#<hashtag>` once known, else `raw:<input>` until the scrape
  // resolves the hashtag. Used for dedup and React keys.
  key: string;
  input: string;
  status: ScrapeJobStatus;
  item?: Item;
  raw?: ScrapeResult;
  via?: ScrapeVia;
  error?: string;
  /** Transient progress hint shown while retrying (e.g. waking a cold scraper). */
  note?: string;
}

interface ScrapeJobsValue {
  jobs: ScrapeJob[];
  scrapingCount: number;
  readyCount: number;
  /** Parse + dedup an input string, then scrape each entry in the background. */
  startScrape: (rawInput: string) => Promise<void>;
  dismiss: (key: string) => void;
  retry: (key: string) => void;
  /** Commit every "ready" job, drop the saved ones from the store. */
  commitReady: () => Promise<{ saved: Item[]; failedMsg: string | null }>;
}

const ScrapeJobsContext = createContext<ScrapeJobsValue | null>(null);
const storageKeyFor = (userId: string) => `nhdb.scrapeJobs.v2:${userId}`;

// Render's free tier cold-starts (~90s), past Vercel's 60s function budget — so
// the first proxied scrape after idle comes back as a transient 5xx. We can't
// loop inside the function (it dies at 60s), so the client retries: each attempt
// is a fresh sub-60s call, and a retry lands once Render is warm. A 4xx is a
// definitive verdict about the input (bad / not found / auth) and never retries.
const MAX_SCRAPE_ATTEMPTS = 8;
const RETRY_DELAY_MS = 4_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Scrapes run through a bounded pool rather than all at once. Pasting a phone's
// whole tab list queues dozens of entries in one go, and firing them together means dozens of concurrent /api/scrape calls funnelling into a single ngrok tunnel — or, when
// the primary box is asleep, dozens of parallel Playwright launches on the free Render
// fallback, which it does not survive.
const MAX_CONCURRENT_SCRAPES = 4;
const QUEUED_NOTE = "queued…";

// Which side wins when two tabs hold different states for the same job. Both
// tabs apply the same comparison to the same pair, so the merge converges on
// one answer instead of each tab reasserting its own copy forever. A job that
// has reached a terminal state carries data (the scraped payload, the error)
// that a peer still calling it "scraping" simply doesn't have yet.
const STATUS_RANK: Record<ScrapeJobStatus, number> = {
  scraping: 0,
  error: 1,
  duplicate: 2,
  ready: 3,
};

const JOB_STATUSES: readonly ScrapeJobStatus[] = ["scraping", "ready", "duplicate", "error"];

// Persisted state can be anything (truncated write, old schema, "null"…) — only
// accept an array, and only entries that look like jobs, so one corrupt value
// can't blank-screen the whole app on the next render.
function parseStoredJobs(stored: string): ScrapeJob[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((j): j is ScrapeJob =>
    j != null &&
    typeof j === "object" &&
    typeof (j as ScrapeJob).key === "string" &&
    typeof (j as ScrapeJob).input === "string" &&
    JOB_STATUSES.includes((j as ScrapeJob).status),
  );
}

function itemFromScraped(scraped: ScrapeResult): Item {
  const uploadedAt = Math.floor((Date.now() - new Date(scraped.uploaded_at).getTime()) / 86400000);
  return {
    hashtag: scraped.hashtag,
    titleName: scraped.title_name,
    alterName: "",
    imageLink: scraped.image_link,
    pages: scraped.pages,
    tags: scraped.tags.map((t) => t.name),
    artists: scraped.artists.map((a) => a.name),
    groups: scraped.groups.map((g) => g.name),
    characters: scraped.characters.map((c) => c.name),
    parodies: scraped.parodies.map((p) => p.name),
    uploadedAt,
    addedAt: 0,
    readCount: 0,
    lastReadAt: null,
  };
}

// Remount the entire queue when accounts change, including in-flight requests.
export function ScrapeJobsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  return <UserScrapeJobsProvider key={userId} userId={userId}>{children}</UserScrapeJobsProvider>;
}

function UserScrapeJobsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const storageKey = storageKeyFor(userId);
  // Read persisted jobs straight into initial state. This provider only ever
  // mounts client-side (it's gated behind a viewport check that resolves in an
  // effect), so it never takes part in SSR/hydration — reading localStorage in
  // the lazy initializer is safe and avoids the cascading render an effect would
  // cause. Jobs still "scraping" when the tab closed are kept as-is; the resume
  // effect below re-drives them, so a reload (or a tab reopened mid-scrape)
  // doesn't lose in-flight work.
  const [jobs, setJobs] = useState<ScrapeJob[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? parseStoredJobs(stored) : [];
    } catch {
      return [];
    }
  });
  // Keys the pool owns — queued *or* running (including between retries) —
  // mapped to a token unique to that drive. Guards against double-driving the
  // same job from startScrape, retry, and the resume effect below. The token
  // (not mere key presence) is what a running loop checks: after a dismiss +
  // immediate re-add, the re-add owns a fresh token, so the stale loop sees the
  // mismatch and dies without tearing down the new drive's bookkeeping.
  const inFlight = useRef<Map<string, symbol>>(new Map());
  // Waiting entries and the number of runOne loops currently executing.
  const queue = useRef<{ raw: string; key: string; token: symbol }[]>([]);
  const active = useRef(0);
  // Keys adopted from another tab that is alive and already driving them — this
  // tab displays them but must not fetch them too. Cleared when we take
  // ownership (enqueue) or drop the job (dismiss).
  const foreign = useRef<Set<string>>(new Set());
  // Latest jobs, readable synchronously (startScrape decides what to scrape
  // outside the setJobs updater, so updaters stay pure).
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  // Aborted on unmount so the retry loop stops issuing fetches for a provider
  // that no longer exists (e.g. viewport flip remounts the tree).
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    return () => ac.abort();
  }, []);

  // Mirror jobs back to storage. Skipping the write when storage already holds
  // this exact value matters for the cross-tab merge below: a tab that just
  // adopted another tab's list would otherwise echo it straight back, and the
  // two would bounce storage events off each other.
  useEffect(() => {
    try {
      const next = JSON.stringify(jobs);
      if (localStorage.getItem(storageKey) !== next) localStorage.setItem(storageKey, next);
    } catch {}
  }, [jobs, storageKey]);

  // Cross-tab sync. Two tabs each mirroring their own array into one key means
  // the last writer wipes the other's queue, so every tab folds in the other's
  // list as it lands and they never diverge far enough to clobber. The merge
  // is deliberately SYMMETRIC — the more advanced status wins, ties go to the
  // remote — because a "mine always wins" rule makes two tabs overwrite each
  // other forever. A job only this tab knows about survives while we drive it;
  // otherwise its absence is read as "the other tab dismissed it".
  //
  // Not covered: a tab opened or reloaded while another is mid-scrape adopts
  // those jobs at mount and drives them too, so one title may be fetched twice.
  // Harmless — the scrape doesn't persist, and the commit is an idempotent upsert.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey || e.newValue == null) return;
      let remote: ScrapeJob[];
      try {
        remote = parseStoredJobs(e.newValue);
      } catch {
        return; // corrupt write from another tab — keep what we have
      }
      setJobs((prev) => {
        const mineByKey = new Map(prev.map((j) => [j.key, j]));
        const merged: ScrapeJob[] = [];
        for (const r of remote) {
          const mine = mineByKey.get(r.key);
          const keepMine = mine != null && STATUS_RANK[mine.status] > STATUS_RANK[r.status];
          merged.push(keepMine ? mine : r);
          // Someone else is driving what they still call "scraping" — show it,
          // but leave the fetching to them.
          if (!keepMine && r.status === "scraping" && !inFlight.current.has(r.key)) {
            foreign.current.add(r.key);
          }
        }
        const seen = new Set(remote.map((r) => r.key));
        for (const j of prev) {
          if (!seen.has(j.key) && inFlight.current.has(j.key)) merged.push(j);
        }
        return merged;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const dismiss = useCallback((key: string) => {
    inFlight.current.delete(key);
    foreign.current.delete(key);
    setJobs((prev) => prev.filter((j) => j.key !== key));
  }, []);

  // Mark a job as failed. Also used when runOne itself throws: leaving the job
  // "scraping" while the pool forgets the key would let the resume effect below
  // re-enqueue it forever.
  const failJob = useCallback((key: string, error: string) => {
    setJobs((prev) =>
      prev.map((j) => (j.key === key ? { ...j, status: "error", error, note: undefined } : j)),
    );
  }, []);

  // Run one scrape and fold the result back into the matching job. Retries
  // transient failures (cold scraper / network) on its own; a failure only lands
  // on the job as status "error" once the attempt budget is spent or the verdict
  // is definitive. The pool awaits it only to learn when the slot frees up.
  const runOne = useCallback(async (raw: string, placeholderKey: string, token: symbol): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_SCRAPE_ATTEMPTS; attempt++) {
      // Dismissed mid-flight (dismiss() drops the key) or superseded by a
      // newer drive for the same key — stop retrying.
      if (inFlight.current.get(placeholderKey) !== token) return;
      // Provider unmounted — stop the loop instead of fetching into the void.
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return;

      let res: Response | null = null;
      try {
        res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: raw, persist: false }),
          signal,
        });
      } catch {
        if (signal?.aborted) return;
        // Network error — transient; fall through to the retry path below.
      }

      if (res?.ok) {
        // Re-check ownership after the await: a dismiss that landed while the
        // response was in flight must win over the stale result.
        if (inFlight.current.get(placeholderKey) !== token) return;
        const { scraped, via } = (await res.json()) as { scraped: ScrapeResult; via?: ScrapeVia };
        const realKey = `#${scraped.hashtag}`;
        const item = itemFromScraped(scraped);
        setJobs((prev) => {
          // If the placeholder was dismissed mid-flight, drop the result.
          if (!prev.some((j) => j.key === placeholderKey)) return prev;
          const without = prev.filter((j) => j.key !== placeholderKey && j.key !== realKey);
          return [...without, { key: realKey, input: raw, status: "ready", item, raw: scraped, via }];
        });
        return;
      }

      // 4xx = definitive verdict about the input (bad / not found / auth);
      // anything else (5xx, network error) is transient — retry until spent.
      let message = "scraper unreachable";
      let definitive = false;
      if (res) {
        definitive = res.status >= 400 && res.status < 500;
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        message = body?.error ?? res.statusText;
      }

      if (definitive || attempt >= MAX_SCRAPE_ATTEMPTS) {
        failJob(placeholderKey, definitive ? message : "scraper didn't respond — retry");
        return;
      }

      // Transient — show a gentle progress hint and back off before retrying.
      setJobs((prev) =>
        prev.map((j) => (j.key === placeholderKey ? { ...j, note: `waking scraper… (try ${attempt + 1})` } : j)),
      );
      await delay(RETRY_DELAY_MS);
      if (abortRef.current?.signal.aborted) return;
    }
  }, [failJob]);

  // Start queued work up to the concurrency cap. Called on every enqueue and
  // again whenever a slot frees, so it is the only place runOne is invoked.
  // Reached through a ref because it re-enters itself from that completion
  // callback.
  const pumpRef = useRef<() => void>(() => {});
  const pump = useCallback(() => {
    while (active.current < MAX_CONCURRENT_SCRAPES) {
      const next = queue.current.shift();
      if (!next) return;
      // Dismissed while it sat in the queue (dismiss() drops the key) or
      // superseded by a re-add that owns a newer token — skip the stale entry.
      if (inFlight.current.get(next.key) !== next.token) continue;
      active.current++;
      // Only rewrite state if this job actually shows the queued hint; a plain
      // .map() here would rerender the whole list once per started scrape.
      setJobs((prev) =>
        prev.some((j) => j.key === next.key && j.note === QUEUED_NOTE)
          ? prev.map((j) => (j.key === next.key ? { ...j, note: undefined } : j))
          : prev,
      );
      void runOne(next.raw, next.key, next.token)
        .catch(() => failJob(next.key, "scrape failed"))
        .finally(() => {
          active.current--;
          // Release only our own token — a re-add's fresh drive must survive.
          if (inFlight.current.get(next.key) === next.token) inFlight.current.delete(next.key);
          pumpRef.current();
          // A drive can end without a terminal status: the abort path (StrictMode
          // remounts the provider, aborting controller #1 while the resume effect
          // has already re-run against the still-populated inFlight map). Poke the
          // state only if the job is still "scraping" with no driver — the updater
          // sees the LATEST jobs, so a normally-completed job never re-renders —
          // and the identity change re-runs the resume effect, which re-enqueues.
          setJobs((prev) =>
            prev.some((j) => j.key === next.key && j.status === "scraping" && !inFlight.current.has(j.key))
              ? [...prev]
              : prev,
          );
        });
    }
  }, [runOne, failJob]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // Hand a job to the pool. inFlight covers queued *and* running work, so the
  // same key can't be driven twice by startScrape, retry and the resume effect.
  const enqueue = useCallback((raw: string, key: string) => {
    if (inFlight.current.has(key)) return;
    // Taking ownership — from here we drive it, whoever queued it originally.
    foreign.current.delete(key);
    const token = Symbol(key);
    inFlight.current.set(key, token);
    queue.current.push({ raw, key, token });
    // Say "queued" rather than "scraping" for entries that must wait — with a
    // 40-link paste most of the list is waiting, not working.
    if (active.current + queue.current.length > MAX_CONCURRENT_SCRAPES) {
      setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, note: QUEUED_NOTE } : j)));
    }
    pumpRef.current();
  }, []);

  // Resume any job left "scraping" that isn't already being driven — e.g. one
  // loaded from storage after a reload, or a tab reopened mid-scrape. The
  // inFlight guard makes this safe to run on every jobs change.
  useEffect(() => {
    for (const j of jobs) {
      if (j.status === "scraping" && !inFlight.current.has(j.key) && !foreign.current.has(j.key)) {
        enqueue(j.input, j.key);
      }
    }
  }, [jobs, enqueue]);

  const startScrape = useCallback(
    async (rawInput: string) => {
      // parseInputs handles the messy end of the input space (a pasted dump of
      // every open tab, titles and all) and returns deduped ids in paste order.
      const ids = parseInputs(rawInput);
      if (ids.length === 0) return;

      let existingByTag = new Map<number, Item>();
      try {
        const existing = await findExistingTitlesAction(ids);
        existingByTag = new Map(existing.map((i) => [i.hashtag, i]));
      } catch {}

      // Decide what each input becomes BEFORE touching state, against the
      // latest jobs snapshot — the setJobs updater below stays pure (updaters
      // may be dropped or double-invoked, so side effects there are unreliable).
      const currentByKey = new Map(jobsRef.current.map((j) => [j.key, j]));
      const upserts: ScrapeJob[] = [];
      const toScrape: { raw: string; key: string }[] = [];
      for (const id of ids) {
        const key = `#${id}`;
        const input = String(id);

        const known = existingByTag.get(id);
        if (known) {
          upserts.push({ key, input, status: "duplicate", item: known });
          continue;
        }

        // Don't re-scrape something already in flight or already fetched.
        const current = currentByKey.get(key);
        if (current && (current.status === "scraping" || current.status === "ready")) continue;

        upserts.push({ key, input, status: "scraping" });
        toScrape.push({ raw: input, key });
      }

      if (upserts.length > 0) {
        setJobs((prev) => {
          const next = [...prev];
          for (const job of upserts) {
            const idx = next.findIndex((j) => j.key === job.key);
            // The decision above used a snapshot — never downgrade a job that
            // has since started scraping or come back ready to a fresh placeholder.
            if (idx >= 0 && job.status === "scraping" &&
                (next[idx].status === "scraping" || next[idx].status === "ready")) continue;
            if (idx >= 0) next[idx] = job;
            else next.push(job);
          }
          return next;
        });
      }

      // Fire and forget — the pool drains these on its own schedule, so the
      // caller (and the modal) can move on / close. enqueue's inFlight guard
      // makes a duplicate kickoff for an already-driven key a no-op.
      for (const { raw, key } of toScrape) enqueue(raw, key);
    },
    [enqueue],
  );

  const retry = useCallback(
    (key: string) => {
      const job = jobs.find((j) => j.key === key);
      if (!job) return;
      setJobs((prev) =>
        prev.map((j) => (j.key === key ? { ...j, status: "scraping", error: undefined, note: undefined } : j)),
      );
      enqueue(job.input, key);
    },
    [jobs, enqueue],
  );

  const commitReady = useCallback(async () => {
    const ready = jobs.filter((j) => j.status === "ready" && j.raw);
    if (ready.length === 0) return { saved: [] as Item[], failedMsg: null };

    // Commits run one at a time ON PURPOSE. The DB stat triggers (migration
    // 3_avg_tag_value) recompute tags.title_count with COUNT(*) — a
    // READ-COMMITTED recompute, so concurrent transactions touching the same
    // tag can overwrite each other's counts. This client is the only writer,
    // which makes serializing here a complete fix; a 40-title batch trades a
    // few extra seconds of "saving…" for counts that stay correct.
    const saved: Item[] = [];
    const failed: Error[] = [];
    for (const j of ready) {
      try {
        saved.push(await commitScrapedAction(j.raw!));
      } catch (e) {
        failed.push(new Error(`#${j.item?.hashtag ?? j.input}: ${e instanceof Error ? e.message : "save failed"}`));
      }
    }
    const savedTags = new Set(saved.map((s) => s.hashtag));

    // Saving clears the whole review list (duplicates and errors included), not
    // just the rows that were added. Two things stay: scrapes still in flight,
    // and "ready" rows whose commit failed (so their data isn't lost on a retry).
    setJobs((prev) =>
      prev.filter(
        (j) => j.status === "scraping" || (j.status === "ready" && j.item != null && !savedTags.has(j.item.hashtag)),
      ),
    );

    return {
      saved,
      failedMsg: failed.length ? failed.map((f) => f.message).join(" · ") : null,
    };
  }, [jobs]);

  const scrapingCount = jobs.filter((j) => j.status === "scraping").length;
  const readyCount = jobs.filter((j) => j.status === "ready").length;

  return (
    <ScrapeJobsContext.Provider value={{ jobs, scrapingCount, readyCount, startScrape, dismiss, retry, commitReady }}>
      {children}
    </ScrapeJobsContext.Provider>
  );
}

export function useScrapeJobs() {
  const ctx = useContext(ScrapeJobsContext);
  if (!ctx) throw new Error("useScrapeJobs must be used within ScrapeJobsProvider");
  return ctx;
}
