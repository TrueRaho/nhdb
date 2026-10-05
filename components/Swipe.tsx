"use client";

import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Check, ChevronsDown, ExternalLink, Shuffle, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { coverSeed, itemLabel, itemUrl, type Item } from "../lib/data";
import { paletteFor } from "../lib/cover-art";
import { coverSrc, siteName } from "../lib/sources";
import { deleteTitlesAction, getSwipeCardsAction, getSwipeDeckAction, updateAlterNameAction } from "../app/actions";
import {
  CARD_BATCH, DELETE_BATCH, POSTPONE_GAP, PREFETCH_AHEAD, SWIPE_DISTANCE,
  addToTrash, classifyGesture, postpone, readTrash, removeFromTrash, shuffled,
  type SwipeDirection, type TrashEntry,
} from "../lib/swipe";

// The swipe deck: the rules live in lib/swipe.ts, this is the screen.

const FLING_MS = 220;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Opening a title from here is a look, not a read: going through a few hundred
// unnamed titles would otherwise flood the reading stats. The gallery's "read
// on <site>" is still what counts a read.
function openTitle(item: Item) {
  window.open(itemUrl(item), "_blank", "noopener,noreferrer");
}

// globals.css sets `button { font-family: inherit }` unlayered, which beats a
// font-* utility on the <button> itself (see SEGMENT_SIZES in Primitives.tsx),
// so a mono label goes on a span inside it.
const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono">{children}</span>;

type Phase = "loading" | "error" | "ready";
type Tally = { kept: number; trashed: number; postponed: number };
const NO_TALLY: Tally = { kept: 0, trashed: 0, postponed: 0 };

export function SwipeDeck({ userId }: { userId: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [draw, setDraw] = useState(0);
  const [queue, setQueue] = useState<number[]>([]);
  const [cards, setCards] = useState<Record<number, Item>>({});
  const [cardsFailed, setCardsFailed] = useState(false);
  const [cardsRetry, setCardsRetry] = useState(0);
  const [names, setNames] = useState<Record<number, string>>({});
  // Mounted client-only (components/SwipeEntry.tsx), so storage is readable here.
  const [trash, setTrash] = useState<TrashEntry[]>(() => readTrash(userId));
  const [trashOpen, setTrashOpen] = useState(false);
  const [tally, setTally] = useState<Tally>(NO_TALLY);
  const [needName, setNeedName] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inflight = useRef(new Set<number>());
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<CardHandle>(null);

  // Next keeps a page alive, hidden, when you navigate away (Activity), and
  // shows the same state when you come back. Here that would replay the old
  // deck in the old order — but every launch is meant to be a fresh shuffle.
  // So hiding resets the session, and showing again re-runs the draw below.
  useLayoutEffect(() => () => {
    setPhase("loading");
    setQueue([]);
    setNames({});
    setTally(NO_TALLY);
    setTrashOpen(false);
    setNeedName(false);
    setNotice(null);
  }, []);

  // The draw: every title without a name, minus the deletion list, shuffled.
  useEffect(() => {
    let cancelled = false;
    getSwipeDeckAction()
      .then((hashtags) => {
        if (cancelled) return;
        const list = readTrash(userId);
        const trashed = new Set(list.map((e) => e.hashtag));
        setTrash(list);
        setQueue(shuffled(hashtags.filter((h) => !trashed.has(h))));
        setPhase("ready");
      })
      .catch((err) => {
        console.error("swipe deck failed:", err);
        if (!cancelled) setPhase("error");
      });
    return () => { cancelled = true; };
  }, [userId, draw]);

  // Keep the next few covers loaded. A title that comes back missing was
  // deleted since the draw, and one that comes back with a name was named
  // elsewhere (another tab) — either way it leaves the queue.
  useEffect(() => {
    if (phase !== "ready") return;
    const ahead = queue.slice(0, PREFETCH_AHEAD + 1);
    if (ahead.every((h) => cards[h] || inflight.current.has(h))) return;
    const batch = queue.filter((h) => !cards[h] && !inflight.current.has(h)).slice(0, CARD_BATCH);
    for (const h of batch) inflight.current.add(h);
    getSwipeCardsAction(batch)
      .then((items) => {
        setCards((prev) => {
          const next = { ...prev };
          for (const it of items) next[it.hashtag] = it;
          return next;
        });
        const got = new Set(items.filter((i) => !i.alterName).map((i) => i.hashtag));
        const gone = new Set(batch.filter((h) => !got.has(h)));
        if (gone.size) setQueue((q) => q.filter((h) => !gone.has(h)));
        setCardsFailed(false);
      })
      .catch((err) => {
        console.error("swipe cards failed:", err);
        setCardsFailed(true);
      })
      .finally(() => {
        for (const h of batch) inflight.current.delete(h);
      });
  }, [phase, queue, cards, cardsRetry]);

  const current = queue[0];
  const item = current != null ? cards[current] : undefined;
  const nextItem = queue[1] != null ? cards[queue[1]] : undefined;
  const name = current != null ? names[current] ?? "" : "";
  const canKeep = name.trim().length > 0;

  const nudgeName = useCallback(() => {
    setNeedName(true);
    const el = inputRef.current;
    el?.focus();
    if (el && !reducedMotion() && typeof el.animate === "function") {
      el.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(7px)" },
          { transform: "translateX(-4px)" }, { transform: "translateX(0)" }],
        { duration: 320, easing: "ease-out" },
      );
    }
  }, []);

  // A swipe that has finished flying off. Only the current card can land here.
  // `typed` is the name as it was when the swipe began: the field stays live
  // during the fly-out, and a name cleared mid-flight must not strand the card.
  const commit = useCallback((dir: SwipeDirection, it: Item, typed: string) => {
    setNeedName(false);
    setNotice(null);
    if (dir === "left") {
      setTrash(addToTrash(userId, {
        hashtag: it.hashtag, label: itemLabel(it), titleName: it.titleName, imageLink: it.imageLink, url: it.url, pages: it.pages,
      }));
      setQueue((q) => q.filter((h) => h !== it.hashtag));
      setTally((t) => ({ ...t, trashed: t.trashed + 1 }));
    } else if (dir === "down") {
      setQueue((q) => (q[0] === it.hashtag ? postpone(q, POSTPONE_GAP) : q));
      setTally((t) => ({ ...t, postponed: t.postponed + 1 }));
    } else if (dir === "right") {
      const value = typed.trim();
      setQueue((q) => q.filter((h) => h !== it.hashtag));
      setTally((t) => ({ ...t, kept: t.kept + 1 }));
      // Optimistic: the card is gone at once, and comes back on top if the save fails.
      updateAlterNameAction(it.hashtag, value).catch((err) => {
        console.error("saving the name failed:", err);
        setQueue((q) => (q.includes(it.hashtag) ? q : [it.hashtag, ...q]));
        setTally((t) => ({ ...t, kept: t.kept - 1 }));
        setNotice(`couldn't save “${value}” — it's back on top`);
      });
    }
  }, [userId]);

  const tryKeep = useCallback(() => {
    if (!canKeep) nudgeName();
    else cardRef.current?.fling("right");
  }, [canKeep, nudgeName]);

  // Arrows when not typing: ← list, ↓ later, → keep. In the name field, Enter keeps.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e) => {
      const card = cardRef.current;
      if (!card || !item) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); card.fling("left"); }
      else if (e.key === "ArrowDown") { e.preventDefault(); card.fling("down"); }
      else if (e.key === "ArrowRight") { e.preventDefault(); tryKeep(); }
      else if (e.key === "o") { e.preventDefault(); openTitle(item); }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.metaKey || e.ctrlKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector("[role=dialog]")) return;
      keys.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reshuffle = () => {
    setPhase("loading");
    setQueue([]);
    setTally(NO_TALLY);
    setNotice(null);
    setDraw((d) => d + 1);
  };

  const restore = (hashtag: number) => {
    setTrash(removeFromTrash(userId, [hashtag]));
    // Back into this session's deck, last — it still has no name.
    setQueue((q) => (q.includes(hashtag) ? q : [...q, hashtag]));
  };

  const [deleting, setDeleting] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const deleteAll = async () => {
    const list = readTrash(userId);
    if (list.length === 0 || deleting) return;
    setDeleting(true);
    setTrashError(null);
    try {
      // One DELETE per chunk (the server caps a call at DELETE_BATCH), strictly
      // one after another; each chunk leaves the list only once it is done.
      let deleted = 0;
      for (let i = 0; i < list.length; i += DELETE_BATCH) {
        const chunk = list.slice(i, i + DELETE_BATCH).map((e) => e.hashtag);
        deleted += (await deleteTitlesAction(chunk)).length;
        // Clear what was sent, not whatever the list holds by now.
        setTrash(removeFromTrash(userId, chunk));
      }
      setTrashOpen(false);
      setNotice(`deleted ${deleted} title${deleted === 1 ? "" : "s"}`);
    } catch (err) {
      console.error("deleting the list failed:", err);
      setTrashError("couldn't delete — nothing was removed. try again");
    } finally {
      setDeleting(false);
    }
  };

  const done = phase === "ready" && queue.length === 0;
  const touched = tally.kept + tally.trashed + tally.postponed > 0;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[520px] flex-col overflow-hidden overscroll-none bg-nh-bg text-nh-text-1">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Link
          href="/"
          aria-label="back to library"
          className="grid size-9 place-items-center rounded-lg bg-nh-pill text-nh-text-2 hover:text-nh-text-1"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1 text-center font-mono text-[11px] tracking-wide text-nh-text-3" aria-live="polite">
          {phase === "ready" ? (done ? "done" : `${queue.length} without a name`) : ""}
        </div>
        {item && (
          <button
            type="button"
            onClick={() => openTitle(item)}
            aria-label={`open ${itemLabel(item)} on ${siteName(item.source)}`}
            className="grid size-9 place-items-center rounded-lg bg-nh-pill text-nh-text-2 hover:text-nh-text-1"
          >
            <ExternalLink className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          disabled={trash.length === 0}
          aria-label={`deletion list, ${trash.length} title${trash.length === 1 ? "" : "s"}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-nh-pill px-2.5 text-nh-text-2 hover:text-nh-text-1 disabled:opacity-40"
        >
          <Trash2 className="size-4" />
          <span className="font-mono text-[11px]">{trash.length}</span>
        </button>
      </div>

      <div className="relative mx-3 min-h-0 flex-1">
        {phase === "loading" && (
          <div className="absolute inset-0 animate-pulse rounded-2xl bg-nh-pill motion-reduce:animate-none" aria-busy />
        )}
        {phase === "error" && (
          <Centered>
            <div className="font-mono text-[11px] text-[#ff6b6b]">couldn&apos;t load the deck</div>
            <Button variant="ghost" onClick={reshuffle} className="h-8 rounded-md bg-nh-pill px-3 text-[11px] text-nh-text-2">
              <Mono>retry</Mono>
            </Button>
          </Centered>
        )}
        {done && (
          <Centered>
            <div className="font-display text-[22px] font-extrabold" style={{ letterSpacing: "-0.02em" }}>
              {touched ? "that's all of them" : "every title has a name"}
            </div>
            {touched && (
              <div className="font-mono text-[11px] text-nh-text-2">
                {tally.kept} named · {tally.trashed} to delete · {tally.postponed} put off
              </div>
            )}
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {trash.length > 0 && (
                <Button onClick={() => setTrashOpen(true)} className="h-9 rounded-lg bg-nh-accent px-3.5 text-xs font-bold text-[#0a0a0a] hover:bg-nh-accent/90">
                  deletion list · {trash.length}
                </Button>
              )}
              <Button variant="ghost" onClick={reshuffle} className="h-9 gap-1.5 rounded-lg bg-nh-pill px-3.5 text-[11px] text-nh-text-2">
                <Shuffle className="size-3.5" /> <Mono>shuffle again</Mono>
              </Button>
            </div>
          </Centered>
        )}
        {phase === "ready" && current != null && !item && (
          cardsFailed ? (
            <Centered>
              <div className="font-mono text-[11px] text-[#ff6b6b]">couldn&apos;t load this title</div>
              <Button variant="ghost" onClick={() => setCardsRetry((n) => n + 1)} className="h-8 rounded-md bg-nh-pill px-3 text-[11px] text-nh-text-2">
                <Mono>retry</Mono>
              </Button>
            </Centered>
          ) : (
            <div className="absolute inset-0 animate-pulse rounded-2xl bg-nh-pill motion-reduce:animate-none" aria-busy />
          )
        )}
        {phase === "ready" && item && (
          <>
            {nextItem && (
              // The next cover waits underneath, already loading.
              <div aria-hidden className="absolute inset-0 scale-[0.95] overflow-hidden rounded-2xl opacity-50">
                <Cover item={nextItem} />
              </div>
            )}
            <SwipeCard
              key={item.hashtag}
              ref={cardRef}
              item={item}
              canKeep={canKeep}
              canPostpone={queue.length > 1}
              onSwipe={(dir) => commit(dir, item, name)}
              onBlocked={nudgeName}
              onRefused={setNotice}
            />
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        <input
          ref={inputRef}
          value={name}
          disabled={!item}
          onChange={(e) => {
            const v = e.target.value;
            if (current != null) setNames((n) => ({ ...n, [current]: v }));
            if (v.trim()) setNeedName(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); tryKeep(); }
            else if (e.key === "Escape") e.currentTarget.blur();
          }}
          placeholder="custom name…"
          aria-label="custom name — needed to keep the title"
          maxLength={255}
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // 18px: iOS zooms into any field below 16px on focus.
          className="h-14 w-full rounded-xl border bg-nh-input px-4 font-display text-[18px] text-nh-text-1 outline-hidden placeholder:text-nh-text-3 focus:border-nh-accent disabled:opacity-40"
          style={{ borderColor: needName ? "#e0a23a" : "var(--nh-border)" }}
        />
        <div className="min-h-4 font-mono text-[10.5px] leading-tight" aria-live="polite">
          {needName ? (
            <span style={{ color: "#e0a23a" }}>type a name to keep it — or swipe left or down</span>
          ) : notice ? (
            <span className="text-nh-text-2">{notice}</span>
          ) : (
            <span className="text-nh-text-3">← delete list · ↓ later · → keep · tap cover to open</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <RoundButton label="delete list" disabled={!item} onClick={() => cardRef.current?.fling("left")} tone="danger">
            <X className="size-6" strokeWidth={2.4} />
          </RoundButton>
          <RoundButton label="later" disabled={!item} onClick={() => cardRef.current?.fling("down")}>
            <ChevronsDown className="size-6" strokeWidth={2.2} />
          </RoundButton>
          <RoundButton label="keep" disabled={!item} dim={!canKeep} onClick={tryKeep} tone="accent">
            <Check className="size-6" strokeWidth={2.6} />
          </RoundButton>
        </div>
      </div>

      <TrashSheet
        open={trashOpen}
        onOpenChange={(open) => { setTrashOpen(open); if (!open) setTrashError(null); }}
        entries={trash}
        onRestore={restore}
        onDeleteAll={deleteAll}
        deleting={deleting}
        error={trashError}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">{children}</div>;
}

function RoundButton({ label, onClick, disabled, dim, tone, children }: {
  label: string; onClick: () => void; disabled?: boolean; dim?: boolean;
  tone?: "danger" | "accent"; children: React.ReactNode;
}) {
  const colors = tone === "accent"
    ? "bg-nh-accent text-[#0a0a0a]"
    : tone === "danger"
      ? "bg-nh-input text-[#ff6b6b] border border-[rgba(255,60,60,0.35)]"
      : "bg-nh-input text-nh-text-1 border border-nh-border-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl transition-opacity disabled:opacity-30 ${colors} ${dim ? "opacity-45" : ""}`}
    >
      {children}
      <span className="font-mono text-[9px] uppercase tracking-wider opacity-75">{label}</span>
    </button>
  );
}

function Cover({ item, priority }: { item: Item; priority?: boolean }) {
  const src = coverSrc(item.imageLink, item.url);
  if (!src) {
    const [a, b] = paletteFor(coverSeed(item));
    return <div className="absolute inset-0" style={{ background: `linear-gradient(160deg, ${a}, ${b})` }} />;
  }
  return (
    <Image
      src={src}
      alt=""
      fill
      unoptimized
      priority={priority}
      draggable={false}
      sizes="(max-width: 560px) 100vw, 520px"
      className="pointer-events-none object-cover object-top"
    />
  );
}

type CardHandle = { fling: (dir: SwipeDirection) => void };

// One cover, draggable. The drag writes straight to the element's style — a
// re-render per pointer move would be wasted work — and three CSS variables
// drive the stamps.
function SwipeCard({ ref, item, canKeep, canPostpone, onSwipe, onBlocked, onRefused }: {
  ref: Ref<CardHandle>;
  item: Item; canKeep: boolean;
  /** Postponing the last card would bring the very same card straight back. */
  canPostpone: boolean;
  onSwipe: (dir: SwipeDirection) => void; onBlocked: () => void;
  /** A swipe that springs back, and why. */
  onRefused: (why: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; dx: number; dy: number } | null>(null);
  const busy = useRef(false);

  const place = useCallback((dx: number, dy: number, animate: boolean) => {
    const node = el.current;
    if (!node) return;
    node.style.transition = animate ? `transform ${FLING_MS}ms ease-out` : "none";
    node.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${dx / 18}deg)`;
    const reach = Math.min(SWIPE_DISTANCE, (node.offsetWidth || 440) * 0.25);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const share = (d: number) => String(Math.max(0, Math.min(1, d / reach)));
    node.style.setProperty("--right", horizontal ? share(dx) : "0");
    node.style.setProperty("--left", horizontal ? share(-dx) : "0");
    node.style.setProperty("--down", horizontal ? "0" : share(dy));
  }, []);

  const fling = useCallback((dir: SwipeDirection) => {
    if (busy.current) return;
    if (dir === "up") { place(0, 0, true); onRefused("swiping up does nothing yet"); return; }
    if (dir === "down" && !canPostpone) { place(0, 0, true); onRefused("it's the last one — name it or send it to the list"); return; }
    if (dir === "right" && !canKeep) { place(0, 0, true); onBlocked(); return; }
    busy.current = true;
    const node = el.current;
    if (!node || reducedMotion()) { onSwipe(dir); return; }
    const w = node.offsetWidth || 440;
    const h = node.offsetHeight || 640;
    if (dir === "down") place(0, h * 1.15, true);
    else place(dir === "left" ? -w * 1.5 : w * 1.5, 40, true);
    window.setTimeout(() => onSwipe(dir), FLING_MS);
  }, [canKeep, canPostpone, onBlocked, onRefused, onSwipe, place]);

  useImperativeHandle(ref, () => ({ fling }), [fling]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // One finger drives the card; a second one mid-drag is ignored.
    if (busy.current || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    place(d.dx, d.dy, false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const gesture = classifyGesture(d.dx, d.dy, performance.now() - d.t, el.current?.offsetWidth ?? 0);
    if (gesture === "tap") { place(0, 0, false); openTitle(item); return; }
    if (gesture === null) { place(0, 0, true); return; }
    fling(gesture);
  };
  // A drag that loses its pointer (cancelled by the browser, capture taken
  // away) springs back — and must not stay "in progress", or the next touch
  // would be ignored. After a normal release there is no drag left to reset.
  const abandon = () => {
    if (!drag.current) return;
    drag.current = null;
    place(0, 0, true);
  };

  return (
    <div
      ref={el}
      role="group"
      aria-roledescription="card"
      aria-label={`${item.titleName} — tap to open on ${siteName(item.source)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={abandon}
      onLostPointerCapture={abandon}
      className="absolute inset-0 cursor-grab touch-none select-none overflow-hidden rounded-2xl bg-nh-surface-2 shadow-[0_10px_40px_rgba(0,0,0,0.45)] active:cursor-grabbing"
      style={{ "--right": 0, "--left": 0, "--down": 0 } as CSSProperties}
    >
      <Cover item={item} priority />
      <Stamp at="left-5 top-6 -rotate-12" var="--right" color={canKeep ? "var(--nh-accent)" : "#e0a23a"}>
        {canKeep ? "keep" : "name it first"}
      </Stamp>
      <Stamp at="right-5 top-6 rotate-12" var="--left" color="#ff6b6b">delete</Stamp>
      <Stamp at="left-1/2 top-6 -translate-x-1/2" var="--down" color="var(--nh-text-1)">later</Stamp>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 p-4 pt-20"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.55) 55%, transparent)" }}
      >
        <div className="font-mono text-[10px] tracking-wider text-white/70">
          {itemLabel(item)} · {item.pages}p{item.readCount > 0 ? ` · read ${item.readCount}×` : ""}
        </div>
        <div className="line-clamp-3 font-display text-[19px] font-bold leading-tight text-white" style={{ letterSpacing: "-0.01em" }}>
          {item.titleName}
        </div>
        {item.artists.length > 0 && (
          <div className="truncate font-mono text-[11px] lowercase text-nh-accent">{item.artists.join(" · ")}</div>
        )}
        {item.tags.length > 0 && (
          <div className="mt-1 flex max-h-[44px] flex-wrap gap-1 overflow-hidden">
            {item.tags.slice(0, 10).map((t) => (
              <span key={t} className="rounded-sm bg-white/12 px-1.5 py-[2px] font-mono text-[9.5px] text-white/80">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stamp({ at, var: v, color, children }: { at: string; var: string; color: string; children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-lg border-[3px] px-2.5 py-1 font-display text-[22px] font-extrabold uppercase ${at}`}
      style={{ color, borderColor: color, opacity: `var(${v})`, background: "rgba(0,0,0,0.35)", letterSpacing: "0.04em" }}
    >
      {children}
    </div>
  );
}

function TrashSheet({ open, onOpenChange, entries, onRestore, onDeleteAll, deleting, error }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  entries: TrashEntry[]; onRestore: (hashtag: number) => void;
  onDeleteAll: () => void; deleting: boolean; error: string | null;
}) {
  // Deleting is final, so it takes two taps: the first only asks.
  const [confirming, setConfirming] = useState(false);
  const n = entries.length;
  const pages = entries.reduce((s, e) => s + e.pages, 0);

  return (
    <Sheet open={open} onOpenChange={(v: boolean) => { onOpenChange(v); if (!v) setConfirming(false); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="flex max-h-[85dvh] flex-col gap-0 rounded-t-[18px] border-t border-nh-border bg-nh-surface p-0 text-nh-text-1"
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-9 rounded-sm bg-nh-border-strong" />
        </div>
        <div className="flex items-baseline gap-2 border-b border-nh-border px-4 pb-2.5 pt-1">
          <SheetTitle className="font-display text-[16px] font-bold text-nh-text-1">deletion list</SheetTitle>
          <span className="font-mono text-[10px] text-nh-text-3">{n} title{n === 1 ? "" : "s"} · {pages} pages</span>
          <SheetDescription className="sr-only">
            Titles swiped left. Nothing is deleted until you confirm; restore any to keep it.
          </SheetDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {n === 0 && <div className="py-6 text-center font-mono text-[11px] text-nh-text-3">nothing here</div>}
          {entries.map((e) => (
            <div key={e.hashtag} className="flex items-center gap-3 border-b border-nh-border py-2 last:border-b-0">
              <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-sm bg-nh-pill">
                {coverSrc(e.imageLink, e.url) && <Image src={coverSrc(e.imageLink, e.url)} alt="" fill unoptimized sizes="40px" className="object-cover object-top" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-[13px] font-semibold text-nh-text-1">{e.titleName}</div>
                <div className="font-mono text-[10px] text-nh-text-3">{e.label} · {e.pages}p</div>
              </div>
              <Button
                variant="ghost"
                onClick={() => onRestore(e.hashtag)}
                aria-label={`restore ${e.titleName}`}
                className="h-8 gap-1 rounded-md bg-nh-pill px-2.5 text-[11px] text-nh-text-2"
              >
                <Undo2 className="size-3.5" /> <Mono>restore</Mono>
              </Button>
            </div>
          ))}
        </div>
        {n > 0 && (
          <div className="flex flex-col gap-2 border-t border-nh-border px-4 pt-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
            {error && <div role="alert" className="font-mono text-[11px] text-[#ff6b6b]">{error}</div>}
            {confirming ? (
              <>
                <div className="font-mono text-[10.5px] leading-snug text-nh-text-2">
                  delete {n} title{n === 1 ? "" : "s"} for good? read history and names go with them.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting} className="h-11 rounded-lg bg-nh-pill text-[12px] text-nh-text-2">
                    <Mono>cancel</Mono>
                  </Button>
                  <Button
                    onClick={onDeleteAll}
                    disabled={deleting}
                    className="h-11 rounded-lg border text-[13px] font-extrabold text-[#ff6b6b] hover:bg-[rgba(255,60,60,0.14)]"
                    style={{ background: "rgba(255,60,60,0.08)", borderColor: "rgba(255,60,60,0.4)" }}
                  >
                    {deleting ? "deleting…" : `delete ${n}`}
                  </Button>
                </div>
              </>
            ) : (
              <Button
                onClick={() => setConfirming(true)}
                className="h-11 w-full rounded-lg border text-[13px] font-extrabold text-[#ff6b6b] hover:bg-[rgba(255,60,60,0.14)]"
                style={{ background: "rgba(255,60,60,0.08)", borderColor: "rgba(255,60,60,0.4)" }}
              >
                delete {n} title{n === 1 ? "" : "s"}…
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
