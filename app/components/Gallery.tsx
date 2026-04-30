"use client";

import { NhCover, NhBadge, NhIcon } from "./Primitives";
import type { Item } from "../lib/data";

type Density = "comfortable" | "compact";

export function GalleryCard({ item, onOpen, onTagClick, density }: {
  item: Item; onOpen: (i: Item) => void; onTagClick: (t: string) => void; density: Density;
}) {
  const lastReadStr = item.lastReadAt != null
    ? (item.lastReadAt === 0 ? "today" : item.lastReadAt < 7 ? `${item.lastReadAt}d` : item.lastReadAt < 30 ? `${Math.floor(item.lastReadAt/7)}w` : `${Math.floor(item.lastReadAt/30)}mo`)
    : null;
  const showRead = item.readCount > 0;
  const isCompact = density === "compact";
  const tagsToShow = isCompact ? item.tags.slice(0, 3) : item.tags.slice(0, 4);

  return (
    <div onClick={() => onOpen(item)} style={{ display: "flex", flexDirection: "column", gap: 6, cursor: "pointer", minWidth: 0 }}>
      <div style={{ position: "relative" }}>
        <NhCover item={item} size={isCompact ? "sm" : "card"} />
        <div style={{ position: "absolute", top: 6, right: 6, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
          <NhBadge icon={<NhIcon name="pages" size={9} stroke={2}/>} label={`${item.pages}p`} />
          {showRead && <NhBadge icon={<NhIcon name="eye" size={9} stroke={2}/>} label={item.readCount} accent />}
        </div>
        {lastReadStr && (
          <div style={{
            position: "absolute", bottom: 6, right: 6,
            fontFamily: "var(--nh-font-mono)", fontSize: 8.5,
            padding: "2px 5px", borderRadius: 3,
            background: "rgba(0,0,0,0.6)", color: "rgba(255,255,255,0.7)",
            letterSpacing: "0.04em", textTransform: "uppercase",
            backdropFilter: "blur(4px)",
          }}>read · {lastReadStr}</div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 1px", minWidth: 0 }}>
        <div style={{
          fontFamily: "var(--nh-font-display)",
          fontSize: isCompact ? 12 : 13.5, lineHeight: 1.2, fontWeight: 600,
          color: "var(--nh-text-1)", letterSpacing: "-0.01em",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{item.alterName || item.titleName}</div>
        <div style={{
          fontFamily: "var(--nh-font-mono)", fontSize: 10, lineHeight: 1.2,
          color: "var(--nh-accent)", textTransform: "lowercase",
          letterSpacing: "0.03em",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{item.artists[0]}</div>
        {!isCompact && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2, maxHeight: 32, overflow: "hidden" }}>
            {tagsToShow.map(t => (
              <button key={t} onClick={(e) => { e.stopPropagation(); onTagClick(t); }} style={{
                appearance: "none", border: 0,
                padding: "2.5px 5px", borderRadius: 3,
                background: "var(--nh-pill-bg)", color: "var(--nh-text-3)",
                fontFamily: "var(--nh-font-mono)", fontSize: 9, lineHeight: 1,
                cursor: "pointer", whiteSpace: "nowrap", letterSpacing: "0.02em",
              }}>{t}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function GalleryGrid({ items, onOpen, onTagClick, density }: {
  items: Item[]; onOpen: (i: Item) => void; onTagClick: (t: string) => void; density: Density;
}) {
  const cols = density === "compact" ? 3 : 2;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: density === "compact" ? 8 : 10,
      padding: "0 12px 24px",
    }}>
      {items.map(item => <GalleryCard key={item.hashtag} item={item} onOpen={onOpen} onTagClick={onTagClick} density={density} />)}
    </div>
  );
}
