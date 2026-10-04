"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { BookOpen, Eye, ExternalLink, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NhCover } from "./Primitives";
import { daysAgoLabel } from "../lib/utils";
import { itemLabel, itemUrl, type Item } from "../lib/data";
import { SOURCES } from "../lib/sources";
import type { SimilarItem } from "../lib/titles";
import { getSimilarAction, getTitleAction } from "../app/actions";
import { GhostTagChips } from "./GhostTags";

type DetailModalProps = {
  item: Item | null; onClose: () => void;
  onTagClick: (group: string, val: string) => void;
  onDelete: () => void; onRead: () => void; onOpen: (item: Item) => void;
  onAlterName: (value: string) => void;
  onRefresh: () => Promise<void>;
  embedded?: boolean;
};

// Keying the inner component by hashtag resets editing/draft/similar state on
// every item switch without effects.
export function DetailModal({ item, ...rest }: DetailModalProps) {
  if (!item) return null;
  return <DetailModalInner key={item.hashtag} item={item} {...rest} />;
}

function DetailModalInner({ item, onClose, onTagClick, onDelete, onRead, onOpen, onAlterName, onRefresh, embedded }: DetailModalProps & { item: Item }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.alterName ?? "");
  const [similar, setSimilar] = useState<SimilarItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch (e) {
      console.error("refresh failed:", e);
    } finally {
      setRefreshing(false);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!embedded) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [embedded]);

  useEffect(() => {
    let cancelled = false;
    getSimilarAction(item.hashtag, 8)
      .then((r) => { if (!cancelled) setSimilar(r); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [item.hashtag]);

  const onDragStart = (e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    if (innerRef.current) innerRef.current.style.transition = "none";
  };

  const onDragMove = (e: React.TouchEvent) => {
    if (dragStartY.current === null || !innerRef.current) return;
    const delta = e.touches[0].clientY - dragStartY.current;
    if (delta > 0) innerRef.current.style.transform = `translateY(${delta}px)`;
  };

  const onDragEnd = (e: React.TouchEvent) => {
    if (dragStartY.current === null || !innerRef.current) return;
    const delta = e.changedTouches[0].clientY - dragStartY.current;
    dragStartY.current = null;
    if (delta > 80) {
      onClose();
    } else {
      innerRef.current.style.transition = "transform 200ms ease";
      innerRef.current.style.transform = "";
    }
  };

  const displayName = item.alterName || item.titleName;
  const origName = item.alterName ? item.titleName : null;

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() !== (item.alterName ?? "")) {
      onAlterName(draft.trim());
    }
  };
  const inner = (
    <div
      ref={innerRef}
      onClick={e => e.stopPropagation()}
      className={`flex flex-col bg-nh-surface ${embedded ? "absolute inset-0" : "relative"}`}
      style={{
        borderTopLeftRadius: embedded ? 14 : 18,
        borderTopRightRadius: embedded ? 14 : 18,
        borderBottomLeftRadius: embedded ? 14 : 0,
        borderBottomRightRadius: embedded ? 14 : 0,
        ...(embedded ? {} : {
          height: "calc(100% - 30px)",
          animation: "nhSlideUp 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          borderTop: "1px solid var(--nh-border)",
        }),
      }}
    >
      {!embedded && (
        <div
          className="flex justify-center pt-2 pb-1 shrink-0 cursor-grab active:cursor-grabbing touch-none"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
        >
          <div className="w-9 h-1 rounded-sm bg-nh-border-strong" />
        </div>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-3.5 right-3.5 z-10 size-7 rounded-md backdrop-blur-md text-white/90 hover:bg-black/60"
        style={{ background: "rgba(0,0,0,0.5)" }}
      >
        <X className="size-3.5" strokeWidth={2} />
      </Button>

      <div className="flex-1 overflow-auto min-h-0">
        <div className="flex gap-3 px-4 pt-3">
          <div className="w-32.5 shrink-0">
            <NhCover item={item} size="large" />
          </div>
          <div className="flex-1 flex flex-col gap-1 min-w-0">
            <div className="font-mono text-[10px] tracking-wider text-nh-accent">{itemLabel(item)}</div>
            <div
              className="font-display font-bold text-nh-text-1"
              style={{ fontSize: 19, lineHeight: 1.15, letterSpacing: "-0.02em", textWrap: "balance" as never }}
            >
              {displayName}
            </div>
            {origName && (
              <div className="font-mono text-[10px] text-nh-text-3 truncate">{origName}</div>
            )}
            {editing ? (
              <Input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
                placeholder="custom name…"
                className="h-auto rounded-md bg-nh-input border-nh-accent px-2 py-1 font-mono text-[11px] text-nh-text-1"
              />
            ) : (
              <Button
                variant="outline"
                onClick={() => { setDraft(item.alterName ?? ""); setEditing(true); }}
                className="h-auto justify-start gap-1.5 rounded-md border border-dashed bg-transparent px-2 py-1 font-mono text-[11px] hover:bg-transparent"
                style={{
                  borderColor: "var(--nh-border-strong)",
                  color: item.alterName ? "var(--nh-accent)" : "var(--nh-text-3)",
                }}
              >
                <Pencil className="size-2.5" />
                {item.alterName || "add custom name…"}
              </Button>
            )}
            <div className="flex gap-2.5 mt-1 flex-wrap">
              <Stat icon={BookOpen} label={`${item.pages}p`} />
              <Stat icon={Eye} label={`${item.readCount}×`} accent={item.readCount > 0} />
            </div>
          </div>
        </div>

        <div
          className="grid grid-cols-3 gap-px mt-3.5 mx-4 rounded-lg overflow-hidden"
          style={{ background: "var(--nh-border)" }}
        >
          <DateCell label="uploaded" days={item.uploadedAt} fmt={daysAgoLabel} />
          <DateCell label="added" days={item.addedAt} fmt={daysAgoLabel} />
          <DateCell label="last read" days={item.lastReadAt} fmt={daysAgoLabel} />
        </div>

        <div className="flex flex-col gap-3.5 p-4">
          <ChipGroup label="parodies" items={item.parodies} color="var(--nh-text-1)" onTagClick={onTagClick} />
          <ChipGroup label="characters" items={item.characters} color="var(--nh-text-1)" onTagClick={onTagClick} />
          <ChipGroup label="artists" items={item.artists} color="var(--nh-accent)" onTagClick={onTagClick} />
          <ChipGroup label="groups" items={item.groups} color="var(--nh-text-2)" onTagClick={onTagClick} />
          <ChipGroup label="tags" items={item.tags} color="var(--nh-text-2)" onTagClick={onTagClick} />
          <GhostTagChips hashtag={item.hashtag} onTagClick={onTagClick} />
        </div>

        {similar.length > 0 && (
          <div className="mt-2">
            <div className="px-4 pb-2 font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">
              similar by tag overlap · {similar.length}
            </div>
            <div className="flex gap-2 px-4 pb-3 overflow-x-auto">
              {similar.map(s => (
                <div
                  key={s.hashtag}
                  onClick={async () => {
                    const full = await getTitleAction(s.hashtag);
                    if (full) onOpen(full);
                  }}
                  className="w-26 shrink-0 cursor-pointer"
                >
                  <div className="relative w-full aspect-350/500 rounded-(--nh-radius-card) overflow-hidden bg-nh-pill">
                    {s.imageLink && (
                      <Image src={s.imageLink} alt="" fill sizes="104px" className="object-cover object-top" />
                    )}
                  </div>
                  <div className="mt-1 font-display font-semibold text-[11px] text-nh-text-1 truncate">
                    {s.alterName || s.titleName}
                  </div>
                  <div className="font-mono text-[9px] text-nh-text-3">
                    {s.shared} shared tags
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        className="shrink-0 flex gap-2 px-3.5 pt-2.5 pb-3.5"
        style={{ background: "linear-gradient(to bottom, transparent, var(--nh-surface) 30%)" }}
      >
        <Button
          onClick={onDelete}
          variant="outline"
          size="icon"
          className="size-11 rounded-[10px] border bg-nh-input shrink-0"
          style={{ borderColor: "var(--nh-border-strong)" }}
        >
          <Trash2 className="size-4 text-nh-text-3" />
        </Button>
        <Button
          onClick={handleRefresh}
          disabled={refreshing}
          variant="outline"
          size="icon"
          title={`re-scrape metadata from ${SOURCES[item.source].name}`}
          className="size-11 rounded-[10px] border bg-nh-input shrink-0"
          style={{ borderColor: "var(--nh-border-strong)" }}
        >
          <RefreshCw className={`size-4 text-nh-text-3 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
        <a
          href={itemUrl(item)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onRead}
          className="flex-1 h-11 rounded-[10px] bg-nh-accent text-[#0a0a0a] flex items-center justify-center gap-2 font-display font-extrabold text-sm no-underline"
          style={{ letterSpacing: "-0.01em" }}
        >
          <span>read on {SOURCES[item.source].name}</span>
          <ExternalLink className="size-3.5" strokeWidth={2.2} />
        </a>
      </div>
    </div>
  );

  if (embedded) return inner;
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-110 flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.6)", animation: "nhFadeIn 200ms ease" }}
    >
      {inner}
    </div>
  );
}

function ChipGroup({ label, items, color, onTagClick }: {
  label: string; items: string[]; color?: string;
  onTagClick: (group: string, val: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">{label}</div>
      <div className="flex flex-wrap gap-1">
        {items.map(v => (
          <Badge
            key={v}
            variant="secondary"
            onClick={() => onTagClick(label, v)}
            className="h-auto cursor-pointer rounded-sm border-0 bg-nh-pill px-2 py-1 font-mono text-[11px] font-medium tracking-wide hover:bg-nh-pill/80"
            style={{ color: color || "var(--nh-text-2)" }}
          >
            {v}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, accent }: { icon: typeof BookOpen; label: string; accent?: boolean }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-sm bg-nh-pill px-1.5 py-1">
      <Icon
        className="size-2.5"
        style={{ color: accent ? "var(--nh-accent)" : "var(--nh-text-2)" }}
        strokeWidth={1.8}
      />
      <span
        className="font-mono text-[11px] font-semibold"
        style={{ color: accent ? "var(--nh-accent)" : "var(--nh-text-1)" }}
      >
        {label}
      </span>
    </div>
  );
}

function DateCell({ label, days, fmt }: { label: string; days: number | null; fmt: (d: number | null) => string }) {
  return (
    <div className="bg-nh-surface-2 px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-wider text-nh-text-3">{label}</div>
      <div className="font-mono text-[11px] text-nh-text-1 mt-0.5">{fmt(days)}</div>
    </div>
  );
}
