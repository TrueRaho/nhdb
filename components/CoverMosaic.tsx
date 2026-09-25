import { mulberry32, paletteFor } from "@/lib/cover-art";
import { cn } from "@/lib/utils";

// Decorative wall of procedural covers for screens shown before sign-in.
//
// Drawn with the library's own placeholder generator, but from fixed seeds and
// with no text: nothing here may hint at anyone's collection, and a real
// gallery id on a tile would be exactly that. Server-rendered, no JS.

const SEEDS = Array.from({ length: 96 }, (_, i) => 104729 + i * 7919);

function Tile({ seed }: { seed: number }) {
  const [a, b] = paletteFor(seed);
  const rng = mulberry32(seed);
  rng(); rng();
  const angle = Math.floor(rng() * 360);
  const rings = Array.from({ length: 3 + Math.floor(rng() * 3) }, (_, i) => ({
    cx: 50 + (rng() - 0.5) * 40,
    cy: 70 + (rng() - 0.5) * 60,
    r: 20 + i * 18,
  }));
  return (
    <div
      className="relative aspect-[350/500] w-full overflow-hidden rounded-[var(--nh-radius-card)]"
      style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }}
    >
      <div
        className="absolute inset-0 mix-blend-overlay"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1.2px)",
          backgroundSize: "6px 6px",
        }}
      />
      <svg viewBox="0 0 100 140" preserveAspectRatio="none" className="absolute inset-0 size-full opacity-35">
        {rings.map((c, i) => (
          <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill="none" stroke="white" strokeWidth="0.4" />
        ))}
      </svg>
      <div className="absolute inset-y-0 left-2 w-px bg-white/20" />
    </div>
  );
}

/**
 * `columns` staggered columns of `perColumn` tiles. Muted and warm-tinted so
 * the random palettes sit under the amber accent instead of competing with it.
 *
 * Give columns a fixed width (`columnClassName`) where the container can get
 * wide: flexible columns grow into a few giant slabs on a big screen, whereas
 * fixed ones keep the wall's density and let the parent's overflow clip it.
 */
export function CoverMosaic({
  columns, perColumn, className, columnClassName = "min-w-0 flex-1",
}: { columns: number; perColumn: number; className?: string; columnClassName?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none relative flex gap-3 select-none", className)}>
      {Array.from({ length: columns }, (_, col) => (
        <div
          key={col}
          className={cn("flex flex-col gap-3", columnClassName)}
          style={{ transform: `translateY(${col % 2 ? -18 : 6}%)` }}
        >
          {SEEDS.slice(col * perColumn, (col + 1) * perColumn).map((seed) => (
            <Tile key={seed} seed={seed} />
          ))}
        </div>
      ))}
      <div className="absolute inset-0 bg-[#2a1a05] mix-blend-color opacity-60" />
    </div>
  );
}
