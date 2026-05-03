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
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${item.imageLink})`,
            backgroundSize: "cover",
            backgroundPosition: "center top",
          }}
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
              vol.{1 + (item.seed % 4)} · {item.pages}p
            </div>
          </div>
        </>
      )}
    </div>
  );
}
