"use client";

import { useState, type CSSProperties } from "react";
import { NhIcon } from "./Primitives";

export type Filters = {
  tags: string[]; characters: string[]; parodies: string[]; artists: string[];
  pageMin: number; pageMax: number;
  sortField: string; sortDir: "asc" | "desc";
};

export type Dataset = {
  allTags: string[]; allCharacters: string[]; allParodies: string[]; allArtists: string[];
  tagCounts: Record<string, number>; charCounts: Record<string, number>;
  parodyCounts: Record<string, number>; artistCounts: Record<string, number>;
  pageMin: number; pageMax: number; matchingCount?: number;
};

const iconBtnStyle: CSSProperties = {
  appearance: "none", border: 0, cursor: "pointer",
  height: 32, minWidth: 32, borderRadius: 8,
  background: "var(--nh-input-bg)", color: "var(--nh-text-1)",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: 0,
};

export function GalleryHeader({ search, setSearch, onAdd, onStats, statsActive, onOpenFilters, activeFilterCount }: {
  search: string; setSearch: (s: string) => void;
  onAdd: () => void; onStats: () => void; statsActive: boolean;
  onOpenFilters: () => void; activeFilterCount: number;
}) {
  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 40,
      background: "var(--nh-bg-blur)",
      backdropFilter: "blur(14px) saturate(160%)",
      WebkitBackdropFilter: "blur(14px) saturate(160%)",
      borderBottom: "1px solid var(--nh-border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px" }}>
        <div style={{
          fontFamily: "var(--nh-font-display)", fontSize: 22, fontWeight: 800,
          letterSpacing: "-0.04em", color: "var(--nh-text-1)",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <span>nh</span>
          <span style={{ color: "var(--nh-accent)" }}>db</span>
          <span style={{
            fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 500,
            color: "var(--nh-text-3)", letterSpacing: "0.06em",
            marginLeft: 4, padding: "2px 5px", borderRadius: 3,
            background: "var(--nh-pill-bg)", textTransform: "uppercase",
          }}>local</span>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={onStats} style={{ ...iconBtnStyle, background: statsActive ? "var(--nh-accent-soft)" : "var(--nh-input-bg)" }}>
          <NhIcon name="stats" size={16} color={statsActive ? "var(--nh-accent)" : "var(--nh-text-2)"} />
        </button>
        <button onClick={onAdd} style={{ ...iconBtnStyle, background: "var(--nh-accent)", color: "#0a0a0a" }}>
          <NhIcon name="plus" size={16} color="#0a0a0a" stroke={2.2} />
        </button>
      </div>
      <div style={{ padding: "0 12px 8px", display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{
          flex: 1, position: "relative", height: 36, borderRadius: 8,
          background: "var(--nh-input-bg)", border: "1px solid var(--nh-border)",
          display: "flex", alignItems: "center",
        }}>
          <div style={{ paddingLeft: 10, color: "var(--nh-text-3)", display: "flex" }}>
            <NhIcon name="search" size={14} color="var(--nh-text-3)" />
          </div>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search title, artist, tag…" style={{
            flex: 1, background: "transparent", border: 0, outline: "none",
            color: "var(--nh-text-1)",
            fontFamily: "var(--nh-font-mono)", fontSize: 12,
            padding: "0 10px", letterSpacing: "0.01em",
          }} />
          {search && (
            <button onClick={() => setSearch("")} style={{
              appearance: "none", border: 0, background: "transparent", cursor: "pointer",
              padding: "0 10px", color: "var(--nh-text-3)", display: "flex",
            }}>
              <NhIcon name="close" size={14} color="var(--nh-text-3)"/>
            </button>
          )}
        </div>
        <button onClick={onOpenFilters} style={{
          ...iconBtnStyle, position: "relative",
          background: activeFilterCount > 0 ? "var(--nh-accent-soft)" : "var(--nh-input-bg)",
          border: "1px solid var(--nh-border)",
          width: "auto", padding: "0 10px", gap: 6,
        }}>
          <NhIcon name="filter" size={14} color={activeFilterCount > 0 ? "var(--nh-accent)" : "var(--nh-text-2)"} />
          <span style={{
            fontFamily: "var(--nh-font-mono)", fontSize: 11,
            color: activeFilterCount > 0 ? "var(--nh-accent)" : "var(--nh-text-2)",
            letterSpacing: "0.04em",
          }}>{activeFilterCount > 0 ? activeFilterCount : "filter"}</span>
        </button>
      </div>
    </div>
  );
}

export function FilterSheet({ open, onClose, filters, setFilters, dataset }: {
  open: boolean; onClose: () => void;
  filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  dataset: Dataset;
}) {
  const [activeSection, setActiveSection] = useState<string>("tags");
  const [tagSearch, setTagSearch] = useState("");
  if (!open) return null;

  const sections = [
    { id: "tags", label: "tags", count: filters.tags.length },
    { id: "characters", label: "chars", count: filters.characters.length },
    { id: "parodies", label: "parodies", count: filters.parodies.length },
    { id: "artists", label: "artists", count: filters.artists.length },
    { id: "pages", label: "pages", count: (filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0 },
    { id: "sort", label: "sort", count: filters.sortField !== "added-at" || filters.sortDir !== "desc" ? 1 : 0 },
  ];

  const toggle = (key: keyof Filters, val: string) => {
    setFilters(f => {
      const list = f[key] as string[];
      return { ...f, [key]: list.includes(val) ? list.filter(x => x !== val) : [...list, val] } as Filters;
    });
  };

  const totalActive = filters.tags.length + filters.characters.length + filters.parodies.length + filters.artists.length;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
      background: "rgba(0,0,0,0.55)", animation: "nhFadeIn 200ms ease",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--nh-surface)",
        borderTopLeftRadius: 18, borderTopRightRadius: 18,
        maxHeight: "82%", display: "flex", flexDirection: "column",
        animation: "nhSlideUp 280ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        borderTop: "1px solid var(--nh-border)", position: "relative",
      }}>
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--nh-border-strong)" }} />
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 14px 10px",
          borderBottom: "1px solid var(--nh-border)",
        }}>
          <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 15, fontWeight: 700, color: "var(--nh-text-1)", letterSpacing: "-0.01em" }}>filters</div>
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>{totalActive} active</div>
          <div style={{ flex: 1 }} />
          <button onClick={() => setFilters({ tags: [], characters: [], parodies: [], artists: [], pageMin: 0, pageMax: dataset.pageMax, sortField: "added-at", sortDir: "desc" })} style={{
            appearance: "none", border: 0, background: "transparent", cursor: "pointer",
            color: "var(--nh-text-3)", fontFamily: "var(--nh-font-mono)", fontSize: 10,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>clear all</button>
          <button onClick={onClose} style={{
            appearance: "none", border: 0, background: "var(--nh-pill-bg)", cursor: "pointer",
            width: 26, height: 26, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <NhIcon name="close" size={13} color="var(--nh-text-2)"/>
          </button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "8px 12px", overflowX: "auto", borderBottom: "1px solid var(--nh-border)" }}>
          {sections.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              padding: "6px 10px", borderRadius: 6,
              background: activeSection === s.id ? "var(--nh-accent)" : "var(--nh-pill-bg)",
              color: activeSection === s.id ? "#0a0a0a" : "var(--nh-text-2)",
              fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 600,
              letterSpacing: "0.02em",
              display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
            }}>
              {s.label}
              {s.count > 0 && (
                <span style={{
                  background: activeSection === s.id ? "rgba(0,0,0,0.25)" : "var(--nh-accent)",
                  color: activeSection === s.id ? "#fff" : "#0a0a0a",
                  fontSize: 9, padding: "1px 4px", borderRadius: 3,
                }}>{s.count}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 14px 80px" }}>
          {activeSection === "tags" && (
            <FilterMulti search={tagSearch} setSearch={setTagSearch} placeholder="search tags…"
              options={dataset.allTags} selected={filters.tags}
              onToggle={(v) => toggle("tags", v)} counts={dataset.tagCounts} />
          )}
          {activeSection === "characters" && (
            <FilterMulti options={dataset.allCharacters} selected={filters.characters}
              onToggle={(v) => toggle("characters", v)} counts={dataset.charCounts} placeholder="search characters…" />
          )}
          {activeSection === "parodies" && (
            <FilterMulti options={dataset.allParodies} selected={filters.parodies}
              onToggle={(v) => toggle("parodies", v)} counts={dataset.parodyCounts} placeholder="search parodies…" />
          )}
          {activeSection === "artists" && (
            <FilterMulti options={dataset.allArtists} selected={filters.artists}
              onToggle={(v) => toggle("artists", v)} counts={dataset.artistCounts} placeholder="search artists…" />
          )}
          {activeSection === "pages" && <FilterPageRange filters={filters} setFilters={setFilters} min={0} max={dataset.pageMax} />}
          {activeSection === "sort" && <FilterSort filters={filters} setFilters={setFilters} />}
        </div>
        <div style={{
          position: "sticky", bottom: 0, left: 0, right: 0,
          padding: "10px 14px",
          background: "var(--nh-surface)",
          borderTop: "1px solid var(--nh-border)",
        }}>
          <button onClick={onClose} style={{
            width: "100%", height: 40, borderRadius: 8,
            background: "var(--nh-accent)", color: "#0a0a0a",
            border: 0, cursor: "pointer",
            fontFamily: "var(--nh-font-display)", fontSize: 13, fontWeight: 700,
            letterSpacing: "-0.01em",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            show {dataset.matchingCount ?? 0} results
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterMulti({ options, selected, onToggle, counts, placeholder, search: searchProp, setSearch: setSearchProp }: {
  options: string[]; selected: string[]; onToggle: (v: string) => void;
  counts: Record<string, number>; placeholder: string;
  search?: string; setSearch?: (s: string) => void;
}) {
  const [searchLocal, setSearchLocal] = useState("");
  const search = searchProp !== undefined ? searchProp : searchLocal;
  const setSearch = setSearchProp || setSearchLocal;
  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{
        height: 32, borderRadius: 6,
        background: "var(--nh-input-bg)",
        border: "1px solid var(--nh-border)",
        display: "flex", alignItems: "center", padding: "0 10px",
      }}>
        <NhIcon name="search" size={12} color="var(--nh-text-3)" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={placeholder} style={{
          flex: 1, background: "transparent", border: 0, outline: "none",
          color: "var(--nh-text-1)",
          fontFamily: "var(--nh-font-mono)", fontSize: 11,
          padding: "0 8px",
        }} />
      </div>
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {selected.map(s => (
            <button key={s} onClick={() => onToggle(s)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              padding: "4px 7px", borderRadius: 4,
              background: "var(--nh-accent)", color: "#0a0a0a",
              fontFamily: "var(--nh-font-mono)", fontSize: 10, fontWeight: 600,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}>
              {s}
              <NhIcon name="close" size={9} color="#0a0a0a" stroke={2.4}/>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {filtered.slice(0, 60).map(o => {
          const isSel = selected.includes(o);
          return (
            <button key={o} onClick={() => onToggle(o)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 4px", background: "transparent",
              borderBottom: "1px solid var(--nh-border)",
              textAlign: "left",
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: 3,
                border: `1.5px solid ${isSel ? "var(--nh-accent)" : "var(--nh-border-strong)"}`,
                background: isSel ? "var(--nh-accent)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                {isSel && <NhIcon name="check" size={11} color="#0a0a0a" stroke={2.6}/>}
              </div>
              <span style={{ flex: 1, fontFamily: "var(--nh-font-mono)", fontSize: 12, color: "var(--nh-text-1)", letterSpacing: "0.01em" }}>{o}</span>
              <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>{counts?.[o] ?? 0}</span>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 4px" }}>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>page count</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 28, fontWeight: 700, color: "var(--nh-accent)", letterSpacing: "-0.02em" }}>{filters.pageMin}</span>
        <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)" }}>to</span>
        <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 28, fontWeight: 700, color: "var(--nh-accent)", letterSpacing: "-0.02em" }}>{filters.pageMax}</span>
        <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)" }}>pages</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>min ({min})</label>
        <input type="range" min={min} max={max} value={filters.pageMin}
          onChange={e => setFilters(f => ({ ...f, pageMin: Math.min(+e.target.value, f.pageMax) }))} className="nh-range" />
        <label style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>max ({max})</label>
        <input type="range" min={min} max={max} value={filters.pageMax}
          onChange={e => setFilters(f => ({ ...f, pageMax: Math.max(+e.target.value, f.pageMin) }))} className="nh-range" />
      </div>
    </div>
  );
}

function FilterSort({ filters, setFilters }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>> }) {
  const fields = [
    { id: "added-at", label: "date added", icon: "clock" as const },
    { id: "last-read-at", label: "last read date", icon: "eye" as const },
    { id: "uploaded-at", label: "upload date", icon: "clock" as const },
    { id: "read-count", label: "read count", icon: "eye" as const },
    { id: "pages", label: "page count", icon: "pages" as const },
    { id: "tag-count", label: "tag count", icon: "filter" as const },
    { id: "title", label: "title (a→z)", icon: "sort" as const },
    { id: "artist", label: "artist name", icon: "sort" as const },
    { id: "parody", label: "parody", icon: "sort" as const },
    { id: "hashtag", label: "hashtag id", icon: "sort" as const },
    { id: "random", label: "random", icon: "shuffle" as const },
  ];
  const isRandom = filters.sortField === "random";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" }}>
      <div>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>direction</div>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0,
          background: "var(--nh-input-bg)",
          border: "1px solid var(--nh-border)",
          borderRadius: 8, padding: 3,
          opacity: isRandom ? 0.4 : 1,
          pointerEvents: isRandom ? "none" : "auto",
        }}>
          {[
            { id: "desc" as const, label: "high → low", sub: "newest · most · biggest" },
            { id: "asc" as const, label: "low → high", sub: "oldest · least · smallest" },
          ].map(d => {
            const sel = filters.sortDir === d.id;
            return (
              <button key={d.id} onClick={() => setFilters(f => ({ ...f, sortDir: d.id }))} style={{
                appearance: "none", border: 0, cursor: "pointer",
                padding: "8px 10px", borderRadius: 6,
                background: sel ? "var(--nh-accent)" : "transparent",
                color: sel ? "#0a0a0a" : "var(--nh-text-2)",
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                textAlign: "left",
              }}>
                <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 700, letterSpacing: "-0.01em" }}>{d.label}</span>
                <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: sel ? "rgba(0,0,0,0.55)" : "var(--nh-text-3)", letterSpacing: "0.02em" }}>{d.sub}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>sort by field</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {fields.map(o => {
            const sel = filters.sortField === o.id;
            return (
              <button key={o.id} onClick={() => setFilters(f => ({ ...f, sortField: o.id }))} style={{
                appearance: "none", border: 0, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 10,
                padding: "11px 6px", background: "transparent",
                borderBottom: "1px solid var(--nh-border)",
                textAlign: "left",
              }}>
                <NhIcon name={o.icon} size={13} color={sel ? "var(--nh-accent)" : "var(--nh-text-3)"} />
                <span style={{ flex: 1, fontFamily: "var(--nh-font-mono)", fontSize: 12, color: sel ? "var(--nh-accent)" : "var(--nh-text-1)", fontWeight: sel ? 600 : 400 }}>{o.label}</span>
                {sel && <NhIcon name="check" size={14} color="var(--nh-accent)" stroke={2.4}/>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
