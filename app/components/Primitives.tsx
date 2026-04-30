"use client";

import { mulberry32, type Item } from "../lib/data";

export function NhCover({ item, size = "card" }: { item: Item; size?: "card" | "large" | "sm" }) {
  const hasImage = !!item.imageLink;
  const [a, b] = item.palette;
  const rng = mulberry32(item.seed);
  const angle = Math.floor(rng() * 360);
  const ringCount = 3 + Math.floor(rng() * 3);
  const accent = a;
  const fontPx = size === "large" ? 22 : size === "sm" ? 11 : 14;
  const subPx = size === "large" ? 11 : 9;

  return (
    <div style={{
      position: "relative", width: "100%", aspectRatio: "350/500",
      borderRadius: "var(--nh-radius-card)", overflow: "hidden",
      background: `linear-gradient(${angle}deg, ${a}, ${b})`,
      boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
    }}>
      {/* gradient decorations — shown only when there's no real cover */}
      {!hasImage && (
        <>
          <div style={{
            position: "absolute", inset: 0,
            backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1.2px)",
            backgroundSize: "6px 6px", mixBlendMode: "overlay",
          }} />
          <svg viewBox="0 0 100 140" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.35 }}>
            {Array.from({ length: ringCount }).map((_, i) => (
              <circle key={i} cx={50 + (rng() - 0.5) * 40} cy={70 + (rng() - 0.5) * 60} r={20 + i * 18} fill="none" stroke="white" strokeWidth="0.4" />
            ))}
          </svg>
        </>
      )}

      {/* real cover image — background-image div never affects layout, overflow:hidden clips it */}
      {hasImage && (
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: `url(${item.imageLink})`,
          backgroundSize: "cover",
          backgroundPosition: "center top",
        }} />
      )}

      {/* hashtag badge — always on top */}
      <div style={{
        position: "absolute", top: 6, left: 6,
        fontFamily: "var(--nh-font-mono)", fontSize: 9, lineHeight: 1,
        padding: "4px 6px", borderRadius: 4,
        background: "rgba(0,0,0,0.45)", color: "rgba(255,255,255,0.85)",
        letterSpacing: "0.04em", backdropFilter: "blur(4px)",
      }}>#{item.hashtag}</div>

      {/* text + line decoration — only on gradient fallback */}
      {!hasImage && (
        <>
          <div style={{ position: "absolute", top: 0, bottom: 0, left: 8, width: 1, background: "rgba(255,255,255,0.18)" }} />
          <div style={{
            position: "absolute", left: 10, right: 10, bottom: 10,
            display: "flex", flexDirection: "column", gap: 2,
          }}>
            <div style={{
              fontFamily: "var(--nh-font-display)", fontWeight: 700,
              fontSize: fontPx, lineHeight: 1.05, color: "#fff",
              letterSpacing: "-0.01em",
              textShadow: "0 1px 8px rgba(0,0,0,0.4)",
              textWrap: "balance" as never,
            }}>{item.alterName || item.titleName}</div>
            <div style={{
              fontFamily: "var(--nh-font-mono)", fontSize: subPx,
              color: accent, letterSpacing: "0.06em",
              textTransform: "uppercase", opacity: 0.9,
            }}>vol.{1 + (item.seed % 4)} · {item.pages}p</div>
          </div>
        </>
      )}
    </div>
  );
}

export function NhBadge({ icon, label, accent = false }: { icon?: React.ReactNode; label: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "3px 5px", borderRadius: 3,
      background: "rgba(0,0,0,0.55)",
      backdropFilter: "blur(4px)",
      color: accent ? "var(--nh-accent)" : "rgba(255,255,255,0.92)",
      fontFamily: "var(--nh-font-mono)",
      fontSize: 9.5, fontWeight: 500, lineHeight: 1,
      letterSpacing: "0.02em",
    }}>
      {icon && <span style={{ opacity: 0.85, display: "inline-flex" }}>{icon}</span>}
      <span>{label}</span>
    </div>
  );
}

type IconName =
  | "search" | "plus" | "stats" | "filter" | "close" | "pages" | "eye" | "clock"
  | "open" | "trash" | "shuffle" | "check" | "chevron-down" | "chevron-right"
  | "arrow-right" | "grid" | "sort";

export function NhIcon({ name, size = 16, color = "currentColor", stroke = 1.6 }: { name: IconName; size?: number; color?: string; stroke?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "search": return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "stats": return <svg {...common}><path d="M3 20V10M9 20V4M15 20v-6M21 20v-12"/></svg>;
    case "filter": return <svg {...common}><path d="M3 5h18M6 12h12M10 19h4"/></svg>;
    case "close": return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "pages": return <svg {...common}><rect x="4" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h6M8 11h6M8 15h4"/></svg>;
    case "eye": return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case "open": return <svg {...common}><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/></svg>;
    case "trash": return <svg {...common}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/></svg>;
    case "shuffle": return <svg {...common}><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>;
    case "check": return <svg {...common}><path d="m4 12 5 5 11-12"/></svg>;
    case "chevron-down": return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
    case "chevron-right": return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case "arrow-right": return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case "grid": return <svg {...common}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
    case "sort": return <svg {...common}><path d="M3 6h13M3 12h9M3 18h5"/><path d="m18 9 3-3-3-3M21 6v12"/></svg>;
    default: return null;
  }
}
