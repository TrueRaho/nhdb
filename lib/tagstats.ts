// Shared ground for both tag-scoring features: the statistic they rank with and
// the one fact about nhentai's tag vocabulary that both have to know.
//
// It exists because neither belongs to either feature. `lib/affinity.ts` asks
// "which tags characterise this selection?" and `lib/ghost.ts` asks "which tag
// is this title missing?" — different questions, deliberately kept apart (see
// the comment at the top of lib/ghost.ts). Before this module, ghost.ts imported
// both of these from affinity.ts, which read as though inference were built on
// top of suggestion. It is not; they are siblings over a common base.
//
// If a third consumer ever wants a tag profile over a population — "what
// characterises this artist?" is the obvious candidate, and getGhostIndex
// already builds the per-entity tallies it would need — the shared scoring core
// is worth lifting in here too. At two consumers it is not: the overlap is about
// ten lines of arithmetic, and merging them would put the two ranking metrics
// behind one flag, which is the single swap measured to cost the most.

/** 95% two-sided. */
const Z = 1.96;

/**
 * Lower bound of the Wilson score interval for `hits / trials`, clamped to
 * [0, 1] — "the rate is at least this, allowing for how little we've seen".
 *
 * Both features rank on it, for the same reason: a raw rate treats 3-out-of-3
 * and 300-out-of-300 as equal, and on a personal collection most evidence is
 * the former. The interval is wide when the sample is small, which drags
 * speculative candidates down without excluding them outright.
 *
 * What the two features do with it differs, and that difference is the whole
 * distinction between them: affinity divides it by the tag's base rate (ranking
 * by *informativeness*), inference uses it as-is (ranking by *probability*).
 */
export function wilsonLowerBound(hits: number, trials: number, z = Z): number {
  if (trials <= 0) return 0;
  const p = hits / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const lower = (centre - margin) / denom;
  return lower < 0 ? 0 : lower > 1 ? 1 : lower;
}

/**
 * Tags describing the *release format* rather than the content. They correlate
 * with everything and mean nothing either as a "you might also like" suggestion
 * or as an inferred tag, so both features drop them.
 *
 * Deliberately short: cast-composition tags (`sole male`, `sole female`) are NOT
 * here, because on a personal collection they can carry real signal. Extend or
 * empty it freely — nothing outside these two features reads this list.
 */
export const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  "tankoubon",
  "full censorship",
  "uncensored",
  "full color",
  "multi-work series",
  "text cleaned",
]);
