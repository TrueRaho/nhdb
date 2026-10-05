"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { ArrowUpDown } from "lucide-react";
import type { Item } from "../lib/data";
import { GalleryGrid } from "./Gallery";
import { GalleryHeader, FilterSheet, defaultFilters, type Filters, type Dataset } from "./HeaderFilter";
import { seedSignature } from "./RelatedTags";
import {
  deleteTitleAction, markReadAction, updateAlterNameAction, queryTitlesAction, commitScrapedAction,
} from "../app/actions";
import type { DatasetPayload } from "../lib/titles";

const DetailModal = dynamic(() => import("./DetailModal").then((m) => ({ default: m.DetailModal })), { ssr: false });
const AddModal = dynamic(() => import("./AddModal").then((m) => ({ default: m.AddModal })), { ssr: false });
const StatsView = dynamic(() => import("./Stats").then((m) => ({ default: m.StatsView })), { ssr: false });
const NhdbDesktop = dynamic(() => import("./Desktop").then((m) => ({ default: m.NhdbDesktop })), { ssr: false });

import { ScrapeJobsProvider, useScrapeJobs } from "./ScrapeJobsProvider";
import { ADD_PARAM, readAddParam } from "../lib/sources";
import { itemKey } from "../lib/data";

// Handles `/?add=177013,895243` (or encoded gallery links from any supported
// site) — the entry point for the iOS share-sheet shortcut and the
// bookmarklet, which is how titles arrive from a phone without retyping codes. Renders nothing; it only exists to sit *inside*
// ScrapeJobsProvider, since NhdbApp itself is the component that mounts it.
function DeepLinkAdd({ onOpen }: { onOpen: () => void }) {
  const { startScrape } = useScrapeJobs();
  const handled = useRef(false);
  useEffect(() => {
    // Runs once per mount, and a viewport flip remounts the whole tree — the
    // ref stops the second mount, and the stripped URL stops a reload.
    if (handled.current) return;
    handled.current = true;

    const refs = readAddParam(window.location.search);
    if (refs.length === 0) return;

    // Drop the param before scraping: leaving it in the address bar means a
    // pull-to-refresh (or a restored tab) re-queues the same batch later.
    const url = new URL(window.location.href);
    url.searchParams.delete(ADD_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    onOpen();
    void startScrape(refs.map((r) => r.url).join(" "));
  }, [onOpen, startScrape]);
  return null;
}

// Which related tags are actually widening the query right now. The expansion
// applies only while it is switched on AND still belongs to the current
// selection: the suggestions are fetched asynchronously, so between toggling a
// tag and the new list arriving, `tagsExpanded` still describes the *previous*
// seed set. Checking the stored signature keeps that window unexpanded instead
// of briefly filtering by the wrong thing — and means nothing ever has to reset
// those fields.
function appliedExpansion(f: Filters): string[] {
  return f.expandTags && f.expandedFor === seedSignature(f.tags, f.matchModes.tags)
    ? f.tagsExpanded
    : [];
}

// null until mounted: the server renders neither layout, so a phone never
// downloads the desktop chunk and there is no hydration mismatch.
function useViewport(): "mobile" | "desktop" | null {
  const [vp, setVp] = useState<"mobile" | "desktop" | null>(null);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 900px)");
    const apply = () => setVp(mql.matches ? "desktop" : "mobile");
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return vp;
}

function datasetFromPayload(d: DatasetPayload): Dataset {
  return {
    allTags: d.allTags,
    allCharacters: d.allCharacters,
    allParodies: d.allParodies,
    allArtists: d.allArtists,
    allGroups: d.allGroups,
    tagCounts: d.tagCounts,
    charCounts: d.charCounts,
    parodyCounts: d.parodyCounts,
    artistCounts: d.artistCounts,
    groupCounts: d.groupCounts,
    pageMin: d.pageMin,
    pageMax: d.pageMax,
  };
}

export default function NhdbApp({
  userId, initialItems, initialTotal, dataset: datasetPayload, pageSize,
}: {
  userId: string;
  initialItems: Item[];
  initialTotal: number;
  dataset: DatasetPayload;
  pageSize: number;
}) {
  const dataset = useMemo(() => datasetFromPayload(datasetPayload), [datasetPayload]);
  const totalEver = datasetPayload.total;

  const [items, setItems] = useState<Item[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filters, setFilters] = useState<Filters>(() =>
    defaultFilters(datasetPayload.pageMin, datasetPayload.pageMax));
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterSection, setFilterSection] = useState("sort");
  const [detailItem, setDetailItem] = useState<Item | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [view, setView] = useState<"gallery" | "stats">("gallery");
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState(false);
  const queryIdRef = useRef(0);
  const viewport = useViewport();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  const seedRef = useRef(0);
  const runQuery = useCallback((offset: number, append: boolean, currentSearch: string, currentFilters: Filters) => {
    const id = ++queryIdRef.current;
    setLoading(true);
    setQueryError(false);
    // Fresh seed per new random query; "load more" keeps the seed so pages don't overlap.
    if (currentFilters.sortField === "random" && !append) {
      seedRef.current = Math.floor(Math.random() * 1_000_000_000);
    }
    queryTitlesAction({
      search: currentSearch || undefined,
      tags: currentFilters.tags,
      tagsExpanded: appliedExpansion(currentFilters),
      ghostTags: currentFilters.ghostTags || undefined,
      artists: currentFilters.artists,
      groups: currentFilters.groups,
      characters: currentFilters.characters,
      parodies: currentFilters.parodies,
      matchModes: currentFilters.matchModes,
      // Bounds equal to the dataset span mean "no page filter" — omit them so
      // titles outside the (possibly stale) initial bounds don't silently vanish.
      pageMin: currentFilters.pageMin > dataset.pageMin ? currentFilters.pageMin : undefined,
      pageMax: currentFilters.pageMax < dataset.pageMax ? currentFilters.pageMax : undefined,
      read: currentFilters.read === "all" ? undefined : currentFilters.read,
      noAlter: currentFilters.noAlter || undefined,
      sortField: currentFilters.sortField,
      sortDir: currentFilters.sortDir,
      seed: currentFilters.sortField === "random" ? seedRef.current : undefined,
      limit: pageSize,
      offset,
    }).then((res) => {
      if (id !== queryIdRef.current) return;
      setTotal(res.total);
      // Dedup on append: optimistic add/delete (and tied server sorts) can shift
      // offsets, so a page may overlap rows we already have — duplicate
      // key={hashtag} would crash the grid.
      setItems((prev) => {
        if (!append) return res.items;
        const existing = new Set(prev.map((x) => x.hashtag));
        return [...prev, ...res.items.filter((x) => !existing.has(x.hashtag))];
      });
      setLoading(false);
    }).catch((err) => {
      console.error("query failed:", err);
      if (id === queryIdRef.current) {
        setLoading(false);
        setQueryError(true);
      }
    });
  }, [pageSize, dataset.pageMin, dataset.pageMax]);

  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    startTransition(() => runQuery(0, false, search, filters));
  }, [search, filters, runQuery]);

  const onLoadMore = () => {
    if (loading || items.length >= total) return;
    runQuery(items.length, true, search, filters);
  };

  const activeFilterCount = useMemo(() =>
    filters.tags.length + filters.characters.length +
    filters.parodies.length + filters.artists.length + filters.groups.length +
    ((filters.pageMin > dataset.pageMin || filters.pageMax < dataset.pageMax) ? 1 : 0) +
    (filters.read !== "all" ? 1 : 0) +
    (filters.noAlter ? 1 : 0) +
    // The expansion changes which titles come back, so it counts as one active
    // filter — the badge would otherwise under-report the query in effect.
    (appliedExpansion(filters).length ? 1 : 0) +
    // Ghosts change the result set on their own — with no tags selected they
    // still widen the search box — so they count whenever they are switched on.
    (filters.ghostTags ? 1 : 0),
  [filters, dataset.pageMin, dataset.pageMax]);

  const openFilters = (section: string) => {
    setFilterSection(section);
    setFilterOpen(true);
  };

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

  // Titles deleted this session. onRefresh consults it before committing: a
  // refresh's scrape can be in flight when the user deletes the title, and
  // committing the stale result would silently re-create the row (with wiped
  // read stats). A later re-add via the add flow clears the mark.
  const deletedRef = useRef<Set<number>>(new Set());

  const onDelete = () => {
    if (!detailItem) return;
    const removed = detailItem;
    const hashtag = removed.hashtag;
    deletedRef.current.add(hashtag);
    setItems(c => c.filter(x => x.hashtag !== hashtag));
    setTotal(t => Math.max(0, t - 1));
    setDetailItem(null);
    deleteTitleAction(hashtag).catch(err => {
      // Roll the optimistic removal back — the row still exists server-side,
      // and leaving it hidden would misrepresent the collection until reload.
      console.error("Failed to delete title:", err);
      deletedRef.current.delete(hashtag);
      setItems(c => (c.some(x => x.hashtag === hashtag) ? c : [removed, ...c]));
      setTotal(t => t + 1);
    });
  };

  const onRead = () => {
    if (!detailItem) return;
    const prev = detailItem;
    const hashtag = prev.hashtag;
    const updated = { ...prev, readCount: prev.readCount + 1, lastReadAt: 0 };
    setDetailItem(updated);
    setItems(c => c.map(x => x.hashtag === hashtag ? updated : x));
    markReadAction(hashtag).catch(err => {
      console.error("Failed to update read count:", err);
      setDetailItem(cur => (cur && cur.hashtag === hashtag ? prev : cur));
      setItems(c => c.map(x => x.hashtag === hashtag ? prev : x));
    });
  };

  const onAlterName = (value: string) => {
    if (!detailItem) return;
    const prev = detailItem;
    const hashtag = prev.hashtag;
    const updated = { ...prev, alterName: value };
    setDetailItem(updated);
    setItems(c => c.map(x => x.hashtag === hashtag ? updated : x));
    updateAlterNameAction(hashtag, value).catch(err => {
      console.error("Failed to update alter name:", err);
      setDetailItem(cur => (cur && cur.hashtag === hashtag ? prev : cur));
      setItems(c => c.map(x => x.hashtag === hashtag ? prev : x));
    });
  };

  // Re-scrape the open title from its own site and refresh it in place.
  const onRefresh = async () => {
    if (!detailItem) return;
    const hashtag = detailItem.hashtag;
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: itemKey(detailItem), persist: false }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? "refresh failed");
    }
    const { scraped } = await res.json();
    // Deleted while the scrape was in flight — committing now would resurrect
    // the title as a fresh row with zeroed read history. Drop the result.
    if (deletedRef.current.has(hashtag)) return;
    const fresh = await commitScrapedAction(scraped);
    // The scrape can take a long time; only swap the modal content if it is
    // still open on the same title — never force it back open or yank a
    // different title the user has since navigated to.
    setDetailItem(cur => (cur && cur.hashtag === hashtag ? fresh : cur));
    setItems(c => c.map(x => x.hashtag === hashtag ? fresh : x));
  };

  const recentAdds = useMemo(() => items.filter(c => c.addedAt < 14).slice(0, 5), [items]);

  // The committed items returned by the server action are complete and fresh,
  // so prepending them is enough (matches the default added-at desc sort).
  // Deliberately no immediate re-query: tag invalidation can lag behind the
  // write (notably on Vercel), and a stale cached page would clobber the
  // just-added titles off the top of the list.
  const onAddItems = (newItems: Item[]) => {
    // Re-added titles are no longer "deleted" for the refresh guard.
    for (const it of newItems) deletedRef.current.delete(it.hashtag);
    // Prepend ONLY into the plain default view. Under an active search/filter
    // the new rows may not match the query (total would lie and load-more would
    // chase phantom rows forever); under a non-default sort the position is
    // wrong. In those views the additions simply show up on the next query.
    const isDefaultView =
      search === "" && activeFilterCount === 0 &&
      filters.sortField === "added-at" && filters.sortDir === "desc";
    if (!isDefaultView) return;
    // Dedup before touching state so `total` only counts rows actually added —
    // counting dropped duplicates would inflate it and skew load-more math.
    const existing = new Set(items.map(x => x.hashtag));
    const added = newItems.filter(x => !existing.has(x.hashtag));
    if (added.length === 0) return;
    setItems(c => {
      const current = new Set(c.map(x => x.hashtag));
      return [...added.filter(x => !current.has(x.hashtag)), ...c];
    });
    setTotal(t => t + added.length);
  };

  if (viewport === null) {
    return <div className="min-h-screen bg-nh-bg" />;
  }

  if (viewport === "desktop") {
    return (
      <ScrapeJobsProvider userId={userId}>
      <DeepLinkAdd onOpen={() => setAddOpen(true)} />
      <div className="min-h-screen bg-nh-bg">
        <NhdbDesktop
          items={items} total={total} totalEver={totalEver} dataset={dataset}
          activeFilterCount={activeFilterCount}
          search={searchInput} setSearch={setSearchInput}
          filters={filters} setFilters={setFilters}
          detailItem={detailItem} setDetailItem={setDetailItem}
          addOpen={addOpen} setAddOpen={setAddOpen}
          view={view} setView={setView}
          onTagClick={onTagClick} onChipClick={onChipClick} onDelete={onDelete} onRead={onRead}
          onAlterName={onAlterName} onRefresh={onRefresh}
          recentAdds={recentAdds} density="comfortable" onAddItems={onAddItems}
          loading={loading} onLoadMore={onLoadMore} queryError={queryError}
        />
      </div>
      </ScrapeJobsProvider>
    );
  }

  return (
    <ScrapeJobsProvider userId={userId}>
    <DeepLinkAdd onOpen={() => setAddOpen(true)} />
    <div className="w-full min-h-screen flex flex-col bg-nh-bg text-nh-text-1 relative overflow-hidden">
      <div className="flex-1 relative">
        <GalleryHeader
          search={searchInput} setSearch={setSearchInput}
          onAdd={() => setAddOpen(true)}
          onStats={() => setView(v => v === "stats" ? "gallery" : "stats")}
          statsActive={view === "stats"}
          onOpenSettings={() => setFilterOpen(true)}
          activeFilterCount={activeFilterCount}
        />
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
          <div className="font-mono text-[10px] uppercase tracking-wider text-nh-text-3">
            {total} of {totalEver} titles
          </div>
          <div className="flex-1" />
          <button
            onClick={() => openFilters("sort")}
            className="font-mono text-[10px] text-nh-text-3 flex items-center gap-1"
          >
            <ArrowUpDown className="size-3 text-nh-text-3" />
            {filters.sortField.replace(/-/g, " ")} · {filters.sortDir}
          </button>
        </div>

        {view === "gallery" && (
          <>
            {queryError && (
              <div className="px-3 pb-2 font-mono text-[10px] text-[#ff6b6b]">
                query failed — results may be stale · adjust filters to retry
              </div>
            )}
            <GalleryGrid items={items} onOpen={setDetailItem} onTagClick={onTagClick} density="comfortable" />
            {items.length < total && (
              <div className="flex justify-center pb-6">
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
              <div className="p-10 text-center font-mono text-xs text-nh-text-3">
                no results · adjust filters
              </div>
            )}
          </>
        )}
        {view === "stats" && <StatsView dataset={dataset} onTagClick={onTagClick} />}
      </div>

      <FilterSheet
        open={filterOpen} onClose={() => setFilterOpen(false)}
        filters={filters} setFilters={setFilters}
        dataset={{ ...dataset, matchingCount: total }}
        activeSection={filterSection} setActiveSection={setFilterSection}
      />
      <DetailModal
        item={detailItem}
        onClose={() => setDetailItem(null)}
        onTagClick={onChipClick}
        onDelete={onDelete}
        onRead={onRead}
        onOpen={setDetailItem}
        onAlterName={onAlterName}
        onRefresh={onRefresh}
      />
      <AddModal open={addOpen} onClose={() => setAddOpen(false)} recentAdds={recentAdds} onAdd={onAddItems} />
    </div>
    </ScrapeJobsProvider>
  );
}
