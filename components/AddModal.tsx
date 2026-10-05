"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Database, RotateCw, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NhCover } from "./Primitives";
import { itemKey, itemLabel, type Item } from "../lib/data";
import { parseInputs, parseRefKey, refLabel } from "../lib/sources";
import { useScrapeJobs, type ScrapeJob } from "./ScrapeJobsProvider";

// A job's key is its title's `source:id`; show it the way the rest of the app
// labels titles.
function jobLabel(job: ScrapeJob): string {
  const key = parseRefKey(job.key);
  return key ? refLabel(key) : job.input;
}

export function AddModal({ open, onClose, recentAdds, embedded, onAdd }: {
  open: boolean; onClose: () => void; recentAdds: Item[]; embedded?: boolean;
  onAdd?: (items: Item[]) => void;
}) {
  const { jobs, scrapingCount, readyCount, startScrape, dismiss, retry, commitReady } = useScrapeJobs();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Jobs live in the provider, so they survive close/reopen. Only the transient
  // commit state is local — clear it when the modal closes.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (wasOpen && !open) { setSaveError(null); setAdding(false); }
  }, [open]);

  if (!open) return null;

  // Same parse the provider will run, so the count under the box is exactly
  // what pressing scrape queues — the box is meant to take a whole pasted tab
  // dump, where most of the text is titles rather than ids.
  const inputs = parseInputs(input);

  const onScrape = async () => {
    if (inputs.length === 0 || submitting) return;
    setSubmitting(true);
    setSaveError(null);
    try {
      await startScrape(input);
      setInput("");
    } finally {
      setSubmitting(false);
    }
  };

  const onConfirmAdd = async () => {
    if (readyCount === 0) return;
    setAdding(true);
    setSaveError(null);
    const { saved, failedMsg } = await commitReady();
    if (saved.length > 0) onAdd?.(saved);
    if (failedMsg) setSaveError(failedMsg);
    setAdding(false);
  };

  const hasJobs = jobs.length > 0;

  return (
    <div
      onClick={embedded ? undefined : onClose}
      className={embedded ? "relative w-full h-full" : "fixed inset-0 z-120 flex flex-col justify-end"}
      style={{
        background: embedded ? "transparent" : "rgba(0,0,0,0.6)",
        animation: embedded ? "none" : "nhFadeIn 200ms ease",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="flex flex-col bg-nh-surface relative"
        style={{
          borderTopLeftRadius: embedded ? 14 : 18,
          borderTopRightRadius: embedded ? 14 : 18,
          borderBottomLeftRadius: embedded ? 14 : 0,
          borderBottomRightRadius: embedded ? 14 : 0,
          height: embedded ? "100%" : "calc(100% - 30px)",
          animation: embedded ? "none" : "nhSlideUp 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          borderTop: embedded ? "none" : "1px solid var(--nh-border)",
        }}
      >
        {!embedded && (
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-9 h-1 rounded-sm bg-nh-border-strong" />
          </div>
        )}
        <div className="flex items-center px-4 pt-1.5 pb-3 border-b border-nh-border">
          <div
            className="font-display font-bold text-[17px] text-nh-text-1 flex-1"
            style={{ letterSpacing: "-0.02em" }}
          >
            add to collection
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="size-7 rounded-md bg-nh-pill text-nh-text-2 hover:bg-nh-pill/80"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto min-h-0 p-4">
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5">
            a title link from any gallery site · bare numbers are nhentai ids · paste a whole tab dump — links that are not a title are ignored
          </div>
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={"177013\nhttps://hitomi.la/galleries/1234567.html\nhttps://e-hentai.org/g/899557/edd545586a/"}
            className="min-h-20 w-full rounded-lg bg-nh-input border-nh-border px-3 py-2.5 font-mono text-xs tracking-wide text-nh-text-1 resize-y"
          />
          {saveError && (
            <Alert
              variant="destructive"
              className="mt-2.5 rounded-md py-2 px-2.5 font-mono text-[11px]"
              style={{ background: "rgba(255,60,60,0.08)", borderColor: "rgba(255,60,60,0.25)", color: "#ff6b6b" }}
            >
              <AlertDescription className="text-[#ff6b6b]">{saveError}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2 mt-2.5">
            <div className="flex-1 font-mono text-[10px] tracking-wide text-nh-text-3">
              {inputs.length} {inputs.length === 1 ? "id" : "ids"} detected
              {scrapingCount > 0 && (
                <span className="text-nh-accent"> · {scrapingCount} scraping in background</span>
              )}
            </div>
            <Button
              onClick={onScrape}
              disabled={inputs.length === 0 || submitting}
              className="h-9 px-3.5 rounded-lg font-display font-bold text-xs gap-1.5 disabled:opacity-100"
              style={{
                background: inputs.length === 0 ? "var(--nh-pill-bg)" : "var(--nh-accent)",
                color: inputs.length === 0 ? "var(--nh-text-3)" : "#0a0a0a",
                letterSpacing: "-0.01em",
              }}
            >
              {submitting ? (
                <><span className="nh-dot-pulse"/> queuing…</>
              ) : (
                <>
                  <ArrowRight className="size-3.5" strokeWidth={2.2} />
                  scrape
                </>
              )}
            </Button>
          </div>

          {hasJobs && (() => {
            const dupCount = jobs.filter(j => j.status === "duplicate").length;
            const errorCount = jobs.filter(j => j.status === "error").length;
            const fallbackCount = jobs.filter(j => j.status === "ready" && j.via === "fallback").length;
            const summary = [
              `${readyCount} ready`,
              scrapingCount > 0 ? `${scrapingCount} scraping` : null,
              dupCount > 0 ? `${dupCount} in db` : null,
              errorCount > 0 ? `${errorCount} failed` : null,
            ].filter(Boolean).join(" · ");
            return (
              <div className="mt-4">
                <div className="flex justify-between font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-2">
                  <span>scraped · review before adding</span>
                  <span className="text-nh-accent">{summary}</span>
                </div>
                {fallbackCount > 0 && (
                  <div
                    className="flex items-center gap-1.5 mb-2 font-mono text-[10px] rounded-md px-2 py-1.5"
                    style={{ background: "rgba(224,162,58,0.08)", border: "1px solid rgba(224,162,58,0.25)", color: "#e0a23a" }}
                  >
                    <Zap className="size-3 shrink-0" strokeWidth={2.2} />
                    {fallbackCount} of {readyCount} scraped via browser fallback — impit was blocked
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {jobs.map(j => (
                    <JobRow key={j.key} job={j} onDismiss={() => dismiss(j.key)} onRetry={() => retry(j.key)} />
                  ))}
                </div>
                {readyCount > 0 && (
                  <Button
                    onClick={onConfirmAdd}
                    disabled={adding}
                    className="mt-3 w-full h-10.5 rounded-lg bg-nh-accent text-[#0a0a0a] font-display font-extrabold text-[13px] gap-1.5 disabled:opacity-70 hover:bg-nh-accent/90"
                    style={{ letterSpacing: "-0.01em" }}
                  >
                    {adding ? <><span className="nh-dot-pulse"/> saving…</> : `add ${readyCount} title${readyCount > 1 ? "s" : ""} to collection`}
                  </Button>
                )}
              </div>
            );
          })()}

          {!hasJobs && (
            <div className="mt-6">
              <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-2">recently added</div>
              <div className="flex flex-col">
                {recentAdds.map(r => (
                  <div key={itemKey(r)} className="flex items-center gap-2.5 py-2 border-b border-nh-border">
                    <div className="w-8 h-11 shrink-0 rounded-sm overflow-hidden">
                      <NhCover item={r} size="sm"/>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-display font-semibold text-xs text-nh-text-1 truncate">{r.titleName}</div>
                      <div className="font-mono text-[10px] text-nh-text-3">
                        {itemLabel(r)} · {r.pages}p · {r.addedAt === 0 ? "today" : `${r.addedAt}d ago`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function JobRow({ job, onDismiss, onRetry }: { job: ScrapeJob; onDismiss: () => void; onRetry: () => void }) {
  if (job.status === "duplicate" && job.item) return <DuplicateRow item={job.item} onDismiss={onDismiss} />;
  if (job.status === "ready" && job.item) return <PreviewRow item={job.item} via={job.via} onDismiss={onDismiss} />;
  if (job.status === "error") return <ErrorRow job={job} onDismiss={onDismiss} onRetry={onRetry} />;
  return <ScrapingRow job={job} onDismiss={onDismiss} />;
}

// Small subtle remove control shared by the result rows.
function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="remove from list"
      className="size-5 shrink-0 grid place-items-center rounded-md text-nh-text-3 hover:bg-nh-pill hover:text-[#ff6b6b] transition-colors"
    >
      <X className="size-3" strokeWidth={2.4} />
    </button>
  );
}

function ScrapingRow({ job, onDismiss }: { job: ScrapeJob; onDismiss: () => void }) {
  const label = jobLabel(job);
  return (
    <div className="flex items-center gap-2.5 p-2 rounded-lg bg-nh-surface-2 border border-nh-border border-dashed">
      <div className="w-14 h-18.5 shrink-0 rounded-sm bg-nh-pill animate-pulse" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="font-mono text-[9.5px] tracking-wider text-nh-text-3 truncate">{label}</div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-nh-text-2">
          <span className="nh-dot-pulse" /> {job.note ?? "scraping…"}
        </div>
      </div>
      <DismissButton onClick={onDismiss} />
    </div>
  );
}

function ErrorRow({ job, onDismiss, onRetry }: { job: ScrapeJob; onDismiss: () => void; onRetry: () => void }) {
  const label = jobLabel(job);
  return (
    <div
      className="flex items-center gap-2.5 p-2 rounded-lg border"
      style={{ background: "rgba(255,60,60,0.06)", borderColor: "rgba(255,60,60,0.22)" }}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="font-mono text-[9.5px] tracking-wider text-[#ff6b6b] truncate">{label}</div>
        <div className="font-mono text-[10px] text-nh-text-3 truncate">{job.error ?? "scrape failed"}</div>
      </div>
      <button
        onClick={onRetry}
        title="retry scrape"
        className="size-6 shrink-0 grid place-items-center rounded-md text-nh-text-2 hover:bg-nh-pill hover:text-nh-accent transition-colors"
      >
        <RotateCw className="size-3.5" strokeWidth={2.2} />
      </button>
      <DismissButton onClick={onDismiss} />
    </div>
  );
}

// Stub row for a title that is already in the collection — scrape was skipped.
// Dismissable: an all-duplicate batch never goes through commitReady's sweep,
// so without the button these rows would be stuck in the list (and storage).
function DuplicateRow({ item, onDismiss }: { item: Item; onDismiss: () => void }) {
  return (
    <div className="flex gap-2.5 p-2 rounded-lg bg-nh-surface-2 border border-nh-border border-dashed opacity-75">
      <div className="w-14 shrink-0">
        <NhCover item={item} size="sm"/>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="font-mono text-[9.5px] tracking-wider text-nh-text-3">{itemLabel(item)}</div>
        <div
          className="font-display font-bold text-[13px] text-nh-text-2 truncate"
          style={{ letterSpacing: "-0.01em" }}
        >
          {item.titleName}
        </div>
        <div className="font-mono text-[10px] text-nh-text-3">
          already in collection · added {item.addedAt === 0 ? "today" : `${item.addedAt}d ago`} · scrape skipped
        </div>
      </div>
      <div className="flex items-center px-1 text-nh-text-3">
        <Database className="size-4" strokeWidth={2} />
      </div>
      <div className="flex items-center">
        <DismissButton onClick={onDismiss} />
      </div>
    </div>
  );
}

function PreviewRow({ item, via, onDismiss }: { item: Item; via?: ScrapeJob["via"]; onDismiss: () => void }) {
  return (
    <div className="flex gap-2.5 p-2 rounded-lg bg-nh-surface-2 border border-nh-border">
      <div className="w-14 shrink-0">
        <NhCover item={item} size="sm"/>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9.5px] tracking-wider text-nh-accent">{itemLabel(item)}</span>
          {via === "fallback" && (
            <span
              className="inline-flex items-center gap-0.5 font-mono text-[8.5px] uppercase tracking-wider rounded-sm px-1 py-0.5"
              style={{ background: "rgba(224,162,58,0.12)", color: "#e0a23a" }}
              title="impit was blocked — scraped via Playwright browser fallback"
            >
              <Zap className="size-2" strokeWidth={2.4} /> fallback
            </span>
          )}
        </div>
        <div
          className="font-display font-bold text-[13px] text-nh-text-1 truncate"
          style={{ letterSpacing: "-0.01em" }}
        >
          {item.titleName}
        </div>
        <div className="font-mono text-[10px] text-nh-text-3">
          {item.artists[0]} · {item.pages}p · {item.tags.length} tags
        </div>
        <div className="flex gap-0.75 flex-wrap mt-0.5">
          {item.tags.slice(0, 4).map(t => (
            <Badge
              key={t}
              variant="secondary"
              className="h-auto rounded-sm border-0 bg-nh-pill px-1.5 py-0.5 font-mono text-[9px] text-nh-text-3"
            >
              {t}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex items-center">
        <button
          onClick={onDismiss}
          title="remove from list"
          className="size-9 shrink-0 grid place-items-center rounded-md text-nh-text-3 hover:bg-nh-pill hover:text-[#ff6b6b] transition-colors"
        >
          <X className="size-5" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}
