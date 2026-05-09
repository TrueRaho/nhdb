"use client";

import { useMemo, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, LayoutGrid, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { GalleryCard } from "./Gallery";
import { StatsView } from "./Stats";
import { DetailModal } from "./DetailModal";
import { AddModal } from "./AddModal";
import type { Item } from "../lib/data";
import type { Filters, Dataset } from "./HeaderFilter";

export function NhdbDesktop({
  items, total, totalEver, dataset,
  search, setSearch, filters, setFilters,
  detailItem, setDetailItem, addOpen, setAddOpen,
  view, setView, onTagClick, onChipClick, onDelete, onRead, onAlterName,
  recentAdds, density, onAddItems, loading, onLoadMore,
}: {
  items: Item[]; total: number; totalEver: number; dataset: Dataset;
  search: string; setSearch: (s: string) => void;
  filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  detailItem: Item | null; setDetailItem: (i: Item | null) => void;
  addOpen: boolean; setAddOpen: (b: boolean) => void;
  view: "gallery" | "stats"; setView: (v: "gallery" | "stats") => void;
  onTagClick: (t: string) => void;
  onChipClick: (group: string, val: string) => void;
  onDelete: () => void;
  onRead: () => void;
  onAlterName: (value: string) => void;
  recentAdds: Item[]; density: "comfortable" | "compact";
  onAddItems: (items: Item[]) => void;
  loading: boolean; onLoadMore: () => void;
}) {
  const activeFilterCount = useMemo(() =>
    filters.tags.length + filters.characters.length +
    filters.parodies.length + filters.artists.length + filters.groups.length +
    ((filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0),
  [filters, dataset.pageMin, dataset.pageMax]);

  return (
    <div className="w-full min-h-screen flex flex-col bg-nh-bg text-nh-text-1">
      <DesktopHeader search={search} setSearch={setSearch} onAdd={() => setAddOpen(true)} view={view} setView={setView} />

      <div className="flex flex-1 min-h-0">
        <DesktopSidebar
          filters={filters} setFilters={setFilters}
          dataset={dataset} activeFilterCount={activeFilterCount}
          matchingCount={total} totalCount={totalEver}
        />
        <div className="flex-1 overflow-auto px-7 pt-5 pb-16 min-w-0">
          {view === "gallery" && (
            <DesktopGallery items={items} total={total} totalCount={totalEver}
              filters={filters} onOpen={setDetailItem} onTagClick={onTagClick}
              density={density} loading={loading} onLoadMore={onLoadMore} />
          )}
          {view === "stats" && <StatsView dataset={dataset} onTagClick={onTagClick} />}
        </div>
      </div>

      <Dialog open={!!detailItem} onOpenChange={(o: boolean) => { if (!o) setDetailItem(null); }}>
        <DialogContent
          showCloseButton={false}
          className="bg-nh-surface border-nh-border p-0 max-w-none w-[920px] sm:max-w-[920px] h-[88vh] max-h-[88vh] rounded-2xl overflow-hidden gap-0"
        >
          <DialogTitle className="sr-only">Title detail</DialogTitle>
          <DialogDescription className="sr-only">Detailed information about the selected title.</DialogDescription>
          {detailItem && (
            <DetailModal
              item={detailItem}
              onClose={() => setDetailItem(null)}
              onTagClick={onChipClick}
              onDelete={onDelete}
              onRead={onRead}
              onOpen={setDetailItem}
              onAlterName={onAlterName}
              embedded
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={(o: boolean) => { if (!o) setAddOpen(false); }}>
        <DialogContent
          showCloseButton={false}
          className="bg-nh-surface border-nh-border p-0 max-w-none w-[620px] sm:max-w-[620px] h-[80vh] max-h-[80vh] rounded-2xl overflow-hidden gap-0"
        >
          <DialogTitle className="sr-only">Add titles</DialogTitle>
          <DialogDescription className="sr-only">Add new titles to your collection.</DialogDescription>
          <AddModal open onClose={() => setAddOpen(false)} recentAdds={recentAdds} embedded onAdd={onAddItems} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DesktopHeader({ search, setSearch, onAdd, view, setView }: {
  search: string; setSearch: (s: string) => void; onAdd: () => void;
  view: "gallery" | "stats"; setView: (v: "gallery" | "stats") => void;
}) {
  return (
    <div
      className="h-14 shrink-0 flex items-center gap-4 px-6 border-b border-nh-border sticky top-0 z-30"
      style={{
        background: "var(--nh-bg-blur)",
        backdropFilter: "blur(14px) saturate(160%)",
      }}
    >
      <div
        className="font-display font-extrabold text-nh-text-1 flex items-center gap-1"
        style={{ fontSize: 22, letterSpacing: "-0.04em" }}
      >
        <span>nh</span>
        <span className="text-nh-accent">db</span>
      </div>
      <Badge
        variant="secondary"
        className="h-auto rounded-sm border-0 bg-nh-pill px-1.5 py-[3px] font-mono text-[9px] font-medium uppercase tracking-wider text-nh-text-3"
      >
      </Badge>

      <div className="flex gap-1 ml-4">
        {([
          { id: "gallery" as const, label: "library", icon: LayoutGrid },
          { id: "stats" as const, label: "analysis", icon: BarChart3 },
        ]).map(t => {
          const sel = view === t.id;
          const Icon = t.icon;
          return (
            <Button
              key={t.id}
              onClick={() => setView(t.id)}
              variant="ghost"
              className="h-8 px-3 rounded-md gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide hover:bg-transparent"
              style={{
                background: sel ? "var(--nh-accent-soft)" : "transparent",
                color: sel ? "var(--nh-accent)" : "var(--nh-text-2)",
              }}
            >
              <Icon className="size-[13px]" />
              {t.label}
            </Button>
          );
        })}
      </div>

      <div className="flex-1" />

      <div className="relative w-[360px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-nh-text-3 pointer-events-none" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="search title, artist, tag, hashtag…"
          className="h-[34px] rounded-lg bg-nh-input border-nh-border pl-8 pr-12 font-mono text-xs tracking-wide text-nh-text-1 placeholder:text-nh-text-3"
        />
        <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[9.5px] text-nh-text-3 px-1.5 py-0.5 rounded-sm bg-nh-pill border border-nh-border">⌘K</kbd>
      </div>

      <Button
        onClick={onAdd}
        className="h-[34px] px-3.5 rounded-lg bg-nh-accent text-[#0a0a0a] gap-1.5 font-display font-bold text-xs hover:bg-nh-accent/90"
        style={{ letterSpacing: "-0.01em" }}
      >
        <Plus className="size-3.5" strokeWidth={2.4} />
        add titles
      </Button>
    </div>
  );
}

function DesktopSidebar({ filters, setFilters, dataset, activeFilterCount, matchingCount, totalCount }: {
  filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  dataset: Dataset; activeFilterCount: number; matchingCount: number; totalCount: number;
}) {
  const [openSection, setOpenSection] = useState<Record<string, boolean>>({
    sort: true, tags: true, artists: false, groups: false, characters: false, parodies: false, pages: true,
  });
  const tog = (k: string) => setOpenSection(s => ({ ...s, [k]: !s[k] }));

  const toggle = (key: keyof Filters, val: string) => {
    setFilters(f => {
      const list = f[key] as string[];
      return { ...f, [key]: list.includes(val) ? list.filter(x => x !== val) : [...list, val] } as Filters;
    });
  };

  const clearAll = () => setFilters({
    tags: [], characters: [], parodies: [], artists: [], groups: [],
    pageMin: 0, pageMax: dataset.pageMax,
    sortField: "added-at", sortDir: "desc",
  });

  return (
    <div className="w-[280px] shrink-0 border-r border-nh-border overflow-auto pt-4 pb-16 bg-nh-surface">
      <div className="px-4 pb-3.5 flex items-baseline gap-1.5">
        <span
          className="font-display font-extrabold text-nh-accent leading-none"
          style={{ fontSize: 22, letterSpacing: "-0.02em" }}
        >
          {matchingCount}
        </span>
        <span className="font-mono text-[10px] text-nh-text-3">/ {totalCount} titles</span>
        <div className="flex-1" />
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            onClick={clearAll}
            className="h-auto p-0 font-mono text-[9.5px] uppercase tracking-wider text-nh-text-3 hover:bg-transparent"
          >
            clear ×{activeFilterCount}
          </Button>
        )}
      </div>

      <SidebarGroup title="sort" open={openSection.sort} onToggle={() => tog("sort")}>
        <SortControl filters={filters} setFilters={setFilters} />
      </SidebarGroup>

      <SidebarGroup title={`tags · ${filters.tags.length}`} open={openSection.tags} onToggle={() => tog("tags")}>
        <SidebarMulti options={dataset.allTags} counts={dataset.tagCounts} selected={filters.tags} onToggle={v => toggle("tags", v)} placeholder="search tags…" defaultLimit={10} />
      </SidebarGroup>

      <SidebarGroup title={`artists · ${filters.artists.length}`} open={openSection.artists} onToggle={() => tog("artists")}>
        <SidebarMulti options={dataset.allArtists} counts={dataset.artistCounts} selected={filters.artists} onToggle={v => toggle("artists", v)} placeholder="search artists…" defaultLimit={8} />
      </SidebarGroup>

      <SidebarGroup title={`groups · ${filters.groups.length}`} open={openSection.groups} onToggle={() => tog("groups")}>
        <SidebarMulti options={dataset.allGroups} counts={dataset.groupCounts} selected={filters.groups} onToggle={v => toggle("groups", v)} placeholder="search groups…" defaultLimit={8} />
      </SidebarGroup>

      <SidebarGroup title={`characters · ${filters.characters.length}`} open={openSection.characters} onToggle={() => tog("characters")}>
        <SidebarMulti options={dataset.allCharacters} counts={dataset.charCounts} selected={filters.characters} onToggle={v => toggle("characters", v)} placeholder="search characters…" defaultLimit={8} />
      </SidebarGroup>

      <SidebarGroup title={`parodies · ${filters.parodies.length}`} open={openSection.parodies} onToggle={() => tog("parodies")}>
        <SidebarMulti options={dataset.allParodies} counts={dataset.parodyCounts} selected={filters.parodies} onToggle={v => toggle("parodies", v)} placeholder="search parodies…" defaultLimit={8} />
      </SidebarGroup>

      <SidebarGroup title="pages" open={openSection.pages} onToggle={() => tog("pages")}>
        <div className="py-1">
          <div className="flex items-baseline gap-1.5 mb-2">
            <span
              className="font-display font-bold text-nh-accent text-[18px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {filters.pageMin}
            </span>
            <span className="font-mono text-[9px] text-nh-text-3">—</span>
            <span
              className="font-display font-bold text-nh-accent text-[18px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {filters.pageMax}
            </span>
            <span className="font-mono text-[9px] text-nh-text-3">pages</span>
          </div>
          <Slider
            min={0}
            max={dataset.pageMax || 1}
            value={[filters.pageMin, filters.pageMax]}
            onValueChange={(v: number | readonly number[]) => {
              const arr = Array.isArray(v) ? v : [v as number, v as number];
              setFilters(f => ({ ...f, pageMin: arr[0], pageMax: arr[1] }));
            }}
          />
        </div>
      </SidebarGroup>
    </div>
  );
}

function SidebarGroup({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-nh-border">
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger
          render={
            <button className="w-full text-left px-4 py-2.5 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-nh-text-2 cursor-pointer">
              {open ? (
                <ChevronDown className="size-3 text-nh-text-3" />
              ) : (
                <ChevronRight className="size-3 text-nh-text-3" />
              )}
              <span className="flex-1">{title}</span>
            </button>
          }
        />
        <CollapsibleContent className="px-4 pb-3.5">
          {children}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SidebarMulti({ options, counts, selected, onToggle, placeholder, defaultLimit }: {
  options: string[]; counts: Record<string, number>; selected: string[];
  onToggle: (v: string) => void; placeholder: string; defaultLimit: number;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...options].sort((a, b) => (counts[b] || 0) - (counts[a] || 0)),
    [options, counts]
  );
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? sorted.filter(o => o.toLowerCase().includes(q)) : sorted;
  }, [sorted, search]);
  const limit = showAll ? 999 : defaultLimit;
  const visible = filtered.slice(0, limit);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-nh-text-3 pointer-events-none" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={placeholder}
          className="h-7 rounded-md bg-nh-input border-nh-border pl-6 font-mono text-[11px] text-nh-text-1"
        />
      </div>
      <div className="flex flex-col gap-px">
        {visible.map(o => {
          const sel = selected.includes(o);
          return (
            <button
              key={o}
              onClick={() => onToggle(o)}
              className="flex items-center gap-1.5 px-1 py-1 text-left rounded-sm"
              style={{ background: sel ? "var(--nh-accent-soft)" : "transparent" }}
            >
              <Checkbox
                checked={sel}
                onCheckedChange={() => onToggle(o)}
                className="size-3 rounded-[2px] shrink-0"
              />
              <span
                className="flex-1 min-w-0 font-mono text-[11px] truncate"
                style={{ color: sel ? "var(--nh-accent)" : "var(--nh-text-1)" }}
              >
                {o}
              </span>
              <span className="font-mono text-[9.5px] text-nh-text-3">{counts?.[o] ?? 0}</span>
            </button>
          );
        })}
      </div>
      {filtered.length > defaultLimit && (
        <Button
          variant="ghost"
          onClick={() => setShowAll(s => !s)}
          className="h-auto p-0 self-start font-mono text-[10px] uppercase tracking-wider text-nh-accent hover:bg-transparent"
        >
          {showAll ? `show top ${defaultLimit}` : `show all ${filtered.length}`}
        </Button>
      )}
    </div>
  );
}

function SortControl({ filters, setFilters }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>> }) {
  const fields = [
    { id: "added-at", label: "date added" },
    { id: "last-read-at", label: "last read" },
    { id: "uploaded-at", label: "upload date" },
    { id: "read-count", label: "read count" },
    { id: "pages", label: "pages" },
    { id: "tag-count", label: "tag count" },
    { id: "title", label: "title (a→z)" },
    { id: "artist", label: "artist" },
    { id: "group", label: "group" },
    { id: "parody", label: "parody" },
    { id: "hashtag", label: "hashtag" },
    { id: "random", label: "random" },
  ];
  const isRandom = filters.sortField === "random";
  return (
    <div className="flex flex-col gap-2">
      <Select value={filters.sortField} onValueChange={(v) => v && setFilters(f => ({ ...f, sortField: v }))}>
        <SelectTrigger className="h-[30px] w-full rounded-md bg-nh-input border-nh-border font-mono text-[11px] text-nh-text-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-nh-surface-2 border-nh-border">
          {fields.map(f => (
            <SelectItem key={f.id} value={f.id} className="font-mono text-[11px] text-nh-text-1">
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div
        className="grid grid-cols-2 rounded-md border border-nh-border bg-nh-input p-0.5"
        style={{ opacity: isRandom ? 0.4 : 1, pointerEvents: isRandom ? "none" : "auto" }}
      >
        {([
          { id: "desc" as const, label: "high → low" },
          { id: "asc" as const, label: "low → high" },
        ]).map(d => {
          const sel = filters.sortDir === d.id;
          return (
            <Button
              key={d.id}
              onClick={() => setFilters(f => ({ ...f, sortDir: d.id }))}
              variant="ghost"
              className="h-[26px] rounded-sm font-mono text-[10px] font-semibold tracking-wide hover:bg-transparent"
              style={{
                background: sel ? "var(--nh-accent)" : "transparent",
                color: sel ? "#0a0a0a" : "var(--nh-text-2)",
              }}
            >
              {d.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function DesktopGallery({ items, total, totalCount, filters, onOpen, onTagClick, density, loading, onLoadMore }: {
  items: Item[]; total: number; totalCount: number; filters: Filters;
  onOpen: (i: Item) => void; onTagClick: (t: string) => void;
  density: "comfortable" | "compact";
  loading: boolean; onLoadMore: () => void;
}) {
  const cols = density === "compact" ? "grid-cols-6" : "grid-cols-5";
  return (
    <>
      <div className="flex items-baseline gap-3 mb-4">
        <h1
          className="m-0 font-display font-extrabold text-nh-text-1"
          style={{ fontSize: 26, letterSpacing: "-0.03em" }}
        >
          library
        </h1>
        <span className="font-mono text-[11px] tracking-wide text-nh-text-3">
          {total} of {totalCount} · sort {filters.sortField.replace(/-/g, " ")} · {filters.sortDir}
        </span>
      </div>
      <div className={`grid ${cols} gap-3.5`}>
        {items.map(item => (
          <GalleryCard key={item.hashtag} item={item} onOpen={onOpen} onTagClick={onTagClick} density="comfortable" />
        ))}
      </div>
      {items.length < total && (
        <div className="flex justify-center mt-6">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-nh-pill font-mono text-[11px] text-nh-text-2 disabled:opacity-60"
          >
            {loading ? "loading…" : `load more (${total - items.length})`}
          </button>
        </div>
      )}
      {items.length === 0 && !loading && (
        <div className="py-16 text-center font-mono text-xs text-nh-text-3">no results · adjust filters</div>
      )}
    </>
  );
}
