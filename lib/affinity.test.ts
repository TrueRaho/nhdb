import { describe, expect, it } from "vitest";
import {
  MIN_LIFT,
  MIN_SHARED_TITLES,
  MIN_TAG_TITLES,
  rankAffinity,
  type AffinityRow,
} from "./affinity";

const names = (rows: ReturnType<typeof rankAffinity>) => rows.map((r) => r.name);

describe("rankAffinity", () => {
  // Synthetic counts: a seed set of 100 titles inside a collection of 1000.
  const SEED = 100;
  const TOTAL = 1000;

  it("does not rank a collection-wide tag above a characteristic one", () => {
    const rows: AffinityRow[] = [
      // On 90% of everything; being on 92% of the seed set means nothing.
      { name: "everywhere", co: 92, total: 900 },
      // On 5% of the collection but a third of the seed set.
      { name: "characteristic", co: 33, total: 50 },
    ];
    expect(names(rankAffinity(rows, SEED, TOTAL))[0]).toBe("characteristic");
  });

  it("does not let a three-title tag outrank a well-evidenced one", () => {
    const rows: AffinityRow[] = [
      // Perfect confidence, no evidence: appears only with the seed, 3 titles.
      { name: "coincidence", co: 3, total: 3 },
      // Weaker per-title association, 40× the evidence.
      { name: "solid", co: 40, total: 60 },
    ];
    // Raw lift disagrees — it puts `coincidence` at 10.0 and `solid` at 6.7.
    const ranked = rankAffinity(rows, SEED, TOTAL);
    expect(ranked[0].name).toBe("solid");
    expect(ranked.find((r) => r.name === "coincidence")!.lift)
      .toBeGreaterThan(ranked[0].lift);
  });

  it("drops candidates below the support floors", () => {
    const rows: AffinityRow[] = [
      { name: "too-few-shared", co: MIN_SHARED_TITLES - 1, total: 40 },
      { name: "too-rare", co: MIN_TAG_TITLES, total: MIN_TAG_TITLES - 1 },
      { name: "kept", co: 20, total: 40 },
    ];
    expect(names(rankAffinity(rows, SEED, TOTAL))).toEqual(["kept"]);
  });

  it("rejects the big-tag-barely-above-chance case the floor exists for", () => {
    // A broad expansion needs the lift floor: a tag on a quarter of
    // everything, showing up on a
    // *slightly* larger share of the seed set. Real enough to clear the Wilson
    // bound on sheer volume, meaningless as a suggestion, and — being huge —
    // exactly the candidate that widens the query the most.
    const rows: AffinityRow[] = [{ name: "everywhere-ish", co: 30, total: 250 }];
    expect(rankAffinity(rows, SEED, TOTAL)).toEqual([]);
  });

  it("drops candidates that do not beat chance", () => {
    // 10% of the seed set, 10% of the collection — exactly independent.
    const rows: AffinityRow[] = [{ name: "chance", co: 10, total: 100 }];
    expect(rankAffinity(rows, SEED, TOTAL)).toEqual([]);
    // Same tag, enough above its base rate to clear the margin.
    const lifted: AffinityRow[] = [{ name: "chance", co: 40, total: 100 }];
    const [row] = rankAffinity(lifted, SEED, TOTAL);
    expect(row.lift).toBeGreaterThanOrEqual(MIN_LIFT);
  });

  it("excludes release-format tags", () => {
    const rows: AffinityRow[] = [
      { name: "tankoubon", co: 50, total: 60 },
      { name: "kept", co: 20, total: 40 },
    ];
    expect(names(rankAffinity(rows, SEED, TOTAL))).toEqual(["kept"]);
  });

  it("reports share and lift as the UI shows them", () => {
    const [row] = rankAffinity([{ name: "t", co: 30, total: 100 }], SEED, TOTAL);
    expect(row.share).toBeCloseTo(0.3);
    expect(row.lift).toBeCloseTo(3);
    expect(row.score).toBeLessThan(row.lift); // shrunk, never inflated
  });

  it("clamps counts that outrun the seed set instead of scoring above 1", () => {
    // tags.title_count is trigger-maintained; a drifted value must not produce
    // a share above 1.
    const [row] = rankAffinity([{ name: "t", co: SEED + 20, total: 5 }], SEED, TOTAL);
    expect(row.share).toBeLessThanOrEqual(1);
    expect(row.co).toBe(SEED);
    expect(row.total).toBe(SEED);
  });

  it("breaks ties on name so chip order is stable", () => {
    const rows: AffinityRow[] = [
      { name: "beta", co: 30, total: 100 },
      { name: "alpha", co: 30, total: 100 },
    ];
    expect(names(rankAffinity(rows, SEED, TOTAL))).toEqual(["alpha", "beta"]);
  });

  it("returns nothing for an empty seed set or an empty collection", () => {
    const rows: AffinityRow[] = [{ name: "t", co: 30, total: 100 }];
    expect(rankAffinity(rows, 0, TOTAL)).toEqual([]);
    expect(rankAffinity(rows, SEED, 0)).toEqual([]);
    expect(rankAffinity([], SEED, TOTAL)).toEqual([]);
  });
});
