"use client";

import { useState } from "react";
import { NhIcon } from "./Primitives";
import { GalleryCard } from "./Gallery";
import { StatsView } from "./Stats";
import { DetailModal } from "./DetailModal";
import { AddModal } from "./AddModal";
import type { Item, ReadLog } from "../lib/data";
import type { Filters, Dataset } from "./HeaderFilter";

export function NhdbDesktop({
  collection, filtered, dataset,
  search, setSearch, filters, setFilters,
  detailItem, setDetailItem, addOpen, setAddOpen,
  view, setView, onTagClick, onChipClick, onDelete, onRead, onAlterName,
  recentAdds, density, onAddItems, readLogs,
}: {
  collection: Item[]; filtered: Item[]; dataset: Dataset;
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
  readLogs: ReadLog[];
}) {
  const activeFilterCount =
    filters.tags.length + filters.characters.length +
    filters.parodies.length + filters.artists.length + filters.groups.length +
    ((filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0);

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--nh-bg)", color: "var(--nh-text-1)", display: "flex", flexDirection: "column" }}>
      <DesktopHeader search={search} setSearch={setSearch} onAdd={() => setAddOpen(true)} view={view} setView={setView} />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <DesktopSidebar
          filters={filters} setFilters={setFilters}
          dataset={dataset} activeFilterCount={activeFilterCount}
          matchingCount={filtered.length} totalCount={collection.length}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 60px", minWidth: 0 }}>
          {view === "gallery" && (
            <DesktopGallery filtered={filtered} totalCount={collection.length}
              filters={filters} onOpen={setDetailItem} onTagClick={onTagClick}
              density={density} />
          )}
          {view === "stats" && <StatsView collection={collection} dataset={dataset} onTagClick={onTagClick} readLogs={readLogs} />}
        </div>
      </div>

      {detailItem && (
        <CenteredModal onClose={() => setDetailItem(null)} width={920} maxHeight="88vh">
          <DetailModal
            item={detailItem}
            onClose={() => setDetailItem(null)}
            onTagClick={onChipClick}
            onDelete={onDelete}
            onRead={onRead}
            onOpen={setDetailItem}
            onAlterName={onAlterName}
            allItems={collection}
            embedded
          />
        </CenteredModal>
      )}
      {addOpen && (
        <CenteredModal onClose={() => setAddOpen(false)} width={620} maxHeight="80vh">
          <AddModal open onClose={() => setAddOpen(false)} recentAdds={recentAdds} embedded onAdd={onAddItems} />
        </CenteredModal>
      )}
    </div>
  );
}

function DesktopHeader({ search, setSearch, onAdd, view, setView }: {
  search: string; setSearch: (s: string) => void; onAdd: () => void;
  view: "gallery" | "stats"; setView: (v: "gallery" | "stats") => void;
}) {
  return (
    <div style={{
      height: 56, flexShrink: 0,
      display: "flex", alignItems: "center", gap: 16,
      padding: "0 24px",
      borderBottom: "1px solid var(--nh-border)",
      background: "var(--nh-bg-blur)",
      backdropFilter: "blur(14px) saturate(160%)",
      position: "sticky", top: 0, zIndex: 30,
    }}>
      <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--nh-text-1)", display: "flex", alignItems: "center", gap: 4 }}>
        <span>nh</span>
        <span style={{ color: "var(--nh-accent)" }}>db</span>
      </div>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 500, color: "var(--nh-text-3)", letterSpacing: "0.06em", padding: "3px 6px", borderRadius: 3, background: "var(--nh-pill-bg)", textTransform: "uppercase" }}>local · v1</div>

      <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
        {([
          { id: "gallery" as const, label: "library", icon: "grid" as const },
          { id: "stats" as const, label: "analysis", icon: "stats" as const },
        ]).map(t => {
          const sel = view === t.id;
          return (
            <button key={t.id} onClick={() => setView(t.id)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              height: 32, padding: "0 12px", borderRadius: 6,
              background: sel ? "var(--nh-accent-soft)" : "transparent",
              color: sel ? "var(--nh-accent)" : "var(--nh-text-2)",
              display: "flex", alignItems: "center", gap: 6,
              fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 600,
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}>
              <NhIcon name={t.icon} size={13} color={sel ? "var(--nh-accent)" : "var(--nh-text-2)"} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{
        width: 360, height: 34, borderRadius: 8,
        background: "var(--nh-input-bg)",
        border: "1px solid var(--nh-border)",
        display: "flex", alignItems: "center", padding: "0 10px",
      }}>
        <NhIcon name="search" size={14} color="var(--nh-text-3)" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search title, artist, tag, hashtag…" style={{
          flex: 1, background: "transparent", border: 0, outline: "none",
          color: "var(--nh-text-1)",
          fontFamily: "var(--nh-font-mono)", fontSize: 12,
          padding: "0 8px", letterSpacing: "0.01em",
        }} />
        <kbd style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", padding: "2px 5px", borderRadius: 3, background: "var(--nh-pill-bg)", border: "1px solid var(--nh-border)" }}>⌘K</kbd>
      </div>

      <button onClick={onAdd} style={{
        appearance: "none", border: 0, cursor: "pointer",
        height: 34, padding: "0 14px", borderRadius: 8,
        background: "var(--nh-accent)", color: "#0a0a0a",
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 700,
        letterSpacing: "-0.01em",
      }}>
        <NhIcon name="plus" size={14} color="#0a0a0a" stroke={2.4} />
        add titles
      </button>
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
    <div style={{
      width: 280, flexShrink: 0,
      borderRight: "1px solid var(--nh-border)",
      overflow: "auto",
      padding: "16px 0 60px",
      background: "var(--nh-surface)",
    }}>
      <div style={{ padding: "0 16px 14px", display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 22, fontWeight: 800, color: "var(--nh-accent)", letterSpacing: "-0.02em", lineHeight: 1 }}>{matchingCount}</span>
        <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>/ {totalCount} titles</span>
        <div style={{ flex: 1 }} />
        {activeFilterCount > 0 && (
          <button onClick={clearAll} style={{
            appearance: "none", border: 0, background: "transparent", cursor: "pointer",
            color: "var(--nh-text-3)",
            fontFamily: "var(--nh-font-mono)", fontSize: 9.5,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>clear ×{activeFilterCount}</button>
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
        <div style={{ padding: "4px 0" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
            <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 18, fontWeight: 700, color: "var(--nh-accent)", letterSpacing: "-0.02em" }}>{filters.pageMin}</span>
            <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)" }}>—</span>
            <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 18, fontWeight: 700, color: "var(--nh-accent)", letterSpacing: "-0.02em" }}>{filters.pageMax}</span>
            <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)" }}>pages</span>
          </div>
          <input type="range" min={0} max={dataset.pageMax} value={filters.pageMin}
            onChange={e => setFilters(f => ({ ...f, pageMin: Math.min(+e.target.value, f.pageMax) }))} className="nh-range" />
          <input type="range" min={0} max={dataset.pageMax} value={filters.pageMax}
            onChange={e => setFilters(f => ({ ...f, pageMax: Math.max(+e.target.value, f.pageMin) }))} className="nh-range" />
        </div>
      </SidebarGroup>
    </div>
  );
}

function SidebarGroup({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: "1px solid var(--nh-border)" }}>
      <button onClick={onToggle} style={{
        appearance: "none", border: 0, cursor: "pointer", background: "transparent",
        width: "100%", textAlign: "left",
        padding: "11px 16px",
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--nh-font-mono)", fontSize: 10, fontWeight: 600,
        color: "var(--nh-text-2)", letterSpacing: "0.08em", textTransform: "uppercase",
      }}>
        <NhIcon name={open ? "chevron-down" : "chevron-right"} size={12} color="var(--nh-text-3)" />
        <span style={{ flex: 1 }}>{title}</span>
      </button>
      {open && <div style={{ padding: "0 16px 14px" }}>{children}</div>}
    </div>
  );
}

function SidebarMulti({ options, counts, selected, onToggle, placeholder, defaultLimit }: {
  options: string[]; counts: Record<string, number>; selected: string[];
  onToggle: (v: string) => void; placeholder: string; defaultLimit: number;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const sorted = [...options].sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  const filtered = sorted.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const limit = showAll ? 999 : defaultLimit;
  const visible = filtered.slice(0, limit);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        height: 28, borderRadius: 6,
        background: "var(--nh-input-bg)",
        border: "1px solid var(--nh-border)",
        display: "flex", alignItems: "center", padding: "0 8px",
      }}>
        <NhIcon name="search" size={11} color="var(--nh-text-3)" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={placeholder} style={{
          flex: 1, background: "transparent", border: 0, outline: "none",
          color: "var(--nh-text-1)",
          fontFamily: "var(--nh-font-mono)", fontSize: 11, padding: "0 6px",
        }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {visible.map(o => {
          const sel = selected.includes(o);
          return (
            <button key={o} onClick={() => onToggle(o)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 7,
              padding: "5px 4px", background: sel ? "var(--nh-accent-soft)" : "transparent",
              borderRadius: 4, textAlign: "left",
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: 2,
                border: `1.5px solid ${sel ? "var(--nh-accent)" : "var(--nh-border-strong)"}`,
                background: sel ? "var(--nh-accent)" : "transparent",
                flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {sel && <NhIcon name="check" size={9} color="#0a0a0a" stroke={3}/>}
              </div>
              <span style={{
                flex: 1, minWidth: 0,
                fontFamily: "var(--nh-font-mono)", fontSize: 11,
                color: sel ? "var(--nh-accent)" : "var(--nh-text-1)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{o}</span>
              <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)" }}>{counts?.[o] ?? 0}</span>
            </button>
          );
        })}
      </div>
      {filtered.length > defaultLimit && (
        <button onClick={() => setShowAll(s => !s)} style={{
          appearance: "none", border: 0, background: "transparent", cursor: "pointer",
          fontFamily: "var(--nh-font-mono)", fontSize: 10,
          color: "var(--nh-accent)", letterSpacing: "0.04em",
          textTransform: "uppercase", textAlign: "left", padding: "4px 0 0",
        }}>{showAll ? `show top ${defaultLimit}` : `show all ${filtered.length}`}</button>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <select value={filters.sortField} onChange={e => setFilters(f => ({ ...f, sortField: e.target.value }))} style={{
        appearance: "none", WebkitAppearance: "none",
        height: 30, padding: "0 28px 0 10px", borderRadius: 6,
        background: "var(--nh-input-bg)",
        border: "1px solid var(--nh-border)",
        color: "var(--nh-text-1)",
        fontFamily: "var(--nh-font-mono)", fontSize: 11,
        outline: "none", cursor: "pointer",
        backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
      }}>
        {fields.map(f => <option key={f.id} value={f.id} style={{ background: "#1a160c" }}>{f.label}</option>)}
      </select>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0,
        background: "var(--nh-input-bg)",
        border: "1px solid var(--nh-border)",
        borderRadius: 6, padding: 2,
        opacity: isRandom ? 0.4 : 1,
        pointerEvents: isRandom ? "none" : "auto",
      }}>
        {([
          { id: "desc" as const, label: "high → low" },
          { id: "asc" as const, label: "low → high" },
        ]).map(d => {
          const sel = filters.sortDir === d.id;
          return (
            <button key={d.id} onClick={() => setFilters(f => ({ ...f, sortDir: d.id }))} style={{
              appearance: "none", border: 0, cursor: "pointer",
              height: 26, borderRadius: 4,
              background: sel ? "var(--nh-accent)" : "transparent",
              color: sel ? "#0a0a0a" : "var(--nh-text-2)",
              fontFamily: "var(--nh-font-mono)", fontSize: 10, fontWeight: 600,
              letterSpacing: "0.02em",
            }}>{d.label}</button>
          );
        })}
      </div>
    </div>
  );
}

function DesktopGallery({ filtered, totalCount, filters, onOpen, onTagClick, density }: {
  filtered: Item[]; totalCount: number; filters: Filters;
  onOpen: (i: Item) => void; onTagClick: (t: string) => void;
  density: "comfortable" | "compact";
}) {
  const cols = density === "compact" ? 6 : 5;
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontFamily: "var(--nh-font-display)", fontSize: 26, fontWeight: 800, color: "var(--nh-text-1)", letterSpacing: "-0.03em" }}>library</h1>
        <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>{filtered.length} of {totalCount} · sort {filters.sortField.replace(/-/g, " ")} · {filters.sortDir}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 14 }}>
        {filtered.map(item => (
          <GalleryCard key={item.hashtag} item={item} onOpen={onOpen} onTagClick={onTagClick} density="comfortable" />
        ))}
      </div>
      {filtered.length === 0 && (
        <div style={{ padding: 60, textAlign: "center", color: "var(--nh-text-3)", fontFamily: "var(--nh-font-mono)", fontSize: 12 }}>no results · adjust filters</div>
      )}
    </>
  );
}

function CenteredModal({ children, onClose, width, maxHeight }: { children: React.ReactNode; onClose: () => void; width: number; maxHeight: string }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "nhFadeIn 200ms ease",
      padding: 32,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxWidth: "95vw", height: maxHeight, maxHeight,
        background: "var(--nh-surface)",
        borderRadius: 14,
        border: "1px solid var(--nh-border)",
        overflow: "hidden",
        display: "flex", flexDirection: "column",
        position: "relative",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        animation: "nhPopIn 240ms cubic-bezier(0.2, 0.9, 0.3, 1.1)",
      }}>{children}</div>
    </div>
  );
}
