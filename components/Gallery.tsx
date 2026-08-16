"use client";

import { memo } from "react";
import { BookOpen, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { NhCover } from "./Primitives";
import { daysAgoLabel } from "../lib/utils";
import type { Item } from "../lib/data";

type Density = "comfortable" | "compact";

const overlayBadgeClass =
  "h-auto rounded-sm border-0 px-1.5 py-[3px] font-mono text-[9.5px] font-medium leading-none tracking-wider text-white/90 backdrop-blur-[4px] [&>svg]:size-[9px]! [&>svg]:opacity-85";

export const GalleryCard = memo(function GalleryCard({ item, onOpen, onTagClick, density }: {
  item: Item; onOpen: (i: Item) => void; onTagClick: (t: string) => void; density: Density;
}) {
  const showLastRead = item.lastReadAt != null;
  const lastReadStr = showLastRead ? daysAgoLabel(item.lastReadAt, "short") : "";
  const showRead = item.readCount > 0;
  const isCompact = density === "compact";
  const tagsToShow = isCompact ? item.tags.slice(0, 3) : item.tags.slice(0, 4);

  return (
    <div
      onClick={() => onOpen(item)}
      className="flex flex-col gap-1.5 cursor-pointer min-w-0"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 300px" } as React.CSSProperties}
    >
      <div className="relative">
        <NhCover item={item} size={isCompact ? "sm" : "card"} />
        <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
          <Badge className={overlayBadgeClass} style={{ background: "rgba(0,0,0,0.55)" }}>
            <BookOpen strokeWidth={2} />
            {item.pages}p
          </Badge>
          {showRead && (
            <Badge
              className={overlayBadgeClass}
              style={{ background: "rgba(0,0,0,0.55)", color: "var(--nh-accent)" }}
            >
              <Eye strokeWidth={2} />
              {item.readCount}
            </Badge>
          )}
        </div>
        {showLastRead && (
          <div
            className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-sm font-mono text-[8.5px] uppercase tracking-wider text-white/70 backdrop-blur-xs"
            style={{ background: "rgba(0,0,0,0.6)" }}
          >
            read · {lastReadStr}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.75 px-px min-w-0">
        <div
          className="font-display font-semibold text-nh-text-1 truncate"
          style={{ fontSize: isCompact ? 12 : 13.5, lineHeight: 1.2, letterSpacing: "-0.01em" }}
        >
          {item.alterName || item.titleName}
        </div>
        <div
          className="font-mono lowercase truncate text-nh-accent"
          style={{ fontSize: 10, lineHeight: 1.2, letterSpacing: "0.03em" }}
        >
          {item.artists[0]}
        </div>
        {!isCompact && (
          <div className="flex flex-wrap gap-0.75 mt-0.5 max-h-8 overflow-hidden">
            {tagsToShow.map(t => (
              <Badge
                key={t}
                variant="secondary"
                onClick={(e) => { e.stopPropagation(); onTagClick(t); }}
                className="h-auto cursor-pointer rounded-sm border-0 bg-nh-pill px-1.5 py-[2.5px] font-mono text-[9px] leading-none tracking-wide text-nh-text-3 hover:bg-nh-pill"
              >
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export function GalleryGrid({ items, onOpen, onTagClick, density }: {
  items: Item[]; onOpen: (i: Item) => void; onTagClick: (t: string) => void; density: Density;
}) {
  const cols = density === "compact" ? "grid-cols-3" : "grid-cols-2";
  const gap = density === "compact" ? "gap-2" : "gap-2.5";
  return (
    <div className={`grid ${cols} ${gap} px-3 pb-6`}>
      {items.map(item => <GalleryCard key={item.hashtag} item={item} onOpen={onOpen} onTagClick={onTagClick} density={density} />)}
    </div>
  );
}
