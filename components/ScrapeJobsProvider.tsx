"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Item } from "../lib/data";
import type { ScrapeResult, ScrapeVia } from "../lib/scraper";
import { extractHashtag } from "../lib/utils";
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
const STORAGE_KEY = "nhdb.scrapeJobs.v1";

// Render's free tier cold-starts (~90s), past Vercel's 60s function budget — so
// the first proxied scrape after idle comes back as a transient 5xx. We can't
// loop inside the function (it dies at 60s), so the client retries: each attempt
// is a fresh sub-60s call, and a retry lands once Render is warm. A 4xx is a
// definitive verdict about the input (bad / not found / auth) and never retries.
const MAX_SCRAPE_ATTEMPTS = 8;
const RETRY_DELAY_MS = 4_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export function ScrapeJobsProvider({ children }: { children: ReactNode }) {
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
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? parseStoredJobs(stored) : [];
    } catch {
      return [];
    }
  });
  // Keys with a runOne loop currently in flight (including between retries).
  // Guards against double-driving the same job from startScrape, retry, and the
  // resume effect below.
  const inFlight = useRef<Set<string>>(new Set());
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

  // Mirror jobs back to storage. The first run rewrites the just-loaded value
  // (a harmless no-op), so no hydration guard is needed.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    } catch {}
  }, [jobs]);

  const dismiss = useCallback((key: string) => {
    inFlight.current.delete(key);
    setJobs((prev) => prev.filter((j) => j.key !== key));
  }, []);

  // Run one scrape and fold the result back into the matching job. Retries
  // transient failures (cold scraper / network) on its own; a failure only lands
  // on the job as status "error" once the attempt budget is spent or the verdict
  // is definitive. Returns nothing — never throws.
  const runOne = useCallback((raw: string, placeholderKey: string) => {
    if (inFlight.current.has(placeholderKey)) return;
    inFlight.current.add(placeholderKey);

    void (async () => {
      try {
        for (let attempt = 1; attempt <= MAX_SCRAPE_ATTEMPTS; attempt++) {
          // Dismissed mid-flight (dismiss() drops the key) — stop retrying.
          if (!inFlight.current.has(placeholderKey)) return;
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
            const finalMsg = definitive ? message : "scraper didn't respond — retry";
            setJobs((prev) =>
              prev.map((j) =>
                j.key === placeholderKey ? { ...j, status: "error", error: finalMsg, note: undefined } : j,
              ),
            );
            return;
          }

          // Transient — show a gentle progress hint and back off before retrying.
          setJobs((prev) =>
            prev.map((j) => (j.key === placeholderKey ? { ...j, note: `waking scraper… (try ${attempt + 1})` } : j)),
          );
          await delay(RETRY_DELAY_MS);
          if (abortRef.current?.signal.aborted) return;
        }
      } finally {
        inFlight.current.delete(placeholderKey);
      }
    })();
  }, []);

  // Resume any job left "scraping" that isn't already being driven — e.g. one
  // loaded from storage after a reload, or a tab reopened mid-scrape. The
  // inFlight guard makes this safe to run on every jobs change.
  useEffect(() => {
    for (const j of jobs) {
      if (j.status === "scraping" && !inFlight.current.has(j.key)) runOne(j.input, j.key);
    }
  }, [jobs, runOne]);

  const startScrape = useCallback(
    async (rawInput: string) => {
      const inputs = rawInput
        .split(/[, \n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (inputs.length === 0) return;

      const parsed = inputs.map((raw) => ({ raw, hashtag: extractHashtag(raw) }));
      const hashtags = [...new Set(parsed.map((p) => p.hashtag).filter((h): h is number => h != null))];
      let existingByTag = new Map<number, Item>();
      try {
        const existing = hashtags.length > 0 ? await findExistingTitlesAction(hashtags) : [];
        existingByTag = new Map(existing.map((i) => [i.hashtag, i]));
      } catch {}

      const keyOf = (p: { raw: string; hashtag: number | null }) =>
        p.hashtag != null ? `#${p.hashtag}` : `raw:${p.raw}`;

      // Decide what each input becomes BEFORE touching state, against the
      // latest jobs snapshot — the setJobs updater below stays pure (updaters
      // may be dropped or double-invoked, so side effects there are unreliable).
      const currentByKey = new Map(jobsRef.current.map((j) => [j.key, j]));
      const upserts: ScrapeJob[] = [];
      const toScrape: { raw: string; key: string }[] = [];
      const seen = new Set<string>();
      for (const p of parsed) {
        const key = keyOf(p);
        if (seen.has(key)) continue;
        seen.add(key);

        const known = p.hashtag != null ? existingByTag.get(p.hashtag) : undefined;
        if (known) {
          upserts.push({ key, input: p.raw, status: "duplicate", item: known });
          continue;
        }

        // Don't re-scrape something already in flight or already fetched.
        const current = currentByKey.get(key);
        if (current && (current.status === "scraping" || current.status === "ready")) continue;

        upserts.push({ key, input: p.raw, status: "scraping" });
        toScrape.push({ raw: p.raw, key });
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

      // Fire and forget — these resolve into the store on their own schedule,
      // so the caller (and the modal) can move on / close. runOne's inFlight
      // guard makes a duplicate kickoff for an already-driven key a no-op.
      for (const { raw, key } of toScrape) runOne(raw, key);
    },
    [runOne],
  );

  const retry = useCallback(
    (key: string) => {
      const job = jobs.find((j) => j.key === key);
      if (!job) return;
      setJobs((prev) =>
        prev.map((j) => (j.key === key ? { ...j, status: "scraping", error: undefined, note: undefined } : j)),
      );
      runOne(job.input, key);
    },
    [jobs, runOne],
  );

  const commitReady = useCallback(async () => {
    const ready = jobs.filter((j) => j.status === "ready" && j.raw);
    if (ready.length === 0) return { saved: [] as Item[], failedMsg: null };

    const results = await Promise.allSettled(
      ready.map(async (j) => {
        try {
          return await commitScrapedAction(j.raw!);
        } catch (e) {
          throw new Error(`#${j.item?.hashtag ?? j.input}: ${e instanceof Error ? e.message : "save failed"}`);
        }
      }),
    );
    const saved = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
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
      failedMsg: failed.length
        ? failed.map((f) => (f.reason instanceof Error ? f.reason.message : "save failed")).join(" · ")
        : null,
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
