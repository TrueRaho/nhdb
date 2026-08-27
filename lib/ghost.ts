// Ghost tags: tags a title probably *should* carry but doesn't, inferred from
// the other works that share its artist / group / parody / characters.
//
// The problem they solve is an uploader who tagged a work with three tags. Such
// a title is effectively unfindable — every tag filter misses it — even though
// the collection knows a great deal about it through its artist.
//
// Evaluation hid tags from well-tagged titles and measured recall@10 with
// three tags left visible. Artist peers beat popularity and naive Bayes over
// the title's own tags; combining more signals added little for the complexity.
// So this file uses peer groups as prediction evidence and shares only the
// primitives in lib/tagstats.ts with affinity, not its ranking metric.
//
// Affinity asks which tag characterises a selection; ghosts ask which tag a
// title probably lacks. A rare tag A supported by few peers can have more
// lift than a common tag B supported by most peers, yet be less probable.
// Rank by Wilson-shrunk share; use lift only to reject uninformative groups.

import { STRUCTURAL_TAGS, wilsonLowerBound } from "./tagstats";

export type GhostSourceKind = "artist" | "group" | "parody" | "character";

/** One peer group: the works sharing an entity with the title being scored. */
export type GhostSource = {
  kind: GhostSourceKind;
  name: string;
  /** How many works the entity has here, EXCLUDING the title being scored. */
  peers: number;
  /** tag name → how many of those peers carry it. */
  tally: ReadonlyMap<string, number>;
};

export type GhostTag = {
  name: string;
  /** Peers carrying the tag, and how many peers there were. */
  co: number;
  of: number;
  /** co / of — "this fraction of the artist's other works have it". */
  share: number;
  /** share ÷ the tag's collection-wide rate. Only ever used as a gate. */
  lift: number;
  /** Wilson lower bound on `share`. The ranking key. */
  confidence: number;
  /** The peer group that vouched for it most strongly. */
  sourceKind: GhostSourceKind;
  sourceName: string;
};

/**
 * A peer group smaller than this is not evidence. Two works agreeing proves
 * nothing — at `peers = 2` every tag on the single other work scores 100%.
 */
export const MIN_PEER_WORKS = 3;

/** A tag has to be on at least half the peer group. Sweeping 0.4 → 0.6
 *  traded recall for precision; 0.5 keeps a balance between the two. */
export const MIN_SHARE = 0.5;

/**
 * Reject catch-all peer groups whose tag frequencies just repeat the
 * collection's base rates. Requiring a tag to be more common in the peer
 * group supplies evidence without a list of banned entity names.
 */
export const MIN_LIFT_OVER_BASE = 1.2;

/** Default ghosts per title. Predictions are uncertain; limiting the tail
 *  keeps weakly supported suggestions from overwhelming the reader. */
export const GHOST_LIMIT = 8;

/**
 * Infer ghost tags for one title.
 *
 * @param own            tags the title already carries — never suggested back
 * @param sources        its peer groups, already excluding the title itself
 * @param tagTotals      tag name → titles carrying it collection-wide
 * @param collectionCount total titles
 */
export function inferGhostTags(
  own: readonly string[],
  sources: readonly GhostSource[],
  tagTotals: ReadonlyMap<string, number>,
  collectionCount: number,
  limit = GHOST_LIMIT,
): GhostTag[] {
  if (collectionCount <= 0) return [];
  const has = new Set(own);
  const best = new Map<string, GhostTag>();

  for (const source of sources) {
    if (source.peers < MIN_PEER_WORKS) continue;
    for (const [name, co] of source.tally) {
      if (has.has(name) || STRUCTURAL_TAGS.has(name)) continue;
      // A tally counted over `peers` works cannot exceed it; a drifted count
      // would otherwise yield a share above 1 and an impossible confidence.
      const capped = Math.min(co, source.peers);
      const share = capped / source.peers;
      if (share < MIN_SHARE) continue;

      const baseRate = (tagTotals.get(name) ?? 0) / collectionCount;
      if (baseRate <= 0) continue;
      const lift = share / baseRate;
      if (lift < MIN_LIFT_OVER_BASE) continue;

      const confidence = wilsonLowerBound(capped, source.peers);
      const prev = best.get(name);
      // Strongest voucher wins: a tag on 4/4 of a small artist and 20/35 of a
      // big parody should be presented as whichever claim is better supported.
      if (prev && prev.confidence >= confidence) continue;
      best.set(name, {
        name, co: capped, of: source.peers, share, lift, confidence,
        sourceKind: source.kind, sourceName: source.name,
      });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit));
}
