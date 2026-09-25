// Deterministic procedural cover art: the gradient-and-rings placeholder a
// title without an image gets, reproducible from a numeric seed.
//
// Lives outside components/Primitives.tsx because that module is "use client":
// a server component importing a plain function from it gets a client
// reference, not something it can call. The auth screens draw their decorative
// mosaic on the server with the same generator, so the art is identical to the
// library's.

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The two gradient stops a seed's cover is painted with. */
export function paletteFor(seed: number): [string, string] {
  const rng = mulberry32(seed);
  const toHex = (n: number) =>
    "#" + Math.floor(n * 0xffffff).toString(16).padStart(6, "0");
  return [toHex(rng()), toHex(rng())];
}

/**
 * A gradient for identity art — the account avatar and its banner.
 *
 * Not paletteFor: raw random hex stops are fine behind a cover image, but about
 * a third of them leave a white initial under 3:1, and many are neon. Fixed
 * lightness and chroma with only the hue seeded keeps every account's colour
 * distinct, legible and quiet next to the amber accent.
 */
export function identityPalette(seed: number): [string, string] {
  const rng = mulberry32(seed);
  const h = Math.floor(rng() * 360);
  return [`oklch(0.62 0.14 ${h})`, `oklch(0.46 0.12 ${(h + 40) % 360})`];
}

/** Stable small integer for a string (FNV-1a), for seeding art from text. */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
