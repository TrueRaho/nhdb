// Tag affinity: given a set of "seed" tags, which *other* tags are genuinely
// characteristic of the titles carrying them?
//
// The naive answers fail in opposite directions:
//   raw co-occurrence — ranks popularity. Two tags each covering about half
//     a collection share many titles even under independence.
//   raw lift (P(B|A) / P(B)) — ranks smallness. A tag appearing only with the
//     seed hits the ceiling N / seedCount even with very little evidence.
//
// Rank by the Wilson lower bound on P(B|A), expressed as lift. The interval
// penalises small samples; division by the base rate stops ubiquitous tags
// winning on popularity. Evaluation against raw count, raw lift, NPMI and
// Jaccard motivated this balance between support and distinctiveness.

import { STRUCTURAL_TAGS, wilsonLowerBound } from "./tagstats";

/** One candidate tag's raw counts, straight out of SQL. */
export type AffinityRow = {
  name: string;
  /** Titles in the seed set that also carry this tag. */
  co: number;
  /** Titles in the whole collection that carry this tag (tags.title_count). */
  total: number;
};

export type TagAffinity = {
  name: string;
  co: number;
  total: number;
  /** P(tag | seed set) — "this share of your matching titles carry it". */
  share: number;
  /** share ÷ the tag's collection-wide rate. 1 = exactly what chance predicts. */
  lift: number;
  /** Wilson-shrunk lift. Ranking key; never shown raw. */
  score: number;
};

/**
 * Minimum shared titles for a candidate to be considered at all. Below this the
 * Wilson bound is doing all the work and the result is a coin flip either way —
 * cheaper to cut it here than to explain a one-title "suggestion".
 */
export const MIN_SHARED_TITLES = 3;

/**
 * Minimum collection-wide titles for a candidate tag. Very rare tags offer
 * little evidence; without a floor they can crowd out supported associations.
 */
export const MIN_TAG_TITLES = 3;

/**
 * A suggestion has to beat chance by this much to be worth showing.
 *
 * Chosen by sweeping 1.1 … 2.5: focused seeds stayed stable, while a low
 * floor let broad seeds expand until the filter barely filtered. A higher
 * floor discarded useful broad-seed associations, so 1.5 keeps the balance.
 *
 * A seed covering fraction f of the collection cannot exceed lift 1/f.
 * A tag on half the collection has a ceiling of 2 and a narrow band above
 * this floor; few suggestions for a broad seed are expected.
 */
export const MIN_LIFT = 1.5;

/**
 * Rank candidate tags for a seed set, most characteristic first.
 *
 * @param rows          candidates with their raw counts
 * @param seedCount     titles in the seed set (the denominator of P(B|A))
 * @param collectionCount titles in the whole collection
 */
export function rankAffinity(
  rows: AffinityRow[],
  seedCount: number,
  collectionCount: number,
): TagAffinity[] {
  if (seedCount <= 0 || collectionCount <= 0) return [];

  const scored: TagAffinity[] = [];
  for (const row of rows) {
    if (STRUCTURAL_TAGS.has(row.name)) continue;
    if (row.co < MIN_SHARED_TITLES || row.total < MIN_TAG_TITLES) continue;
    // A tag cannot be on more of the seed set than the seed set holds, nor on
    // more titles overall than it shares with the seed set. Guard rather than
    // trust: `total` is the trigger-maintained tags.title_count, so a drifted
    // count would otherwise produce a share above 1 and a nonsense score.
    const co = Math.min(row.co, seedCount);
    const total = Math.max(row.total, co);
    const baseRate = total / collectionCount;
    if (baseRate <= 0) continue;

    const share = co / seedCount;
    const lift = share / baseRate;
    if (lift < MIN_LIFT) continue;

    scored.push({
      name: row.name,
      co,
      total,
      share,
      lift,
      score: wilsonLowerBound(co, seedCount) / baseRate,
    });
  }

  // Ties break on name so the order is stable across identical datasets —
  // suggestion chips that reshuffle between renders read as broken.
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}
