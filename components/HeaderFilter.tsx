"use client";

import { useMemo, useState } from "react";
import { BarChart3, Plus, Search, SlidersHorizontal, X, Clock, Eye, BookOpen, Shuffle, ArrowUpDown, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { ScrapeBadge } from "./ScrapeBadge";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type { SortField, MatchMode } from "../lib/titles";

export type ReadFilter = "all" | "unread" | "read";

// Which multi-select categories support an AND/OR match toggle, in render order.
export const MATCH_CATEGORIES = ["tags", "artists", "groups", "characters", "parodies"] as const;
export type MatchCategory = (typeof MATCH_CATEGORIES)[number];

export type Filters = {
  tags: string[]; characters: string[]; parodies: string[]; artists: string[]; groups: string[];
  matchModes: Record<MatchCategory, MatchMode>;
  pageMin: number; pageMax: number;
  read: ReadFilter;
  noAlter: boolean;
  sortField: SortField; sortDir: "asc" | "desc";
};

export type Dataset = {
  allTags: string[]; allCharacters: string[]; allParodies: string[]; allArtists: string[]; allGroups: string[];
  tagCounts: Record<string, number>; charCounts: Record<string, number>;
  parodyCounts: Record<string, number>; artistCounts: Record<string, number>; groupCounts: Record<string, number>;
  pageMin: number; pageMax: number; matchingCount?: number;
};

// The initial / "cleared" filter state. Single source of truth so the initial
// render and every "clear all" stay in sync (page bounds default to the dataset
// span; `|| 999` keeps the upper bound sane when the library is empty).
export function defaultFilters(pageMin: number, pageMax: number): Filters {
  return {
    tags: [], characters: [], parodies: [], artists: [], groups: [],
    // Every category defaults to "any" (OR) — selecting more values widens the
    // results; flip a category to "all" (AND) to require every selected value.
    matchModes: { tags: "or", artists: "or", groups: "or", characters: "or", parodies: "or" },
    pageMin,
    pageMax: pageMax || 999,
    read: "all",
    noAlter: false,
    sortField: "added-at", sortDir: "desc",
  };
}

// How a multi-select option list (tags, artists, …) is ordered. "count-desc"
// surfaces the most-used entries first (the default), "count-asc" the rarest.
export type OptionSort = "count-desc" | "count-asc";

const OPTION_SORTS: { id: OptionSort; label: string }[] = [
  { id: "count-desc", label: "most" },
  { id: "count-asc", label: "least" },
];

// Order an option list by the chosen mode. Ties break alphabetically so the
// output is stable regardless of the incoming order.
export function sortOptions(options: string[], counts: Record<string, number>, sort: OptionSort): string[] {
  const arr = [...options];
  if (sort === "count-asc") return arr.sort((a, b) => (counts[a] || 0) - (counts[b] || 0) || a.localeCompare(b));
  return arr.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
}

// Compact segmented control for picking an OptionSort.
export function OptionSortToggle({ value, onChange }: { value: OptionSort; onChange: (s: OptionSort) => void }) {
  return (
    <div className="inline-flex rounded-sm border border-nh-border bg-nh-input p-0.5">
      {OPTION_SORTS.map(o => {
        const sel = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className="px-1.5 py-px rounded-xs font-mono text-[9px] font-semibold uppercase tracking-wider"
            style={{
              background: sel ? "var(--nh-accent)" : "transparent",
              color: sel ? "#0a0a0a" : "var(--nh-text-3)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Compact "all (AND) / any (OR)" segmented control for a multi-select category.
// Shown only when 2+ values are selected, since the mode is a no-op below that.
export function MatchToggle({ mode, onChange }: { mode: MatchMode; onChange: (m: MatchMode) => void }) {
  return (
    <div className="inline-flex rounded-sm border border-nh-border bg-nh-input p-0.5">
      {([
        { id: "and" as const, label: "all" },
        { id: "or" as const, label: "any" },
      ]).map(o => {
        const sel = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className="px-1.5 py-px rounded-xs font-mono text-[9px] font-semibold uppercase tracking-wider"
            style={{
              background: sel ? "var(--nh-accent)" : "transparent",
              color: sel ? "#0a0a0a" : "var(--nh-text-3)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Canonical sort fields (order + label + icon). Shared by the mobile sort sheet
// and the desktop sidebar so a new SortField is declared in exactly one place.
export const SORT_FIELDS: { id: SortField; label: string; icon: typeof Clock }[] = [
  { id: "added-at", label: "date added", icon: Clock },
  { id: "last-read-at", label: "last read date", icon: Eye },
  { id: "uploaded-at", label: "upload date", icon: Clock },
  { id: "read-count", label: "read count", icon: Eye },
  { id: "pages", label: "page count", icon: BookOpen },
  { id: "tag-count", label: "tag count", icon: SlidersHorizontal },
  { id: "avg-tag-value", label: "avg tag value", icon: Gauge },
  { id: "title", label: "title (a→z)", icon: ArrowUpDown },
  { id: "hashtag", label: "hashtag id", icon: ArrowUpDown },
  { id: "random", label: "random", icon: Shuffle },
];

export function GalleryHeader({ search, setSearch, onAdd, onStats, statsActive, onOpenSettings, activeFilterCount }: {
  search: string; setSearch: (s: string) => void;
  onAdd: () => void; onStats: () => void; statsActive: boolean;
  onOpenSettings: () => void; activeFilterCount: number;
}) {
  return (
    <div
      className="sticky top-0 z-40 border-b border-nh-border"
      style={{
        background: "var(--nh-bg-blur)",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <div
          className="flex items-center gap-1 font-display font-extrabold text-nh-text-1"
          style={{ fontSize: 22, letterSpacing: "-0.04em" }}
        >
          <span>nh</span>
          <span className="text-nh-accent">db</span>
        </div>
        <div className="flex-1" />
        <Button
          onClick={onStats}
          variant="secondary"
          size="icon"
          className="size-8 rounded-lg bg-nh-input hover:bg-nh-input/80"
          style={statsActive ? { background: "var(--nh-accent-soft)" } : undefined}
        >
          <BarChart3
            className="size-4"
            style={{ color: statsActive ? "var(--nh-accent)" : "var(--nh-text-2)" }}
          />
        </Button>
        <div className="relative">
          <Button
            onClick={onAdd}
            size="icon"
            className="size-8 rounded-lg bg-nh-accent text-[#0a0a0a] hover:bg-nh-accent/90"
          >
            <Plus className="size-4" strokeWidth={2.2} />
          </Button>
          <ScrapeBadge />
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-nh-text-3 pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="search title, artist, tag…"
            className="h-9 rounded-lg bg-nh-input border-nh-border pl-8 pr-8 font-mono text-xs tracking-wide text-nh-text-1 placeholder:text-nh-text-3"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-nh-text-3"
              aria-label="clear"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button
          onClick={onOpenSettings}
          variant="secondary"
          className="h-8 rounded-lg border border-nh-border bg-nh-input px-2.5 gap-1.5 font-mono text-[11px] tracking-wide hover:bg-nh-input/80"
          style={activeFilterCount > 0 ? { background: "var(--nh-accent-soft)", color: "var(--nh-accent)" } : { color: "var(--nh-text-2)" }}
        >
          <SlidersHorizontal className="size-3.5" />
          settings
          {activeFilterCount > 0 && (
            <span
              className="min-w-4 rounded-sm px-1 text-center text-[9px] font-semibold"
              style={{ background: "var(--nh-accent)", color: "#0a0a0a" }}
            >
              {activeFilterCount}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

export function FilterSheet({ open, onClose, filters, setFilters, dataset, activeSection, setActiveSection }: {
  open: boolean; onClose: () => void;
  filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  dataset: Dataset;
  activeSection: string; setActiveSection: (s: string) => void;
}) {
  const [tagSearch, setTagSearch] = useState("");

  const sections = [
    { id: "sort", label: "sort", count: filters.sortField !== "added-at" || filters.sortDir !== "desc" ? 1 : 0 },
    { id: "status", label: "status", count: (filters.read !== "all" ? 1 : 0) + (filters.noAlter ? 1 : 0) },
    { id: "tags", label: "tags", count: filters.tags.length },
    { id: "characters", label: "chars", count: filters.characters.length },
    { id: "parodies", label: "parodies", count: filters.parodies.length },
    { id: "artists", label: "artists", count: filters.artists.length },
    { id: "groups", label: "groups", count: filters.groups.length },
    { id: "pages", label: "pages", count: (filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0 },
  ];

  const toggle = (key: keyof Filters, val: string) => {
    setFilters(f => {
      const list = f[key] as string[];
      return { ...f, [key]: list.includes(val) ? list.filter(x => x !== val) : [...list, val] } as Filters;
    });
  };

  const setMode = (key: MatchCategory, m: MatchMode) =>
    setFilters(f => ({ ...f, matchModes: { ...f.matchModes, [key]: m } }));

  const totalActive = filters.tags.length + filters.characters.length + filters.parodies.length + filters.artists.length + filters.groups.length;

  return (
    <Sheet open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="bg-nh-surface text-nh-text-1 max-h-[82%] rounded-t-[18px] border-t border-nh-border p-0 flex flex-col gap-0"
      >
        <SheetTitle className="sr-only">Filters</SheetTitle>
        <SheetDescription className="sr-only">Filter and sort your collection.</SheetDescription>
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-9 h-1 rounded-sm bg-nh-border-strong" />
        </div>
        <div className="flex items-center gap-2 px-3.5 pt-1.5 pb-2.5 border-b border-nh-border">
          <div className="font-display font-bold text-[15px] text-nh-text-1" style={{ letterSpacing: "-0.01em" }}>filters</div>
          <div className="font-mono text-[10px] text-nh-text-3 tracking-wide">{totalActive} active</div>
          <div className="flex-1" />
          <Button
            variant="ghost"
            onClick={() => setFilters(defaultFilters(dataset.pageMin, dataset.pageMax))}
            className="h-auto p-0 font-mono text-[10px] uppercase tracking-wider text-nh-text-3 hover:bg-transparent hover:text-nh-text-2"
          >
            clear all
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="size-6.5 rounded-md bg-nh-pill text-nh-text-2 hover:bg-nh-pill/80"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div
          className="flex items-center gap-1 px-3 shrink-0 border-b border-nh-border scrollbar-none [&::-webkit-scrollbar]:hidden"
          style={{ overflowX: "auto", height: "44px" }}
        >
          {sections.map(s => {
            const active = activeSection === s.id;
            return (
              <Button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                variant="secondary"
                className="h-auto px-2.5 py-1.5 rounded-md gap-1.5 font-mono text-[11px] font-semibold tracking-wide whitespace-nowrap"
                style={{
                  flexShrink: 0,
                  background: active ? "var(--nh-accent)" : "var(--nh-pill-bg)",
                  color: active ? "#0a0a0a" : "var(--nh-text-2)",
                }}
              >
                {s.label}
                {s.count > 0 && (
                  <span
                    className="text-[9px] px-1 rounded-sm"
                    style={{
                      background: active ? "rgba(0,0,0,0.25)" : "var(--nh-accent)",
                      color: active ? "#fff" : "#0a0a0a",
                    }}
                  >
                    {s.count}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
        <div className="flex-1 overflow-auto px-3.5 pt-3 pb-20">
          {activeSection === "tags" && (
            <FilterMulti search={tagSearch} setSearch={setTagSearch} placeholder="search tags…"
              options={dataset.allTags} selected={filters.tags}
              onToggle={(v) => toggle("tags", v)} counts={dataset.tagCounts}
              mode={filters.matchModes.tags} onModeChange={(m) => setMode("tags", m)} />
          )}
          {activeSection === "characters" && (
            <FilterMulti options={dataset.allCharacters} selected={filters.characters}
              onToggle={(v) => toggle("characters", v)} counts={dataset.charCounts} placeholder="search characters…"
              mode={filters.matchModes.characters} onModeChange={(m) => setMode("characters", m)} />
          )}
          {activeSection === "parodies" && (
            <FilterMulti options={dataset.allParodies} selected={filters.parodies}
              onToggle={(v) => toggle("parodies", v)} counts={dataset.parodyCounts} placeholder="search parodies…"
              mode={filters.matchModes.parodies} onModeChange={(m) => setMode("parodies", m)} />
          )}
          {activeSection === "artists" && (
            <FilterMulti options={dataset.allArtists} selected={filters.artists}
              onToggle={(v) => toggle("artists", v)} counts={dataset.artistCounts} placeholder="search artists…"
              mode={filters.matchModes.artists} onModeChange={(m) => setMode("artists", m)} />
          )}
          {activeSection === "groups" && (
            <FilterMulti options={dataset.allGroups} selected={filters.groups}
              onToggle={(v) => toggle("groups", v)} counts={dataset.groupCounts} placeholder="search groups…"
              mode={filters.matchModes.groups} onModeChange={(m) => setMode("groups", m)} />
          )}
          {activeSection === "pages" && <FilterPageRange filters={filters} setFilters={setFilters} min={dataset.pageMin} max={dataset.pageMax} />}
          {activeSection === "status" && <FilterStatus filters={filters} setFilters={setFilters} />}
          {activeSection === "sort" && <FilterSort filters={filters} setFilters={setFilters} />}
        </div>
        <div className="sticky bottom-0 px-3.5 py-2.5 bg-nh-surface border-t border-nh-border">
          <Button
            onClick={onClose}
            className="w-full h-10 rounded-lg bg-nh-accent text-[#0a0a0a] font-display font-bold text-[13px] hover:bg-nh-accent/90"
            style={{ letterSpacing: "-0.01em" }}
          >
            show {dataset.matchingCount ?? 0} results
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FilterMulti({ options, selected, onToggle, counts, placeholder, mode, onModeChange, search: searchProp, setSearch: setSearchProp }: {
  options: string[]; selected: string[]; onToggle: (v: string) => void;
  counts: Record<string, number>; placeholder: string;
  mode?: MatchMode; onModeChange?: (m: MatchMode) => void;
  search?: string; setSearch?: (s: string) => void;
}) {
  const [searchLocal, setSearchLocal] = useState("");
  const [optSort, setOptSort] = useState<OptionSort>("count-desc");
  const search = searchProp !== undefined ? searchProp : searchLocal;
  const setSearch = setSearchProp || setSearchLocal;
  const filtered = useMemo(() => {
    const ordered = sortOptions(options, counts, optSort);
    const q = search.toLowerCase();
    return q ? ordered.filter(o => o.toLowerCase().includes(q)) : ordered;
  }, [options, counts, search, optSort]);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-nh-text-3 pointer-events-none" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={placeholder}
          className="h-8 rounded-md bg-nh-input border-nh-border pl-7 font-mono text-[11px] text-nh-text-1"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">sort</span>
        <OptionSortToggle value={optSort} onChange={setOptSort} />
      </div>
      {mode && onModeChange && selected.length >= 2 && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">match</span>
          <MatchToggle mode={mode} onChange={onModeChange} />
          <span className="font-mono text-[9px] text-nh-text-3">
            {mode === "and" ? "has all selected" : "has any selected"}
          </span>
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map(s => (
            <Badge
              key={s}
              onClick={() => onToggle(s)}
              className="h-auto cursor-pointer rounded-sm border-0 bg-nh-accent px-1.5 py-1 font-mono text-[10px] font-semibold text-[#0a0a0a] gap-1 hover:bg-nh-accent/90"
            >
              {s}
              <X className="size-2.25" strokeWidth={2.4} />
            </Badge>
          ))}
        </div>
      )}
      <div className="flex flex-col">
        {filtered.slice(0, 60).map(o => {
          const isSel = selected.includes(o);
          return (
            <button
              key={o}
              onClick={() => onToggle(o)}
              className="flex items-center gap-2 py-2 px-1 text-left border-b border-nh-border"
            >
              {/* Presentational only — see SidebarMulti in Desktop.tsx: a
                  handler here would double-toggle with the row's onClick. */}
              <Checkbox
                checked={isSel}
                tabIndex={-1}
                className="size-4 rounded-sm shrink-0 pointer-events-none"
              />
              <span className="flex-1 font-mono text-xs text-nh-text-1 tracking-wide">{o}</span>
              <span className="font-mono text-[10px] text-nh-text-3">{counts?.[o] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterPageRange({ filters, setFilters, min, max }: {
  filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>; min: number; max: number;
}) {
  return (
    <div className="flex flex-col gap-4 px-1 py-2">
      <div className="font-mono text-[11px] text-nh-text-3 tracking-wide">page count</div>
      <div className="flex items-baseline gap-2">
        <span className="font-display font-bold text-nh-accent text-[28px]" style={{ letterSpacing: "-0.02em" }}>{filters.pageMin}</span>
        <span className="font-mono text-[11px] text-nh-text-3">to</span>
        <span className="font-display font-bold text-nh-accent text-[28px]" style={{ letterSpacing: "-0.02em" }}>{filters.pageMax}</span>
        <span className="font-mono text-[11px] text-nh-text-3">pages</span>
      </div>
      <div className="flex flex-col gap-3 pt-2">
        <Slider
          min={min}
          // `|| 1` guards the empty-library case (pageMax 0) so the slider
          // never degenerates to min == max == 0 — mirrors the desktop sidebar.
          max={max || 1}
          value={[filters.pageMin, filters.pageMax]}
          onValueChange={(v: number | readonly number[]) => {
            const arr = Array.isArray(v) ? v : [v as number, v as number];
            setFilters(f => ({ ...f, pageMin: arr[0], pageMax: arr[1] }));
          }}
        />
        <div className="flex justify-between font-mono text-[10px] text-nh-text-3 tracking-wide">
          <span>min {min}</span>
          <span>max {max}</span>
        </div>
      </div>
    </div>
  );
}

export const READ_OPTIONS: { id: ReadFilter; label: string; sub: string }[] = [
  { id: "all", label: "all", sub: "everything" },
  { id: "unread", label: "unread", sub: "never opened" },
  { id: "read", label: "read", sub: "opened before" },
];

function FilterStatus({ filters, setFilters }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>> }) {
  return (
    <div className="py-1">
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5">read status</div>
      <div className="grid grid-cols-3 rounded-lg border border-nh-border bg-nh-input p-0.75">
        {READ_OPTIONS.map(o => {
          const sel = filters.read === o.id;
          return (
            <Button
              key={o.id}
              onClick={() => setFilters(f => ({ ...f, read: o.id }))}
              variant="ghost"
              className="flex flex-col items-start gap-0.5 h-auto px-2.5 py-2 rounded-md text-left whitespace-normal"
              style={{
                background: sel ? "var(--nh-accent)" : "transparent",
                color: sel ? "#0a0a0a" : "var(--nh-text-2)",
              }}
            >
              <span className="font-display font-bold text-xs" style={{ letterSpacing: "-0.01em" }}>{o.label}</span>
              <span
                className="font-mono text-[9px]"
                style={{ color: sel ? "rgba(0,0,0,0.55)" : "var(--nh-text-3)", letterSpacing: "0.02em" }}
              >
                {o.sub}
              </span>
            </Button>
          );
        })}
      </div>

      <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5 mt-3.5">alter name</div>
      <Button
        onClick={() => setFilters(f => ({ ...f, noAlter: !f.noAlter }))}
        variant="ghost"
        className="flex flex-col items-start gap-0.5 h-auto w-full px-2.5 py-2 rounded-lg border border-nh-border text-left whitespace-normal"
        style={{
          background: filters.noAlter ? "var(--nh-accent)" : "var(--nh-input)",
          color: filters.noAlter ? "#0a0a0a" : "var(--nh-text-2)",
        }}
      >
        <span className="font-display font-bold text-xs" style={{ letterSpacing: "-0.01em" }}>only without alter name</span>
        <span
          className="font-mono text-[9px]"
          style={{ color: filters.noAlter ? "rgba(0,0,0,0.55)" : "var(--nh-text-3)", letterSpacing: "0.02em" }}
        >
          titles missing a manual alter name
        </span>
      </Button>
    </div>
  );
}

function FilterSort({ filters, setFilters }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>> }) {
  const fields = SORT_FIELDS;
  const isRandom = filters.sortField === "random";
  return (
    <div className="flex flex-col gap-3.5 py-1">
      <div>
        <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5">direction</div>
        <div
          className="grid grid-cols-2 rounded-lg border border-nh-border bg-nh-input p-0.75"
          style={{ opacity: isRandom ? 0.4 : 1, pointerEvents: isRandom ? "none" : "auto" }}
        >
          {[
            { id: "desc" as const, label: "high → low", sub: "newest · most · biggest" },
            { id: "asc" as const, label: "low → high", sub: "oldest · least · smallest" },
          ].map(d => {
            const sel = filters.sortDir === d.id;
            return (
              <Button
                key={d.id}
                onClick={() => setFilters(f => ({ ...f, sortDir: d.id }))}
                variant="ghost"
                className="flex flex-col items-start gap-0.5 h-auto px-2.5 py-2 rounded-md text-left whitespace-normal"
                style={{
                  background: sel ? "var(--nh-accent)" : "transparent",
                  color: sel ? "#0a0a0a" : "var(--nh-text-2)",
                }}
              >
                <span className="font-display font-bold text-xs" style={{ letterSpacing: "-0.01em" }}>{d.label}</span>
                <span
                  className="font-mono text-[9px]"
                  style={{ color: sel ? "rgba(0,0,0,0.55)" : "var(--nh-text-3)", letterSpacing: "0.02em" }}
                >
                  {d.sub}
                </span>
              </Button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5">sort by field</div>
        <div className="flex flex-col">
          {fields.map(o => {
            const sel = filters.sortField === o.id;
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                onClick={() => setFilters(f => ({ ...f, sortField: o.id }))}
                className="flex items-center gap-2.5 py-2.5 px-1.5 text-left border-b border-nh-border"
              >
                <Icon className="size-3.5" style={{ color: sel ? "var(--nh-accent)" : "var(--nh-text-3)" }} />
                <span
                  className="flex-1 font-mono text-xs"
                  style={{ color: sel ? "var(--nh-accent)" : "var(--nh-text-1)", fontWeight: sel ? 600 : 400 }}
                >
                  {o.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
