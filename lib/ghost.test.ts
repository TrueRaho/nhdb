import { describe, expect, it } from "vitest";
import {
  GHOST_LIMIT,
  MIN_LIFT_OVER_BASE,
  MIN_PEER_WORKS,
  MIN_SHARE,
  inferGhostTags,
  type GhostSource,
} from "./ghost";

const TOTAL = 1000;

/** A peer group, written the way the counts read: "4 of these 5 have `x`". */
function source(name: string, peers: number, tally: Record<string, number>, kind: GhostSource["kind"] = "artist"): GhostSource {
  return { kind, name, peers, tally: new Map(Object.entries(tally)) };
}

const totals = (o: Record<string, number>) => new Map(Object.entries(o));
const names = (g: ReturnType<typeof inferGhostTags>) => g.map(x => x.name);

describe("inferGhostTags", () => {
  it("proposes what the artist's other works agree on", () => {
    const g = inferGhostTags(
      ["tag A"],
      [source("artist A", 4, { "tag B": 4, "tag C": 3, "tag D": 2 })],
      totals({ "tag B": 169, "tag C": 330, "tag D": 118 }),
      TOTAL,
    );
    expect(names(g)).toEqual(["tag B", "tag C", "tag D"]);
    expect(g[0]).toMatchObject({ co: 4, of: 4, sourceKind: "artist", sourceName: "artist A" });
  });

  it("never suggests a tag the title already has", () => {
    const g = inferGhostTags(
      ["tag C"],
      [source("a", 4, { "tag C": 4, "tag E": 3 })],
      totals({ "tag C": 100, "tag E": 100 }),
      TOTAL,
    );
    expect(names(g)).toEqual(["tag E"]);
  });

  it("ignores a peer group too small to be evidence", () => {
    // At two works, every tag on the single other work scores a perfect 100%.
    const tiny = source("two-work artist", MIN_PEER_WORKS - 1, { "tag F": 1, "tag G": 1, "tag H": 1 });
    expect(inferGhostTags([], [tiny], totals({ "tag F": 5, "tag G": 5, "tag H": 5 }), TOTAL)).toEqual([]);
  });

  it("ignores tags the peer group only sometimes carries", () => {
    const g = inferGhostTags(
      [],
      [source("a", 10, { yes: Math.ceil(10 * MIN_SHARE), no: Math.floor(10 * MIN_SHARE) - 1 })],
      totals({ yes: 50, no: 50 }),
      TOTAL,
    );
    expect(names(g)).toEqual(["yes"]);
  });

  it("rejects a catch-all source whose tags are just the collection average", () => {
    // Synthetic catch-all peers repeat the collection's tag rates. A large
    // source must still pass the lift gate rather than win on volume alone.
    const g = inferGhostTags(
      [],
      [source("catch-all", 250, { "tag I": 140, "tag C": 130 }, "parody")],
      totals({ "tag I": 580, "tag C": 520 }),
      TOTAL,
    );
    expect(g).toEqual([]);
  });

  it("keeps a big source when it genuinely differs from the collection", () => {
    const g = inferGhostTags(
      [],
      [source("artist B", 37, { "tag C": 33 }, "artist")],
      // 89% of the artist against 20% of the collection.
      totals({ "tag C": 200 }),
      TOTAL,
    );
    expect(names(g)).toEqual(["tag C"]);
    expect(g[0].lift).toBeGreaterThan(MIN_LIFT_OVER_BASE);
  });

  it("prefers the better-supported voucher when two sources agree", () => {
    const g = inferGhostTags(
      [],
      [
        source("small artist", 3, { "tag E": 3 }, "artist"),
        source("big parody", 40, { "tag E": 36 }, "parody"),
      ],
      totals({ "tag E": 200 }),
      TOTAL,
    );
    // 3/3 and 36/40 are both 90%+, but only one of them is actually evidence.
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ sourceKind: "parody", co: 36, of: 40 });
  });

  it("excludes release-format tags, as the affinity ranking does", () => {
    const g = inferGhostTags(
      [],
      [source("a", 5, { tankoubon: 5, "tag E": 4 })],
      totals({ tankoubon: 22, "tag E": 200 }),
      TOTAL,
    );
    expect(names(g)).toEqual(["tag E"]);
  });

  it("clamps a tally that outruns its peer count", () => {
    const g = inferGhostTags([], [source("a", 4, { "tag E": 9 })], totals({ "tag E": 200 }), TOTAL);
    expect(g[0]).toMatchObject({ co: 4, of: 4, share: 1 });
  });

  it("caps the list and returns the strongest first", () => {
    const tally: Record<string, number> = {}, tot: Record<string, number> = {};
    for (let i = 0; i < GHOST_LIMIT + 5; i++) { tally[`t${i}`] = 10 - (i % 3); tot[`t${i}`] = 100; }
    const g = inferGhostTags([], [source("a", 10, tally)], totals(tot), TOTAL);
    expect(g).toHaveLength(GHOST_LIMIT);
    for (let i = 1; i < g.length; i++) expect(g[i - 1].confidence).toBeGreaterThanOrEqual(g[i].confidence);
  });

  it("returns nothing without sources or without a collection", () => {
    expect(inferGhostTags([], [], totals({}), TOTAL)).toEqual([]);
    expect(inferGhostTags([], [source("a", 5, { "tag E": 5 })], totals({ "tag E": 200 }), 0)).toEqual([]);
  });
});
