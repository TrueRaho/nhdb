"use client";

import { useState, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Image from "next/image";
import type { Item } from "../lib/data";
import { mulberry32, paletteFor } from "../lib/cover-art";
import { cn } from "../lib/utils";

/** The options for a plain boolean SegmentedToggle. */
export const ON_OFF: readonly { id: boolean; label: string }[] = [
  { id: true, label: "on" },
  { id: false, label: "off" },
];

export type SegmentOption<T> = {
  id: T;
  label: ReactNode;
  /** Second, smaller line under the label (the mobile filter sheet's cards). */
  sub?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
};

// Per size: track padding (`pad` must match its class — the thumb is inset by
// it and sized from it), thumb radius (`r` must match — the solid overlay is
// clipped with it), segment box, and typography.
//
// Typography sits on the TRACK and is inherited, never set on the segments:
// globals.css has an unlayered `button { font-family: inherit }`, which beats
// any font-* utility on a <button>, while the overlay's spans would honour it —
// the two layers of labels would render in different fonts.
const SEGMENT_SIZES = {
  xs: { track: "rounded-sm p-0.5", pad: "2px", thumb: "rounded-xs", r: "0.125rem", item: "px-1.5 py-px", type: "font-mono text-[9px] font-semibold uppercase tracking-wider" },
  sm: { track: "rounded-md p-0.5", pad: "2px", thumb: "rounded-sm", r: "0.3rem", item: "h-6.5 px-2", type: "font-mono text-[10px] font-semibold tracking-wide" },
  md: { track: "rounded-lg p-0.75", pad: "3px", thumb: "rounded-md", r: "0.4rem", item: "px-2.5 py-2 text-left", type: "" },
  tab: { track: "rounded-lg p-0.5", pad: "2px", thumb: "rounded-md", r: "0.4rem", item: "h-8 px-3", type: "font-mono text-[11px] font-semibold uppercase tracking-wide" },
} as const;

/** One curve for everything that moves or recolours with the thumb, so nothing lags it. */
const SLIDE = "duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";

/**
 * A one-of-N control whose highlight SLIDES to the chosen segment.
 *
 * Every segmented control in the app used to be a row of buttons that each
 * painted their own background, so the highlight jumped — and the ones built
 * from the shadcn Button also dipped 1px on press. It looked like a slider and
 * behaved like buttons. Here one thumb sits under all segments and moves with
 * a transform; segments are equal width (grid auto-cols-fr), which is what
 * makes `translateX(index * 100%)` land exactly on a segment with no measuring
 * — so it is correct in the server HTML and never flashes on hydration.
 *
 * On the solid tone the selected label is dark on orange and the others light
 * on dark, so cross-fading label colours leaves both unreadable mid-slide.
 * Instead a second copy of the labels, already in the selected colours, sits
 * on top and is clipped to the thumb's shape; the clip moves with the thumb, so
 * text is dark exactly where the orange is, at every frame.
 *
 * Semantics follow the ARIA radio group (or tabs, for view switchers): one tab
 * stop, arrow keys move and select, focus is drawn around the whole track.
 */
export function Segmented<T extends string | number | boolean>({
  value, options, onChange, label, disabled = false, tone = "solid", size = "sm",
  kind = "radio", controls, bare = false, fullWidth = false, className,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  /** "solid" fills the thumb with the accent (a setting); "soft" tints it (navigation). */
  tone?: "solid" | "soft";
  size?: keyof typeof SEGMENT_SIZES;
  /** "tab" for switching between views, "radio" for picking a value. */
  kind?: "radio" | "tab";
  /**
   * With kind="tab": id of the panel the tabs switch. Tabs get the ids
   * `${controls}-tab-${id}` for the panel's aria-labelledby.
   */
  controls?: string;
  /** No track border/background — for header tabs that sit on the bar itself. */
  bare?: boolean;
  fullWidth?: boolean;
  className?: string;
}) {
  const s = SEGMENT_SIZES[size];
  const found = options.findIndex((o) => o.id === value);
  const index = Math.max(0, found);
  const n = options.length;
  const solid = tone === "solid";

  // Re-picking the current value is not a change: callers build a new filters
  // object on every call, which would refetch (and reshuffle a random sort).
  const pick = (id: T) => { if (id !== value) onChange(id); };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Alt+Arrow is browser Back on Windows/Linux; leave modified keys alone.
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    const next = step !== undefined ? (index + step + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    pick(options[next].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-segment]")[next]?.focus();
  }

  const layout = (o: SegmentOption<T>) => cn(
    "flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap",
    s.item,
    o.sub && "flex-col items-start justify-start gap-0.5 whitespace-normal",
  );
  const content = (o: SegmentOption<T>, onThumb: boolean) => {
    const Icon = o.icon;
    return (
      <>
        {Icon && <Icon className="size-3.25 shrink-0" />}
        {o.sub ? (
          <>
            <span className="font-display text-xs font-bold tracking-[-0.01em]">{o.label}</span>
            <span className={cn("font-mono text-[9px] tracking-[0.02em]", onThumb ? "text-black/70" : "text-nh-text-2/70")}>
              {o.sub}
            </span>
          </>
        ) : (
          o.label
        )}
      </>
    );
  };

  return (
    <div
      role={kind === "tab" ? "tablist" : "radiogroup"}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "relative isolate grid grid-flow-col auto-cols-fr",
        // The ring goes around the track: on a solid thumb an accent ring on
        // the focused (= selected) segment would be orange on orange.
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-nh-accent",
        !bare && "border border-nh-border bg-nh-input",
        fullWidth ? "w-full" : "w-fit",
        s.track,
        s.type,
        disabled && "opacity-40",
        className,
      )}
      style={{ "--seg-pad": s.pad } as CSSProperties}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-(--seg-pad) bottom-(--seg-pad) left-(--seg-pad) -z-10 transition-transform",
          SLIDE,
          s.thumb,
          solid
            ? "bg-nh-accent shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
            : "bg-nh-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nh-accent)_35%,transparent)]",
          found < 0 && "opacity-0",
        )}
        style={{ width: `calc((100% - 2 * var(--seg-pad)) / ${n})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const sel = i === found;
        return (
          <button
            // Ids can be booleans, which React will not take as a key.
            key={String(o.id)}
            type="button"
            data-segment
            role={kind === "tab" ? "tab" : "radio"}
            {...(kind === "tab"
              ? { "aria-selected": sel, id: controls ? `${controls}-tab-${String(o.id)}` : undefined, "aria-controls": sel ? controls : undefined }
              : { "aria-checked": sel })}
            tabIndex={i === index ? 0 : -1}
            disabled={disabled}
            onClick={() => pick(o.id)}
            className={cn(
              // Browsers reset button casing; inherit the track's uppercase too.
              "relative outline-hidden touch-manipulation [-webkit-tap-highlight-color:transparent] [text-transform:inherit]",
              layout(o),
              solid
                ? "text-nh-text-2 enabled:hover:text-nh-text-1"
                : cn("transition-colors", SLIDE, sel ? "text-nh-accent" : "text-nh-text-2 enabled:hover:text-nh-text-1"),
            )}
          >
            {content(o, false)}
          </button>
        );
      })}
      {solid && found >= 0 && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-(--seg-pad) z-10 grid grid-flow-col auto-cols-fr bg-nh-accent text-[#0a0a0a] transition-[clip-path]",
            SLIDE,
          )}
          style={{ clipPath: `inset(0 ${((n - 1 - index) * 100) / n}% 0 ${(index * 100) / n}% round ${s.r})` }}
        >
          {options.map((o) => (
            <span key={String(o.id)} className={layout(o)}>{content(o, true)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The compact segmented control the filter UI is built out of: option sort,
 * match mode, related-tag expansion, ghost tags. Four hand-rolled copies of
 * this markup had drifted into the tree before it was lifted here.
 *
 * Generic over the option id so callers keep their own union type — a
 * MatchToggle still hands back "and" | "or", not a string.
 */
export function SegmentedToggle<T extends string | number | boolean>({
  value, options, onChange, disabled, label,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
  /** Greys the whole control out — used where the choice is not yet meaningful. */
  disabled?: boolean;
  /** Accessible name; the visible caption beside the control. */
  label: string;
}) {
  return <Segmented value={value} options={options} onChange={onChange} disabled={disabled} label={label} size="xs" />;
}

const SIZE_PX = { sm: 140, card: 280, large: 360 } as const;

export function NhCover({ item, size = "card" }: { item: Item; size?: "card" | "large" | "sm" }) {
  const hasImage = !!item.imageLink;
  const [loaded, setLoaded] = useState(false);
  const [a, b] = paletteFor(item.hashtag);
  const rng = mulberry32(item.hashtag);
  rng(); rng();
  const angle = Math.floor(rng() * 360);
  const ringCount = 3 + Math.floor(rng() * 3);
  const accent = a;
  const fontPx = size === "large" ? 22 : size === "sm" ? 11 : 14;
  const subPx = size === "large" ? 11 : 9;
  const px = SIZE_PX[size];

  return (
    <div
      className="relative w-full aspect-[350/500] overflow-hidden rounded-[var(--nh-radius-card)]"
      style={{
        background: `linear-gradient(${angle}deg, ${a}, ${b})`,
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      {!hasImage && (
        <>
          <div
            className="absolute inset-0 mix-blend-overlay"
            style={{
              backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1.2px)",
              backgroundSize: "6px 6px",
            }}
          />
          <svg viewBox="0 0 100 140" preserveAspectRatio="none" className="absolute inset-0 w-full h-full opacity-35">
            {Array.from({ length: ringCount }).map((_, i) => (
              <circle key={i} cx={50 + (rng() - 0.5) * 40} cy={70 + (rng() - 0.5) * 60} r={20 + i * 18} fill="none" stroke="white" strokeWidth="0.4" />
            ))}
          </svg>
        </>
      )}

      {hasImage && (
        <Image
          src={item.imageLink}
          alt=""
          fill
          sizes={`${px}px`}
          loading="lazy"
          // The wrapper's procedural gradient is the placeholder; the cover fades
          // in over it once decoded — no stored blur, generated on the fly from
          // the hashtag. The ref covers cache hits (where onLoad may not fire) by
          // reading `complete` synchronously when the element mounts.
          onLoad={() => setLoaded(true)}
          ref={(el) => { if (el?.complete) setLoaded(true); }}
          className={`object-cover object-top transition-opacity duration-700 ease-out ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}

      <div
        className="absolute top-1.5 left-1.5 px-1.5 py-1 rounded-sm font-mono text-[9px] leading-none tracking-wider text-white/85 backdrop-blur-[4px]"
        style={{ background: "rgba(0,0,0,0.45)" }}
      >
        #{item.hashtag}
      </div>

      {!hasImage && (
        <>
          <div className="absolute top-0 bottom-0 left-2 w-px" style={{ background: "rgba(255,255,255,0.18)" }} />
          <div className="absolute left-2.5 right-2.5 bottom-2.5 flex flex-col gap-0.5">
            <div
              className="font-display font-bold text-white"
              style={{
                fontSize: fontPx,
                lineHeight: 1.05,
                letterSpacing: "-0.01em",
                textShadow: "0 1px 8px rgba(0,0,0,0.4)",
                textWrap: "balance" as never,
              }}
            >
              {item.alterName || item.titleName}
            </div>
            <div
              className="font-mono uppercase opacity-90"
              style={{ fontSize: subPx, color: accent, letterSpacing: "0.06em" }}
            >
              vol.{1 + (item.hashtag % 4)} · {item.pages}p
            </div>
          </div>
        </>
      )}
    </div>
  );
}
