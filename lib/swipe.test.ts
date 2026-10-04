import { describe, expect, it } from "vitest";
import {
  FLICK_MIN, POSTPONE_GAP, SWIPE_DISTANCE, SWIPE_VELOCITY, TAP_MS, TAP_SLOP,
  classifyGesture, parseTrash, postpone, shuffled, withEntry, withoutHashtags,
  type TrashEntry,
} from "./swipe";

// A seeded source, so an order can be pinned.
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe("shuffled", () => {
  it("returns every item exactly once and leaves the input alone", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(input, seeded(7));
    expect([...out].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives a different order on another draw", () => {
    const input = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffled(input, seeded(1))).not.toEqual(shuffled(input, seeded(2)));
    expect(shuffled(input, seeded(3))).toEqual(shuffled(input, seeded(3)));
  });

  it("copes with nothing and with one", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled([9])).toEqual([9]);
  });
});

describe("postpone", () => {
  it("lets POSTPONE_GAP other titles go first", () => {
    expect(postpone([1, 2, 3, 4, 5, 6, 7])).toEqual([2, 3, 4, 5, 1, 6, 7]);
    expect(postpone([1, 2, 3, 4, 5, 6, 7]).indexOf(1)).toBe(POSTPONE_GAP);
  });

  it("goes last when fewer are left than the gap", () => {
    expect(postpone([1, 2, 3])).toEqual([2, 3, 1]);
    expect(postpone([1, 2])).toEqual([2, 1]);
  });

  it("changes nothing for a single card or none", () => {
    expect(postpone([1])).toEqual([1]);
    expect(postpone([])).toEqual([]);
  });

  it("takes another gap", () => {
    expect(postpone([1, 2, 3, 4], 1)).toEqual([2, 1, 3, 4]);
  });
});

describe("classifyGesture", () => {
  const W = 400; // a quarter is 100, under SWIPE_DISTANCE

  it("reads a short, quick press as a tap", () => {
    expect(classifyGesture(2, -3, 120, W)).toBe("tap");
    expect(classifyGesture(TAP_SLOP - 1, 0, TAP_MS, W)).toBe("tap");
  });

  it("does nothing for a long press that barely moved", () => {
    expect(classifyGesture(1, 1, TAP_MS + 1, W)).toBeNull();
  });

  it("springs back from a slow, short drag", () => {
    expect(classifyGesture(60, 5, 900, W)).toBeNull();
    expect(classifyGesture(0, -80, 900, W)).toBeNull();
  });

  it("commits along the dominant axis past the distance", () => {
    expect(classifyGesture(101, 30, 900, W)).toBe("right");
    expect(classifyGesture(-101, -40, 900, W)).toBe("left");
    expect(classifyGesture(20, 101, 900, W)).toBe("down");
    expect(classifyGesture(-20, -101, 900, W)).toBe("up");
  });

  it("scales with a narrow card, and caps on a wide one", () => {
    expect(classifyGesture(70, 0, 900, 280)).toBe("right"); // a quarter of 280 is 70
    expect(classifyGesture(SWIPE_DISTANCE, 0, 900, 2000)).toBe("right");
    expect(classifyGesture(SWIPE_DISTANCE - 1, 0, 900, 2000)).toBeNull();
    // unmeasured: falls back to the fixed distance
    expect(classifyGesture(SWIPE_DISTANCE - 1, 0, 900, 0)).toBeNull();
    expect(classifyGesture(SWIPE_DISTANCE, 0, 900, 0)).toBe("right");
  });

  it("takes a quick flick that has not gone the distance", () => {
    const ms = 40;
    const d = Math.max(FLICK_MIN, SWIPE_VELOCITY * ms);
    expect(classifyGesture(-d, 0, ms, W)).toBe("left");
    expect(classifyGesture(0, d, ms, W)).toBe("down");
    // too small to be a flick, however fast
    expect(classifyGesture(FLICK_MIN - 1, 0, 5, W)).toBeNull();
  });
});

describe("the deletion list", () => {
  const e = (hashtag: number): TrashEntry => ({ hashtag, label: `#${hashtag}`, titleName: `t${hashtag}`, imageLink: "", pages: 10 });

  it("keeps well-formed entries and drops the rest", () => {
    const raw = JSON.stringify([
      e(1),
      { hashtag: 2 },
      { hashtag: 1, titleName: "dupe" },
      { hashtag: 0 },
      { hashtag: 1.5 },
      null,
      "x",
    ]);
    // An entry saved before multi-site support has no label; it reads as "#<hashtag>".
    expect(parseTrash(raw)).toEqual([e(1), { hashtag: 2, label: "#2", titleName: "#2", imageLink: "", pages: 0 }]);
  });

  it("keeps a stored site label", () => {
    const raw = JSON.stringify([{ ...e(1_000_000_001), label: "hitomi 1234567" }]);
    expect(parseTrash(raw)[0].label).toBe("hitomi 1234567");
  });

  it.each([null, "", "{", "{}", "42"])("reads %j as empty", (raw) => {
    expect(parseTrash(raw)).toEqual([]);
  });

  it("adds once and removes by hashtag", () => {
    const list = withEntry(withEntry([e(1)], e(2)), e(1));
    expect(list.map((x) => x.hashtag)).toEqual([1, 2]);
    expect(withoutHashtags(list, [1]).map((x) => x.hashtag)).toEqual([2]);
    expect(withoutHashtags(list, new Set([1, 2]))).toEqual([]);
  });
});
