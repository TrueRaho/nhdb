"use client";

import { useEffect, useState } from "react";
import { getGhostTagsAction } from "../app/actions";
import { ON_OFF, SegmentedToggle } from "./Primitives";
import type { GhostTag } from "../lib/ghost";
import type { Filters } from "./HeaderFilter";

const SOURCE_LABEL: Record<GhostTag["sourceKind"], string> = {
  artist: "works by",
  group: "works from",
  parody: "works in",
  character: "works with",
};

/** "4 of 4 works by artist A carry this" — the whole case for one ghost tag. */
function evidence(g: GhostTag): string {
  return `${g.co} of ${g.of} ${SOURCE_LABEL[g.sourceKind]} ${g.sourceName} carry this · ${g.lift.toFixed(1)}× the collection rate`;
}

/**
 * The tag filter's "ghosts on/off" switch. Off by default: about two ghosts in
 * five are wrong, which is a fine trade when you asked for it and a bad one
 * when you did not.
 */
export function GhostTagsToggle({ filters, setFilters }: {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">ghosts</span>
        <SegmentedToggle
          value={filters.ghostTags}
          options={ON_OFF}
          onChange={(v) => setFilters(f => ({ ...f, ghostTags: v }))}
        />
      </div>
      <span className="font-mono text-[9px] leading-snug text-nh-text-3">
        {filters.ghostTags
          ? "thinly-tagged titles match on inferred tags too · ~2 in 5 are wrong"
          : "match inferred tags, so thinly-tagged titles still turn up"}
      </span>
    </div>
  );
}

/**
 * The inferred tags for one open title, shown alongside its real ones. Styled
 * as dashed outlines rather than filled chips, because the difference between
 * "this title is tagged X" and "this title is probably X" has to survive a
 * glance — clicking one still filters by it like any other tag.
 */
export function GhostTagChips({ hashtag, onTagClick }: {
  hashtag: number;
  onTagClick: (group: string, val: string) => void;
}) {
  const [ghosts, setGhosts] = useState<GhostTag[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGhostTagsAction(hashtag)
      .then(g => { if (!cancelled) setGhosts(g); })
      .catch(err => { console.error("ghost tags failed:", err); if (!cancelled) setGhosts([]); });
    return () => { cancelled = true; };
  }, [hashtag]);

  if (!ghosts?.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">
        likely tags · inferred, not from nhentai
      </div>
      <div className="flex flex-wrap gap-1">
        {ghosts.map(g => (
          <button
            key={g.name}
            onClick={() => onTagClick("tags", g.name)}
            title={evidence(g)}
            className="h-auto cursor-pointer rounded-sm px-2 py-1 font-mono text-[11px] font-medium tracking-wide"
            style={{
              border: "1px dashed var(--nh-border-strong)",
              color: "var(--nh-text-3)",
              background: "transparent",
            }}
          >
            {g.name}
            <span className="opacity-70"> {g.co}/{g.of}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
