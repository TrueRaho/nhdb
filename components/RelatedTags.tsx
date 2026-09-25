"use client";

import { useEffect, useMemo, useState } from "react";
import { getTagAffinityAction } from "../app/actions";
import { ON_OFF, SegmentedToggle } from "./Primitives";
import type { TagAffinity } from "../lib/affinity";
import type { MatchMode } from "../lib/titles";
import type { Filters } from "./HeaderFilter";

/** How many related tags the toggle pulls in. */
const SUGGESTION_LIMIT = 6;

// NUL, because the signature has to round-trip back into the seed list and tag
// names are full of every obvious separator ("full color", "x-ray").
const SEP = "\u0000";

/**
 * Identity of the query a suggestion list belongs to. Sorted, so re-selecting
 * the same tags in a different order is not a different seed set.
 *
 * Also the staleness check for the expansion itself: `filters.tagsExpanded` is
 * only applied while `filters.expandedFor` still equals the signature of the
 * current selection, which is what lets the fetch below be the *only* writer of
 * those fields — nothing has to clear them when the tags change.
 */
export function seedSignature(tags: string[], mode: MatchMode): string {
  return tags.length === 0 ? "" : `${mode}:${[...tags].sort().join(SEP)}`;
}

/** The seed list back out of a signature. `mode` never contains a colon, so the
 *  first one is always the separator — later colons belong to tag names. */
function seedsOf(signature: string): string[] {
  return signature ? signature.slice(signature.indexOf(":") + 1).split(SEP) : [];
}

type Fetched = { signature: string; items: TagAffinity[]; failed: boolean };

/**
 * The "related tags" control under the tag filter: switch it on and the query
 * widens to titles carrying tags that are characteristic of the current
 * selection (see lib/affinity.ts for what "characteristic" means here).
 *
 * Self-contained on purpose — it fetches its own suggestions and writes only
 * the three expansion fields back through `setFilters`. Both layouts render it
 * inside their tag section, and neither has to thread suggestion state down.
 */
export function RelatedTags({ filters, setFilters }: {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
}) {
  // One state slot stamped with the query it answers, so "still loading" and
  // "stale from the previous selection" are told apart by comparison rather
  // than by resetting state from inside the effect.
  const [fetched, setFetched] = useState<Fetched | null>(null);

  const { expandTags, tagsExpanded } = filters;
  const mode = filters.matchModes.tags;
  const signature = seedSignature(filters.tags, mode);
  // Derived from the signature, not from `filters.tags`: that array is a fresh
  // reference after unrelated filter edits, and refetching on those is waste.
  const seeds = useMemo(() => seedsOf(signature), [signature]);

  useEffect(() => {
    if (!expandTags || seeds.length === 0) return;
    let cancelled = false;
    getTagAffinityAction({ tags: seeds, mode, limit: SUGGESTION_LIMIT })
      .then(items => {
        if (cancelled) return;
        setFetched({ signature, items, failed: false });
        // Claim the expansion only for a seed set not served yet. Re-running for
        // the *same* seeds (a remount — the mobile filter sheet unmounts on
        // close) must leave the user's own removals alone.
        setFilters(f => (f.expandedFor === signature
          ? f
          : { ...f, tagsExpanded: items.map(i => i.name), expandedFor: signature }));
      })
      .catch(err => {
        console.error("tag affinity failed:", err);
        if (cancelled) return;
        setFetched({ signature, items: [], failed: true });
      });
    return () => { cancelled = true; };
  }, [expandTags, seeds, mode, signature, setFilters]);

  const toggleOne = (name: string) =>
    setFilters(f => ({
      ...f,
      tagsExpanded: f.tagsExpanded.includes(name)
        ? f.tagsExpanded.filter(t => t !== name)
        : [...f.tagsExpanded, name],
    }));

  const hasSeeds = seeds.length > 0;
  const active = expandTags && hasSeeds;
  const current = fetched?.signature === signature ? fetched : null;
  const suggestions = current?.failed ? [] : current?.items ?? [];
  const loading = active && current === null;
  // Mirrors the gate NhdbApp applies before sending the expansion, so the
  // count shown is the count in effect.
  const applied = active && filters.expandedFor === signature ? tagsExpanded : [];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">related</span>
        <SegmentedToggle
          value={expandTags}
          options={ON_OFF}
          onChange={(v) => setFilters(f => ({ ...f, expandTags: v }))}
          disabled={!hasSeeds}
          label="Related tags"
        />
        {loading && <span className="font-mono text-[9px] text-nh-text-3">…</span>}
        {applied.length > 0 && (
          <span className="font-mono text-[9px] text-nh-text-3">+{applied.length} · widens</span>
        )}
      </div>

      {!hasSeeds && (
        <span className="font-mono text-[9px] text-nh-text-3">pick a tag to get suggestions</span>
      )}

      {active && current?.failed && (
        <span className="font-mono text-[9px] text-[#ff6b6b]">suggestions unavailable</span>
      )}
      {active && current && !current.failed && suggestions.length === 0 && (
        <span className="font-mono text-[9px] text-nh-text-3">
          nothing beats chance here — the selection is too broad
        </span>
      )}
      {active && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map(s => {
            const on = applied.includes(s.name);
            return (
              <button
                key={s.name}
                onClick={() => toggleOne(s.name)}
                aria-pressed={on}
                title={`${s.co} shared titles · ${Math.round(s.share * 100)}% of the current match · ${s.lift.toFixed(1)}× the collection rate`}
                className="h-auto rounded-sm border px-1.5 py-1 font-mono text-[10px] leading-none"
                style={{
                  // Deliberately not the solid accent of a *selected* tag: these
                  // were added on the user's behalf, and the filter only reads
                  // honestly if they look like a different kind of value.
                  borderColor: on ? "var(--nh-accent)" : "var(--nh-border)",
                  background: on ? "var(--nh-accent-soft)" : "transparent",
                  color: on ? "var(--nh-accent)" : "var(--nh-text-3)",
                }}
              >
                {s.name}
                <span className="opacity-60"> ×{s.lift.toFixed(1)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
