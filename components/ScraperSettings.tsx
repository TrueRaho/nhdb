"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveScraperEndpointsAction } from "@/app/account/actions";
import type { ScraperEndpointView } from "@/lib/scraper-endpoints";
import { cn } from "@/lib/utils";

/**
 * A row being edited.
 *
 * `secret` is three-valued in the same way the server side is: a string sets a
 * new token, `""` clears it, and `null` means "leave the stored one alone".
 * That is what lets the screen show a host HAS a secret without the secret ever
 * being sent to the browser — `hasSecret` is all it receives.
 */
type Row = {
  key: number;
  label: string;
  url: string;
  secret: string | null;
  hasSecret: boolean;
};

// Row keys double as input ids, so the first render's keys must come out the
// same on the server and in the browser: they are numbered from 0 per
// component, never from a module-level counter (which on the server keeps
// counting across requests and broke hydration).
const blankRow = (key: number): Row => ({ key, label: "", url: "", secret: "", hasSecret: false });

function toRows(endpoints: ScraperEndpointView[], firstKey: number): Row[] {
  return endpoints.map((e, i) => ({ key: firstKey + i, label: e.label, url: e.url, secret: null, hasSecret: e.hasSecret }));
}

/** What a card is titled by: its name, else the host it points at. */
function rowTitle(row: Row): string {
  if (row.label.trim()) return row.label.trim();
  try {
    return new URL(row.url.trim()).host || "new host";
  } catch {
    return "new host";
  }
}

const FOCUS_RING = "outline-hidden focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nh-bg";

// 16px on phones (iOS zooms into smaller inputs on focus); the md: size must be
// restated or the Input primitive's md:text-sm wins.
const inputClass =
  "h-10 rounded-lg border-nh-border bg-nh-input px-3 font-mono text-base text-nh-text-1 placeholder:text-nh-text-3 focus-visible:border-nh-accent focus-visible:ring-nh-accent/30 md:text-[13px]";

export function ScraperSettings({
  initialEndpoints, limit, secretStorageReady,
}: {
  initialEndpoints: ScraperEndpointView[];
  limit: number;
  secretStorageReady: boolean;
}) {
  const idBase = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    initialEndpoints.length ? toRows(initialEndpoints, 0) : [blankRow(0)]);
  // Next unused row key; only advanced from event handlers, after the first render.
  const keyCounter = useRef(Math.max(initialEndpoints.length, 1));
  const takeKeys = (n: number) => {
    const first = keyCounter.current;
    keyCounter.current += n;
    return first;
  };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // Anything edited since the list was loaded or last saved.
  const [dirty, setDirty] = useState(false);
  // Screen-reader-only narration of changes the eye sees but a reader does not (reordering).
  const [notice, setNotice] = useState("");

  const fieldId = (key: number, field: "url" | "label" | "secret" | "replace" | "title") => `${idBase}-${field}-${key}`;
  // After a control disappears (row removed, Replace swapped for an input),
  // put focus somewhere sensible instead of letting it fall to <body>.
  const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  const edit = (update: (prev: Row[]) => Row[]) => {
    setSaved(false);
    setDirty(true);
    setNotice("");
    setRows(update);
  };

  const patch = (key: number, change: Partial<Row>) =>
    edit((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    edit((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setNotice(`${rowTitle(rows[index])} moved to position ${target + 1} of ${rows.length}.`);
  };

  const remove = (index: number) => {
    const neighbour = rows[index + 1] ?? rows[index - 1];
    const replacement = takeKeys(1);
    edit((prev) => (prev.length === 1 ? [blankRow(replacement)] : prev.filter((_, i) => i !== index)));
    focusSoon(fieldId(neighbour?.key ?? replacement, "url"));
  };

  const add = () => {
    const key = takeKeys(1);
    edit((prev) => [...prev, blankRow(key)]);
    focusSoon(fieldId(key, "url"));
  };

  async function save() {
    if (pending || !dirty) return;
    setPending(true);
    setError("");
    setSaved(false);
    try {
      // Blank rows are dropped rather than rejected — the form always keeps a
      // spare empty row, and making the user delete it before saving would be
      // busywork.
      const payload = rows
        .filter((r) => r.url.trim())
        .map((r) => ({ label: r.label.trim() || undefined, url: r.url.trim(), secret: r.secret }));
      const result = await saveScraperEndpointsAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.endpoints.length
        ? toRows(result.endpoints, takeKeys(result.endpoints.length))
        : [blankRow(takeKeys(1))]);
      setSaved(true);
      setDirty(false);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  const canAdd = rows.length < limit;

  return (
    <section aria-labelledby={`${idBase}-heading`} className="flex flex-col gap-5">
      <div>
        <h2 id={`${idBase}-heading`} className="flex items-baseline gap-2.5 font-display text-xl font-bold tracking-[-0.02em]">
          Scraper hosts
          <span className="font-mono text-[10px] font-normal tracking-wider text-nh-text-3 uppercase">
            {rows.length} / {limit}
          </span>
        </h2>
        <div className="mt-1.5 flex max-w-xl flex-col gap-1 text-sm leading-relaxed text-pretty text-nh-text-2">
          <p>A scraper host reads gallery pages and sends title metadata to your collection. You need your own before adding titles.</p>
          <p>On your computer, set SCRAPER_SECRET and run <code>pnpm scraper</code> with ngrok installed to get a public HTTPS URL.</p>
          <p>Or deploy your own host on Render using <code>render.yaml</code>.</p>
          <p>Add its URL and matching secret below. Hosts are tried top to bottom when one is unreachable.</p>
          <p><a href="/scraper-guide" target="_blank" rel="noopener noreferrer" className={`text-nh-accent underline ${FOCUS_RING}`}>Read SCRAPER.md for setup instructions</a>.</p>
        </div>
      </div>

      {!secretStorageReady && (
        <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-2.5 text-sm leading-snug text-destructive">
          Secret storage is not configured on this deployment (<code className="font-mono">SCRAPER_CRED_KEY</code> is
          missing), so a host that needs a bearer token cannot be saved. Hosts without a secret still work.
        </p>
      )}

      {/* Disabled while a save is in flight: edits made meanwhile would be
          overwritten by the saved list, and then reported as saved. */}
      <fieldset disabled={pending} className="contents">
        <ol className="flex flex-col">
          {rows.map((row, index) => {
            const primary = index === 0;
            const lastRow = index === rows.length - 1;
            const title = rowTitle(row);
            const savedSecret = row.hasSecret && row.secret === null;
            const nn = String(index + 1).padStart(2, "0");
            return (
              <li key={row.key} className="relative grid grid-cols-1 gap-x-3 pb-3 sm:grid-cols-[2.25rem_minmax(0,1fr)]">
                <ChainNode dashed={false} primary={primary} tail={!lastRow || canAdd}>{nn}</ChainNode>

                <div
                  role="group"
                  aria-labelledby={fieldId(row.key, "title")}
                  className="min-w-0 rounded-xl border border-nh-border bg-nh-surface p-4"
                >
                  <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <h3 id={fieldId(row.key, "title")} className="min-w-0 basis-full truncate font-display text-[15px] font-semibold text-nh-text-1 sm:basis-auto">
                      {title}
                    </h3>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-mono text-[9.5px] tracking-wider uppercase",
                        primary ? "bg-nh-accent text-[#0a0a0a]" : "bg-nh-pill text-nh-text-3",
                      )}
                    >
                      <span className="sm:hidden">{nn} · </span>{primary ? "primary" : "fallback"}
                    </span>
                    <span className="flex-1" />
                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton label={`Move ${title} up`} disabled={primary} onClick={() => move(index, -1)}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton label={`Move ${title} down`} disabled={lastRow} onClick={() => move(index, 1)}>
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton label={`Remove ${title}`} destructive onClick={() => remove(index)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                    <FieldBlock htmlFor={fieldId(row.key, "url")} label="URL">
                      <Input
                        id={fieldId(row.key, "url")}
                        value={row.url}
                        onChange={(e) => patch(row.key, { url: e.target.value })}
                        placeholder="https://scraper.example.com"
                        autoComplete="off" spellCheck={false} inputMode="url"
                        className={inputClass}
                      />
                    </FieldBlock>
                    <FieldBlock htmlFor={fieldId(row.key, "label")} label="Name · optional">
                      <Input
                        id={fieldId(row.key, "label")}
                        value={row.label}
                        onChange={(e) => patch(row.key, { label: e.target.value })}
                        placeholder="mac mini"
                        autoComplete="off"
                        className={inputClass}
                      />
                    </FieldBlock>
                  </div>

                  {savedSecret ? (
                    <FieldBlock label="SCRAPER_SECRET" className="mt-3">
                      <div className="flex h-10 items-center gap-2 rounded-lg border border-nh-border bg-nh-input pr-1 pl-3">
                        <KeyRound aria-hidden className="size-3.5 shrink-0 text-nh-accent" />
                        <span aria-hidden className="font-mono text-[13px] tracking-[0.2em] text-nh-text-2">••••••••</span>
                        <span className="min-w-0 truncate font-mono text-[9.5px] tracking-wider text-nh-text-3 uppercase">
                          saved · encrypted
                        </span>
                        <span className="flex-1" />
                        <Button
                          id={fieldId(row.key, "replace")}
                          type="button" variant="ghost" size="sm"
                          aria-label={`Replace secret for ${title}`}
                          onClick={() => patch(row.key, { secret: "" })}
                          className={cn("font-mono text-[11px] text-nh-text-2 hover:bg-nh-pill hover:text-nh-text-1 pointer-coarse:h-9", FOCUS_RING)}
                        >
                          Replace
                        </Button>
                      </div>
                    </FieldBlock>
                  ) : (
                    <FieldBlock
                      htmlFor={fieldId(row.key, "secret")}
                      label="SCRAPER_SECRET"
                      className="mt-3"
                      hint="Must match SCRAPER_SECRET on that machine. Stored encrypted and never sent back to the browser. Leave empty only for a local scraper started without one."
                    >
                      <div className="flex gap-2">
                        <Input
                          id={fieldId(row.key, "secret")}
                          type="password"
                          value={row.secret ?? ""}
                          onChange={(e) => patch(row.key, { secret: e.target.value })}
                          placeholder={row.hasSecret ? "leave empty to remove the secret" : "same value as on your scraper"}
                          autoComplete="new-password" spellCheck={false}
                          // Only mounts for a stored secret after "Replace" was pressed.
                          autoFocus={row.hasSecret}
                          aria-describedby={`${fieldId(row.key, "secret")}-hint`}
                          className={inputClass}
                        />
                        {row.hasSecret && (
                          <Button
                            type="button" variant="ghost"
                            onClick={() => {
                              patch(row.key, { secret: null });
                              focusSoon(fieldId(row.key, "replace"));
                            }}
                            className={cn("h-10 shrink-0 font-mono text-[11px] text-nh-text-2 hover:bg-nh-pill hover:text-nh-text-1", FOCUS_RING)}
                          >
                            Keep saved
                          </Button>
                        )}
                      </div>
                    </FieldBlock>
                  )}
                </div>
              </li>
            );
          })}

          {canAdd && (
            <li className="relative grid grid-cols-1 gap-x-3 sm:grid-cols-[2.25rem_minmax(0,1fr)]">
              <ChainNode dashed primary={false} tail={false}>
                <Plus aria-hidden className="size-3.5" />
              </ChainNode>
              <Button
                type="button" variant="ghost" onClick={add}
                className={cn(
                  "h-11 justify-start gap-2 rounded-xl border border-dashed border-nh-border-strong px-4 font-mono text-[11px] tracking-wide text-nh-text-2 hover:border-nh-accent/50 hover:bg-transparent hover:text-nh-text-1",
                  FOCUS_RING,
                )}
              >
                <Plus aria-hidden className="size-4 sm:hidden" /> Add {rows.length ? "fallback " : ""}host
              </Button>
            </li>
          )}
        </ol>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-2.5 text-sm leading-snug text-destructive">
          {error}
        </p>
      )}

      {/* Floats only while there is something to save; otherwise it sits in
          the flow and does not cover the list. */}
      <div
        className={cn(
          "z-20 flex items-center gap-3 rounded-xl border border-nh-border bg-nh-surface-2 p-2 pl-4 sm:ml-12",
          dirty && "sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
        )}
      >
        <span role="status" className="min-w-0 flex-1 font-mono text-[10px] tracking-wider uppercase">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-[#5ac878]"><Check aria-hidden className="size-3.5" strokeWidth={2.6} /> Saved.</span>
          ) : dirty ? (
            <span className="inline-flex items-center gap-1.5 text-nh-accent"><span aria-hidden className="size-1.5 rounded-full bg-current" /> unsaved changes</span>
          ) : (
            <span className="text-nh-text-3">no changes</span>
          )}
          <span className="sr-only">{notice}</span>
        </span>
        <Button
          type="button" onClick={save} disabled={pending || !dirty} focusableWhenDisabled
          className={cn(
            "h-9 shrink-0 gap-1.5 rounded-lg bg-nh-accent px-4 font-display text-[13px] font-bold text-[#0a0a0a] hover:bg-nh-accent/90 data-disabled:opacity-40",
            FOCUS_RING,
          )}
        >
          {pending ? <><span className="nh-dot-pulse" /> Saving…</> : "Save hosts"}
        </Button>
      </div>
    </section>
  );
}

/** The numbered node of the priority chain, with the line running down to the next one. */
function ChainNode({ primary, dashed, tail, children }: { primary: boolean; dashed: boolean; tail: boolean; children: ReactNode }) {
  return (
    <div aria-hidden className="hidden flex-col items-center pt-1 sm:flex">
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full border font-mono text-[11px] font-semibold",
          dashed
            ? "border-dashed border-nh-border-strong text-nh-text-3"
            : primary
              ? "border-nh-accent/50 bg-nh-accent-soft text-nh-accent"
              : "border-nh-border bg-nh-input text-nh-text-3",
        )}
      >
        {children}
      </span>
      {/* -mb-4 runs the line through the row gap into the next node's top padding. */}
      {tail && <span className="-mb-4 w-px flex-1 bg-linear-to-b from-nh-border-strong to-nh-border" />}
    </div>
  );
}

function FieldBlock({ htmlFor, label, hint, className, children }: {
  /** Omitted when the block shows a stored value rather than an input. */
  htmlFor?: string;
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  const labelClass = "font-mono text-[10px] tracking-[0.14em] text-nh-text-3 uppercase";
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {htmlFor ? <label htmlFor={htmlFor} className={labelClass}>{label}</label> : <span className={labelClass}>{label}</span>}
      {children}
      {hint && htmlFor && <p id={`${htmlFor}-hint`} className="text-xs leading-relaxed text-nh-text-3">{hint}</p>}
    </div>
  );
}

function IconButton({ label, destructive = false, disabled, onClick, children }: {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button" variant="ghost" size="icon"
      aria-label={label} title={label}
      // A move button disables itself when its row reaches the end of the
      // list; staying focusable keeps keyboard focus on it instead of <body>.
      disabled={disabled} focusableWhenDisabled onClick={onClick}
      className={cn(
        "size-8 text-nh-text-3 hover:bg-nh-pill hover:text-nh-text-1 data-disabled:opacity-35 pointer-coarse:size-10",
        destructive && "hover:bg-destructive/10 hover:text-destructive",
        FOCUS_RING,
      )}
    >
      {children}
    </Button>
  );
}
