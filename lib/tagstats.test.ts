import { describe, expect, it } from "vitest";
import { STRUCTURAL_TAGS, wilsonLowerBound } from "./tagstats";

describe("wilsonLowerBound", () => {
  it("sits below the observed rate and rises toward it as evidence accumulates", () => {
    const few = wilsonLowerBound(3, 3);
    const many = wilsonLowerBound(300, 300);
    expect(few).toBeLessThan(1);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(1);
  });

  it("shrinks a small sample harder than a large one at the same rate", () => {
    // Why both features rank on this rather than the raw rate: 3-of-3 and
    // 300-of-300 are the same fraction and very different evidence.
    expect(wilsonLowerBound(3, 3)).toBeLessThan(wilsonLowerBound(30, 30));
    expect(wilsonLowerBound(6, 10)).toBeLessThan(wilsonLowerBound(60, 100));
  });

  it("stays inside [0, 1] at the extremes", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeGreaterThan(0);
    expect(wilsonLowerBound(10, 10)).toBeLessThanOrEqual(1);
  });
});

describe("STRUCTURAL_TAGS", () => {
  it("holds release-format tags, not cast composition", () => {
    expect(STRUCTURAL_TAGS.has("tankoubon")).toBe(true);
    expect(STRUCTURAL_TAGS.has("full censorship")).toBe(true);
    // Deliberately absent: on a personal collection these carry real signal,
    // and excluding them is a taste call the scoring should not make.
    expect(STRUCTURAL_TAGS.has("sole male")).toBe(false);
    expect(STRUCTURAL_TAGS.has("sole female")).toBe(false);
  });
});
