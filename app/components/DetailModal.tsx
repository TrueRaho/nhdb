"use client";

import { useEffect, useRef, useState } from "react";
import { NhCover, NhIcon } from "./Primitives";
import type { Item } from "../lib/data";

export function DetailModal({ item, onClose, onTagClick, onDelete, onRead, onOpen, onAlterName, allItems, embedded }: {
  item: Item | null; onClose: () => void;
  onTagClick: (group: string, val: string) => void;
  onDelete: () => void; onRead: () => void; onOpen: (item: Item) => void;
  onAlterName: (value: string) => void; allItems: Item[]; embedded?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(item?.alterName ?? "");
    setEditing(false);
  }, [item?.hashtag]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!item) return null;

  const displayName = item.alterName || item.titleName;
  const origName = item.alterName ? item.titleName : null;

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() !== (item.alterName ?? "")) {
      onAlterName(draft.trim());
    }
  };
  const fmtDays = (d: number | null) => {
    if (d == null) return "—";
    if (d === 0) return "today";
    if (d < 7) return `${d} days ago`;
    if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
    if (d < 365) return `${Math.floor(d / 30)} months ago`;
    return `${(d / 365).toFixed(1)} years ago`;
  };

  const similar = allItems
    .filter(t => t.hashtag !== item.hashtag)
    .map(t => ({ t, score: t.tags.filter(x => item.tags.includes(x)).length }))
    .filter(x => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => x.t);

  const ChipGroup = ({ label, items, color }: { label: string; items: string[]; color?: string }) =>
    items.length === 0 ? null : (
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {items.map(v => (
            <button key={v} onClick={() => onTagClick(label, v)} style={{
              appearance: "none", border: 0, cursor: "pointer",
              padding: "4px 8px", borderRadius: 4,
              background: "var(--nh-pill-bg)",
              color: color || "var(--nh-text-2)",
              fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 500,
              letterSpacing: "0.01em",
            }}>{v}</button>
          ))}
        </div>
      </div>
    );

  const inner = (
    <div onClick={e => e.stopPropagation()} style={{
      background: "var(--nh-surface)",
      borderTopLeftRadius: embedded ? 14 : 18, borderTopRightRadius: embedded ? 14 : 18,
      borderBottomLeftRadius: embedded ? 14 : 0, borderBottomRightRadius: embedded ? 14 : 0,
      height: embedded ? "100%" : "calc(100% - 30px)",
      display: "flex", flexDirection: "column",
      animation: embedded ? "none" : "nhSlideUp 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
      borderTop: embedded ? "none" : "1px solid var(--nh-border)",
      position: "relative",
    }}>
      {!embedded && (
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px", flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--nh-border-strong)" }} />
        </div>
      )}
      <button onClick={onClose} style={{
        position: "absolute", top: 14, right: 14, zIndex: 5,
        appearance: "none", border: 0, cursor: "pointer",
        width: 28, height: 28, borderRadius: 7,
        background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <NhIcon name="close" size={14} color="rgba(255,255,255,0.9)" stroke={2}/>
      </button>

      <div style={{ flex: 1, overflow: "auto", paddingBottom: 90 }}>
        <div style={{ padding: "12px 16px 0", display: "flex", gap: 12 }}>
          <div style={{ width: 130, flexShrink: 0 }}>
            <NhCover item={item} size="large" />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-accent)", letterSpacing: "0.06em" }}>#{item.hashtag}</div>
            <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 19, fontWeight: 700, color: "var(--nh-text-1)", lineHeight: 1.15, letterSpacing: "-0.02em", textWrap: "balance" as never }}>{displayName}</div>
            {origName && (
              <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{origName}</div>
            )}
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
                placeholder="custom name…"
                style={{
                  background: "var(--nh-input-bg)", border: "1px solid var(--nh-accent)",
                  borderRadius: 5, padding: "4px 7px",
                  fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-1)",
                  outline: "none", width: "100%",
                }}
              />
            ) : (
              <button onClick={() => { setDraft(item.alterName ?? ""); setEditing(true); }} style={{
                appearance: "none", border: "1px dashed var(--nh-border-strong)", cursor: "text",
                borderRadius: 5, padding: "3px 7px", background: "transparent",
                fontFamily: "var(--nh-font-mono)", fontSize: 11, textAlign: "left",
                color: item.alterName ? "var(--nh-accent)" : "var(--nh-text-3)",
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <NhIcon name="sort" size={10} color="currentColor" />
                {item.alterName || "add custom name…"}
              </button>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
              <Stat icon="pages" label={`${item.pages}p`} />
              <Stat icon="eye" label={`${item.readCount}×`} accent={item.readCount > 0} />
            </div>
          </div>
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
          gap: 1, margin: "14px 16px 0",
          background: "var(--nh-border)", borderRadius: 8, overflow: "hidden",
        }}>
          <DateCell label="uploaded" days={item.uploadedAt} fmt={fmtDays} />
          <DateCell label="added" days={item.addedAt} fmt={fmtDays} />
          <DateCell label="last read" days={item.lastReadAt} fmt={fmtDays} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px" }}>
          <ChipGroup label="parodies" items={item.parodies} color="var(--nh-text-1)" />
          <ChipGroup label="characters" items={item.characters} color="var(--nh-text-1)" />
          <ChipGroup label="artists" items={item.artists} color="var(--nh-accent)" />
          <ChipGroup label="groups" items={item.groups} color="var(--nh-text-2)" />
          <ChipGroup label="tags" items={item.tags} color="var(--nh-text-2)" />
        </div>

        {similar.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ padding: "0 16px 8px", fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>similar by tag overlap · {similar.length}</div>
            <div style={{ display: "flex", gap: 8, padding: "0 16px 12px", overflowX: "auto" }}>
              {similar.map(s => (
                <div key={s.hashtag} onClick={() => onOpen(s)} style={{ width: 104, flexShrink: 0, cursor: "pointer" }}>
                  <NhCover item={s} size="sm" />
                  <div style={{ marginTop: 4, fontFamily: "var(--nh-font-display)", fontSize: 11, fontWeight: 600, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.titleName}</div>
                  <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)" }}>{s.tags.filter(x => item.tags.includes(x)).length} shared tags</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        padding: "10px 14px 14px",
        background: "linear-gradient(180deg, transparent, var(--nh-surface) 24%)",
        display: "flex", gap: 8,
      }}>
        <button onClick={onDelete} style={{
          appearance: "none", border: "1px solid var(--nh-border-strong)", cursor: "pointer",
          width: 44, height: 44, borderRadius: 10,
          background: "var(--nh-input-bg)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <NhIcon name="trash" size={16} color="var(--nh-text-3)" />
        </button>
        <a
          href={`https://nhentai.net/g/${item.hashtag}/`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onRead}
          style={{
            flex: 1, height: 44, borderRadius: 10,
            background: "var(--nh-accent)", color: "#0a0a0a",
            border: 0, cursor: "pointer",
            fontFamily: "var(--nh-font-display)", fontSize: 14, fontWeight: 800,
            letterSpacing: "-0.01em",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            textDecoration: "none",
          }}
        >
          <span>read on nhentai</span>
          <NhIcon name="open" size={14} color="#0a0a0a" stroke={2.2}/>
        </a>
      </div>
    </div>
  );

  if (embedded) return inner;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 110,
      background: "rgba(0,0,0,0.6)",
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
      animation: "nhFadeIn 200ms ease",
    }}>
      {inner}
    </div>
  );
}

function Stat({ icon, label, accent }: { icon: "pages" | "eye"; label: string; accent?: boolean }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 7px", borderRadius: 4, background: "var(--nh-pill-bg)" }}>
      <NhIcon name={icon} size={11} color={accent ? "var(--nh-accent)" : "var(--nh-text-2)"} stroke={1.8}/>
      <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 600, color: accent ? "var(--nh-accent)" : "var(--nh-text-1)" }}>{label}</span>
    </div>
  );
}

function DateCell({ label, days, fmt }: { label: string; days: number | null; fmt: (d: number | null) => string }) {
  return (
    <div style={{ background: "var(--nh-surface-2)", padding: "8px 10px" }}>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-1)", marginTop: 2 }}>{fmt(days)}</div>
    </div>
  );
}
