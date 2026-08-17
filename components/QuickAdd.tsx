"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Database, RotateCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NhCover } from "./Primitives";
import type { Item } from "../lib/data";
import type { ScrapeResult, ScrapeVia } from "../lib/scraper";
import { commitScrapedAction, findExistingTitlesAction, updateAlterNameAction } from "../app/actions";

// Deliberately standalone: this route exists to open in under a second from a
// share-sheet shortcut, so it pulls in NOTHING from the main app — no
// ScrapeJobsProvider, no gallery, no dataset, no filter state. Only the cover
// primitive and the three server actions it actually calls.

// Same retry budget as the batch pool, and for the same reason: the Render
// fallback cold-starts past Vercel's function timeout, so the first scrape
// after an idle period comes back as a transient 5xx. Reimplemented here in a
// dozen lines rather than shared, because this flow has no queue, no
// persistence and exactly one job — importing the pool would defeat the point
// of the route.
const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 4_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Phase =
  | { k: "loading"; note: string }
  | { k: "scraped"; item: Item; raw: ScrapeResult; via?: ScrapeVia }
  | { k: "existing"; item: Item }
  | { k: "saved"; item: Item }
  | { k: "error"; message: string };

function itemFromScraped(s: ScrapeResult): Item {
  return {
    hashtag: s.hashtag,
    titleName: s.title_name,
    alterName: "",
    imageLink: s.image_link,
    pages: s.pages,
    tags: s.tags.map((t) => t.name),
    artists: s.artists.map((a) => a.name),
    groups: s.groups.map((g) => g.name),
    characters: s.characters.map((c) => c.name),
    parodies: s.parodies.map((p) => p.name),
    uploadedAt: Math.floor((Date.now() - new Date(s.uploaded_at).getTime()) / 86400000),
    addedAt: 0,
    readCount: 0,
    lastReadAt: null,
  };
}

export function QuickAdd({ hashtag }: { hashtag: number }) {
  const [phase, setPhase] = useState<Phase>({ k: "loading", note: "checking collection…" });
  // Always starts empty and is only ever written by the user — nothing here
  // prefills it, not even the name a known title already carries. An empty
  // field therefore means "leave the stored name alone", never "clear it".
  const [alterName, setAlterName] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();

    void (async () => {
      // Check the collection first: a title that is already saved must not hit
      // the scraper at all (this is what getTitlesByHashtags stays uncached
      // for), and the ~100ms costs nothing against a scrape.
      try {
        const [known] = await findExistingTitlesAction([hashtag]);
        if (ac.signal.aborted) return;
        if (known) {
          setPhase({ k: "existing", item: known });
          return;
        }
      } catch {
        // Collection unreachable — fall through and try to scrape anyway.
      }

      for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        if (ac.signal.aborted) return;
        setPhase({ k: "loading", note: n === 1 ? "scraping…" : `waking scraper… (try ${n})` });

        let res: Response | null = null;
        try {
          res = await fetch("/api/scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: String(hashtag), persist: false }),
            signal: ac.signal,
          });
        } catch {
          if (ac.signal.aborted) return;
        }

        if (res?.ok) {
          const { scraped, via } = (await res.json()) as { scraped: ScrapeResult; via?: ScrapeVia };
          if (ac.signal.aborted) return;
          setPhase({ k: "scraped", item: itemFromScraped(scraped), raw: scraped, via });
          return;
        }

        // 4xx is a verdict about this id (not found / bad input) — never retried.
        let message = "scraper unreachable";
        let definitive = false;
        if (res) {
          definitive = res.status >= 400 && res.status < 500;
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          message = body?.error ?? res.statusText;
        }
        if (definitive || n === MAX_ATTEMPTS) {
          setPhase({ k: "error", message: definitive ? message : "scraper didn't respond" });
          return;
        }
        await delay(RETRY_DELAY_MS);
      }
    })();

    return () => ac.abort();
  }, [hashtag, attempt]);

  const typedName = alterName.trim();

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (phase.k === "scraped") {
        const item = await commitScrapedAction(phase.raw, typedName);
        setPhase({ k: "saved", item });
      } else if (phase.k === "existing") {
        // Only write when the user actually typed something. Sending the empty
        // field would wipe the name the title already has — the one thing this
        // screen must never do behind the user's back.
        if (!typedName) return;
        await updateAlterNameAction(hashtag, typedName);
        setPhase({ k: "saved", item: { ...phase.item, alterName: typedName } });
      }
    } catch (e) {
      setPhase({ k: "error", message: e instanceof Error ? e.message : "save failed" });
    } finally {
      setSaving(false);
    }
  };

  const item = phase.k === "loading" || phase.k === "error" ? null : phase.item;
  // A known title with an untouched field has nothing to save; a new one is
  // always addable, with or without a name.
  const canSave = phase.k === "scraped" || (phase.k === "existing" && typedName !== "");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4">
      <header className="flex items-baseline gap-2">
        <span className="font-display text-[17px] font-bold tracking-tight text-nh-text-1">quick add</span>
        <span className="font-mono text-[11px] text-nh-accent">#{hashtag}</span>
        <span className="flex-1" />
        {phase.k === "scraped" && phase.via === "fallback" && (
          <span
            className="inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 font-mono text-[8.5px] uppercase tracking-wider"
            style={{ background: "rgba(224,162,58,0.12)", color: "#e0a23a" }}
            title="impit was blocked — scraped via the browser fallback"
          >
            <Zap className="size-2" strokeWidth={2.4} /> fallback
          </span>
        )}
      </header>

      <div className="flex gap-3">
        <div className="w-28 shrink-0">
          {item ? (
            <NhCover item={item} size="card" />
          ) : (
            <div className="aspect-[350/500] w-full animate-pulse rounded-[var(--nh-radius-card)] bg-nh-pill" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {phase.k === "loading" && (
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-nh-text-2">
              <span className="nh-dot-pulse" /> {phase.note}
            </div>
          )}
          {phase.k === "error" && (
            <div className="flex flex-col items-start gap-2">
              <div className="font-mono text-[11px] text-[#ff6b6b]">{phase.message}</div>
              <Button
                variant="ghost"
                onClick={() => setAttempt((a) => a + 1)}
                className="h-7 gap-1 rounded-md bg-nh-pill px-2 font-mono text-[11px] text-nh-text-2"
              >
                <RotateCw className="size-3" strokeWidth={2.2} /> retry
              </Button>
            </div>
          )}
          {item && (
            <>
              <div
                className="font-display text-[15px] font-bold leading-tight text-nh-text-1"
                style={{ letterSpacing: "-0.01em" }}
              >
                {item.titleName}
              </div>
              <div className="font-mono text-[10px] text-nh-text-3">
                {item.artists[0] ?? "unknown"} · {item.pages}p · {item.tags.length} tags
              </div>
              {phase.k === "existing" && (
                <div className="flex items-center gap-1 font-mono text-[10px] text-nh-text-3">
                  <Database className="size-3" strokeWidth={2} />
                  already in collection · read {item.readCount}×
                </div>
              )}
              <div className="mt-0.5 flex flex-wrap gap-0.75">
                {item.tags.slice(0, 6).map((t) => (
                  <Badge
                    key={t}
                    variant="secondary"
                    className="h-auto rounded-sm border-0 bg-nh-pill px-1.5 py-0.5 font-mono text-[9px] text-nh-text-3"
                  >
                    {t}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-1.5">
        <label
          htmlFor="alter-name"
          className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3"
        >
          alternative name · optional
        </label>
        <Input
          id="alter-name"
          value={alterName}
          onChange={(e) => setAlterName(e.target.value)}
          // The name a known title already carries shows as the PLACEHOLDER, not
          // as a value: the user can see what is set without the field quietly
          // resubmitting it, and grey-on-empty reads as "type to change".
          placeholder={item?.alterName || item?.titleName || "your own title"}
          autoComplete="off"
          disabled={phase.k === "saved"}
          className="h-11 rounded-lg border-nh-border bg-nh-input px-3 font-mono text-sm text-nh-text-1"
        />
      </div>

      {phase.k === "saved" ? (
        <div className="flex flex-col gap-2">
          <div
            className="flex items-center justify-center gap-1.5 rounded-lg py-3 font-display text-[13px] font-bold"
            style={{ background: "rgba(90,200,120,0.10)", color: "#5ac878" }}
          >
            <Check className="size-4" strokeWidth={2.6} />
            {phase.item.alterName ? `saved as "${phase.item.alterName}"` : "saved to collection"}
          </div>
          {/* prefetch={false} on purpose: the default would pull the whole
              gallery bundle down in the background, which is exactly the cost
              this route exists to avoid. Tapping it is a deliberate exit. */}
          <Link
            href="/"
            prefetch={false}
            className="text-center font-mono text-[11px] text-nh-text-3 underline underline-offset-2"
          >
            open the library
          </Link>
        </div>
      ) : (
        <Button
          onClick={onSave}
          disabled={saving || !canSave}
          className="h-12 w-full gap-1.5 rounded-lg bg-nh-accent font-display text-[13px] font-extrabold text-[#0a0a0a] disabled:opacity-40 hover:bg-nh-accent/90"
          style={{ letterSpacing: "-0.01em" }}
        >
          {saving ? (
            <><span className="nh-dot-pulse" /> saving…</>
          ) : phase.k === "existing" ? (
            <>save name</>
          ) : (
            <><ArrowRight className="size-4" strokeWidth={2.4} /> add to collection</>
          )}
        </Button>
      )}
    </div>
  );
}
