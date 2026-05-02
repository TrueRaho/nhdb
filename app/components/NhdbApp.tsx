"use client";

import { useEffect, useMemo, useState } from "react";
import type { Item, ReadLog } from "../lib/data";
import { GalleryGrid } from "./Gallery";
import { GalleryHeader, FilterSheet, type Filters, type Dataset } from "./HeaderFilter";
import { DetailModal } from "./DetailModal";
import { AddModal } from "./AddModal";
import { StatsView } from "./Stats";
import { NhdbDesktop } from "./Desktop";
import { NhIcon } from "./Primitives";

function useViewport(): "mobile" | "desktop" {
  const [vp, setVp] = useState<"mobile" | "desktop">("desktop");
  useEffect(() => {
    const compute = () => setVp(window.innerWidth >= 900 ? "desktop" : "mobile");
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);
  return vp;
}

export default function NhdbApp({ initialItems, initialReadLogs }: { initialItems: Item[]; initialReadLogs: ReadLog[] }) {
  const [collection, setCollection] = useState<Item[]>(initialItems);
  const [readLogs, setReadLogs] = useState<ReadLog[]>(initialReadLogs);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(() => ({
    tags: [], characters: [], parodies: [], artists: [], groups: [],
    pageMin: 0,
    pageMax: initialItems.reduce((m, i) => Math.max(m, i.pages), 0) || 999,
    sortField: "added-at", sortDir: "desc",
  }));
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<Item | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [view, setView] = useState<"gallery" | "stats">("gallery");
  const viewport = useViewport();

  const dataset: Dataset = useMemo(() => {
    const allTags = [...new Set(collection.flatMap(c => c.tags))].sort();
    const allCharacters = [...new Set(collection.flatMap(c => c.characters))].sort();
    const allParodies = [...new Set(collection.flatMap(c => c.parodies))].sort();
    const allArtists = [...new Set(collection.flatMap(c => c.artists))].sort();
    const allGroups = [...new Set(collection.flatMap(c => c.groups))].sort();
    const count = (key: "tags" | "characters" | "parodies" | "artists" | "groups") => {
      const c: Record<string, number> = {};
      collection.forEach(it => (it[key] as string[]).forEach(v => { c[v] = (c[v] || 0) + 1; }));
      return c;
    };
    const allPages = collection.map(c => c.pages);
    return {
      allTags, allCharacters, allParodies, allArtists, allGroups,
      tagCounts: count("tags"), charCounts: count("characters"),
      parodyCounts: count("parodies"), artistCounts: count("artists"), groupCounts: count("groups"),
      pageMin: Math.min(...allPages), pageMax: Math.max(...allPages),
    };
  }, [collection]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = collection.filter(c => {
      if (q && !(
        c.titleName.toLowerCase().includes(q) ||
        c.alterName.toLowerCase().includes(q) ||
        c.artists.some(a => a.includes(q)) ||
        c.tags.some(t => t.includes(q)) ||
        String(c.hashtag).includes(q)
      )) return false;
      if (filters.tags.length && !filters.tags.every(t => c.tags.includes(t))) return false;
      if (filters.characters.length && !filters.characters.some(t => c.characters.includes(t))) return false;
      if (filters.parodies.length && !filters.parodies.some(t => c.parodies.includes(t))) return false;
      if (filters.artists.length && !filters.artists.some(t => c.artists.includes(t))) return false;
      if (filters.groups.length && !filters.groups.some(t => c.groups.includes(t))) return false;
      if (c.pages < filters.pageMin || c.pages > filters.pageMax) return false;
      return true;
    });
    if (filters.sortField === "random") {
      out.sort(() => Math.random() - 0.5);
    } else {
      const getVal = (c: Item): number | string => {
        switch (filters.sortField) {
          case "added-at": return c.addedAt;
          case "last-read-at": return c.lastReadAt ?? 9e9;
          case "uploaded-at": return c.uploadedAt;
          case "read-count": return c.readCount;
          case "pages": return c.pages;
          case "hashtag": return c.hashtag;
          case "title": return c.titleName.toLowerCase();
          case "artist": return (c.artists[0] || "").toLowerCase();
          case "group": return (c.groups[0] || "").toLowerCase();
          case "parody": return (c.parodies[0] || "").toLowerCase();
          case "tag-count": return c.tags.length;
          default: return 0;
        }
      };
      const reverseDays = ["added-at", "last-read-at", "uploaded-at"].includes(filters.sortField);
      out.sort((a, b) => {
        const av = getVal(a), bv = getVal(b);
        if (av < bv) return -1;
        if (av > bv) return 1;
        return 0;
      });
      const dirReverse = reverseDays ? filters.sortDir === "asc" : filters.sortDir === "desc";
      if (dirReverse) out.reverse();
    }
    return out;
  }, [collection, search, filters]);

  const activeFilterCount =
    filters.tags.length + filters.characters.length +
    filters.parodies.length + filters.artists.length + filters.groups.length +
    ((filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0);

  const onTagClick = (t: string) =>
    setFilters(f => f.tags.includes(t) ? f : { ...f, tags: [...f.tags, t] });

  const onChipClick = (groupLabel: string, val: string) => {
    const map: Record<string, keyof Filters> = { tags: "tags", characters: "characters", parodies: "parodies", artists: "artists", groups: "groups" };
    const key = map[groupLabel] || "tags";
    setFilters(f => {
      const list = f[key] as string[];
      return list.includes(val) ? f : ({ ...f, [key]: [...list, val] } as Filters);
    });
    setDetailItem(null);
  };

  const onDelete = () => {
    if (!detailItem) return;
    const hashtag = detailItem.hashtag;
    setCollection(c => c.filter(x => x.hashtag !== hashtag));
    setDetailItem(null);
    fetch(`/api/titles/${hashtag}`, { method: "DELETE" }).catch(err => {
      console.error("Failed to delete title from DB:", err);
    });
  };

  const onRead = () => {
    if (!detailItem) return;
    const hashtag = detailItem.hashtag;
    const updated = { ...detailItem, readCount: detailItem.readCount + 1, lastReadAt: 0 };
    setDetailItem(updated);
    setCollection(c => c.map(x => x.hashtag === hashtag ? updated : x));
    setReadLogs(l => [{ hashtag, readAt: new Date().toISOString() }, ...l]);
    fetch(`/api/titles/${hashtag}`, { method: "PATCH" }).catch(err => {
      console.error("Failed to update read count:", err);
    });
  };

  const onAlterName = (value: string) => {
    if (!detailItem) return;
    const hashtag = detailItem.hashtag;
    const updated = { ...detailItem, alterName: value };
    setDetailItem(updated);
    setCollection(c => c.map(x => x.hashtag === hashtag ? updated : x));
    fetch(`/api/titles/${hashtag}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alterName: value }),
    }).catch(err => console.error("Failed to update alter name:", err));
  };

  const recentAdds = collection.filter(c => c.addedAt < 14).slice(0, 5);

  const onAddItems = (items: Item[]) => {
    setCollection(c => {
      const existing = new Set(c.map(x => x.hashtag));
      return [...items.filter(x => !existing.has(x.hashtag)), ...c];
    });
  };

  if (viewport === "desktop") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--nh-bg)" }}>
        <NhdbDesktop
          collection={collection} filtered={filtered} dataset={dataset}
          search={search} setSearch={setSearch}
          filters={filters} setFilters={setFilters}
          detailItem={detailItem} setDetailItem={setDetailItem}
          addOpen={addOpen} setAddOpen={setAddOpen}
          view={view} setView={setView}
          onTagClick={onTagClick} onChipClick={onChipClick} onDelete={onDelete} onRead={onRead}
          onAlterName={onAlterName} recentAdds={recentAdds} density="comfortable" onAddItems={onAddItems}
          readLogs={readLogs}
        />
      </div>
    );
  }

  return (
    <div style={{
      width: "100%", minHeight: "100vh",
      background: "var(--nh-bg)",
      color: "var(--nh-text-1)",
      position: "relative", overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ flex: 1, position: "relative" }}>
        <GalleryHeader
          search={search} setSearch={setSearch}
          onAdd={() => setAddOpen(true)}
          onStats={() => setView(v => v === "stats" ? "gallery" : "stats")}
          statsActive={view === "stats"}
          onOpenFilters={() => setFilterOpen(true)}
          activeFilterCount={activeFilterCount}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px 8px" }}>
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {filtered.length} of {collection.length} titles
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", display: "flex", alignItems: "center", gap: 4 }}>
            <NhIcon name="sort" size={11} color="var(--nh-text-3)"/>
            {filters.sortField.replace(/-/g, " ")} · {filters.sortDir}
          </div>
        </div>

        {view === "gallery" && (
          <>
            <GalleryGrid items={filtered} onOpen={setDetailItem} onTagClick={onTagClick} density="comfortable" />
            {filtered.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: "var(--nh-text-3)", fontFamily: "var(--nh-font-mono)", fontSize: 12 }}>
                no results · adjust filters
              </div>
            )}
          </>
        )}
        {view === "stats" && <StatsView collection={collection} dataset={dataset} onTagClick={onTagClick} readLogs={readLogs} />}
      </div>

      <FilterSheet
        open={filterOpen} onClose={() => setFilterOpen(false)}
        filters={filters} setFilters={setFilters}
        dataset={{ ...dataset, matchingCount: filtered.length }}
      />
      <DetailModal
        item={detailItem}
        onClose={() => setDetailItem(null)}
        onTagClick={onChipClick}
        onDelete={onDelete}
        onRead={onRead}
        onOpen={setDetailItem}
        onAlterName={onAlterName}
        allItems={collection}
      />
      <AddModal open={addOpen} onClose={() => setAddOpen(false)} recentAdds={recentAdds} onAdd={onAddItems} />
    </div>
  );
}
