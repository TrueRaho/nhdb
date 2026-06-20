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
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const hydrated = useRef(false);

  // Hydrate once on the client. A scrape that was still in flight when the tab
  // closed/reloaded can't be resumed (the fetch is gone), so mark it errored.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ScrapeJob[];
        setJobs(
          parsed.map((j) =>
            j.status === "scraping" ? { ...j, status: "error", error: "scrape interrupted — retry" } : j,
          ),
        );
      }
    } catch {}
    hydrated.current = true;
  }, []);

  // Persist after hydration so the initial empty state doesn't clobber storage.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    } catch {}
  }, [jobs]);

  const dismiss = useCallback((key: string) => {
    setJobs((prev) => prev.filter((j) => j.key !== key));
  }, []);

  // Run one scrape and fold the result back into the matching job. Returns
  // nothing — failures land on the job as status "error", not as throws.
  const runOne = useCallback((raw: string, placeholderKey: string) => {
    void (async () => {
      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: raw, persist: false }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error ?? res.statusText);
        }
        const { scraped, via } = (await res.json()) as { scraped: ScrapeResult; via?: ScrapeVia };
        const realKey = `#${scraped.hashtag}`;
        const item = itemFromScraped(scraped);
        setJobs((prev) => {
          // If the placeholder was dismissed mid-flight, drop the result.
          if (!prev.some((j) => j.key === placeholderKey)) return prev;
          const without = prev.filter((j) => j.key !== placeholderKey && j.key !== realKey);
          return [...without, { key: realKey, input: raw, status: "ready", item, raw: scraped, via }];
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "scrape failed";
        setJobs((prev) => prev.map((j) => (j.key === placeholderKey ? { ...j, status: "error", error: message } : j)));
      }
    })();
  }, []);

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

      const toScrape: { raw: string; key: string }[] = [];
      setJobs((prev) => {
        const next = [...prev];
        const seen = new Set<string>();
        const replaceOrPush = (job: ScrapeJob) => {
          const idx = next.findIndex((j) => j.key === job.key);
          if (idx >= 0) next[idx] = job;
          else next.push(job);
        };
        for (const p of parsed) {
          const key = keyOf(p);
          if (seen.has(key)) continue;
          seen.add(key);

          const known = p.hashtag != null ? existingByTag.get(p.hashtag) : undefined;
          if (known) {
            replaceOrPush({ key, input: p.raw, status: "duplicate", item: known });
            continue;
          }

          // Don't re-scrape something already in flight or already fetched.
          const current = next.find((j) => j.key === key);
          if (current && (current.status === "scraping" || current.status === "ready")) continue;

          replaceOrPush({ key, input: p.raw, status: "scraping" });
          toScrape.push({ raw: p.raw, key });
        }
        return next;
      });

      // Fire and forget — these resolve into the store on their own schedule,
      // so the caller (and the modal) can move on / close.
      for (const { raw, key } of toScrape) runOne(raw, key);
    },
    [runOne],
  );

  const retry = useCallback(
    (key: string) => {
      const job = jobs.find((j) => j.key === key);
      if (!job) return;
      setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, status: "scraping", error: undefined } : j)));
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
