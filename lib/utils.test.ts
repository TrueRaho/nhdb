import { describe, expect, it } from "vitest";
import { daysAgoLabel } from "./utils";

describe("daysAgoLabel", () => {
  it("renders null as a dash so callers can print it directly", () => {
    expect(daysAgoLabel(null)).toBe("—");
    expect(daysAgoLabel(null, "short")).toBe("—");
  });

  it("clamps today and clock-skewed futures", () => {
    expect(daysAgoLabel(0)).toBe("today");
    expect(daysAgoLabel(-5)).toBe("today");
    expect(daysAgoLabel(-5, "short")).toBe("today");
  });

  it("scales the long form through days, weeks, months and years", () => {
    expect(daysAgoLabel(3)).toBe("3 days ago");
    expect(daysAgoLabel(14)).toBe("2 weeks ago");
    expect(daysAgoLabel(60)).toBe("2 months ago");
    expect(daysAgoLabel(400)).toBe("1.1 years ago");
  });

  it("scales the short form the same way", () => {
    expect(daysAgoLabel(3, "short")).toBe("3d");
    expect(daysAgoLabel(14, "short")).toBe("2w");
    expect(daysAgoLabel(60, "short")).toBe("2mo");
  });
});
