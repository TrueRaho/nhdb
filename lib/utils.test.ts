import { describe, expect, it } from "vitest";
import { daysAgoLabel, extractHashtag, parseInputs, readAddParam } from "./utils";

// A realistic iOS Safari "Copy Links" payload: every open tab, page title and
// URL interleaved. This is the input the add box exists for, so it doubles as
// the regression guard for the parser's whole reason to be.
const COPY_LINKS_DUMP = `Morning Ledger Qiifeco | Page 3 of 12
https://nhentai.net/g/177013/
[Artist] 4 Girls, 24 pages - Read Online
https://nhentai.net/g/895243/
Chapter 7 (2019 reprint)
https://nhentai.net/g/820175/`;

describe("parseInputs", () => {
  it("reads a single id, with or without the hash", () => {
    expect(parseInputs("177013")).toEqual([177013]);
    expect(parseInputs("#177013")).toEqual([177013]);
    expect(parseInputs("  177013  ")).toEqual([177013]);
  });

  it("splits on commas, spaces and newlines alike", () => {
    expect(parseInputs("820175, 831895 563281\n895243")).toEqual([820175, 831895, 563281, 895243]);
  });

  it("reads gallery URLs in any surrounding punctuation", () => {
    expect(parseInputs("https://nhentai.net/g/177013/")).toEqual([177013]);
    expect(parseInputs("nhentai.net/g/177013")).toEqual([177013]);
    expect(parseInputs("https://www.nhentai.net/g/177013/")).toEqual([177013]);
    expect(parseInputs("[A title](https://nhentai.net/g/831895/)")).toEqual([831895]);
    expect(parseInputs('"https://nhentai.net/g/831895/"')).toEqual([831895]);
  });

  it("mixes bare ids and URLs (the add box placeholder)", () => {
    expect(parseInputs("177013\nnhentai.net/g/895243\n820175, 831895, 563281"))
      .toEqual([177013, 895243, 820175, 831895, 563281]);
  });

  it("keeps paste order and drops duplicates, URL and bare form alike", () => {
    expect(parseInputs("nhentai.net/g/2222222 111111")).toEqual([2222222, 111111]);
    expect(parseInputs("895243, 177013, 895243")).toEqual([895243, 177013]);
    expect(parseInputs("177013 https://nhentai.net/g/177013/")).toEqual([177013]);
  });

  it("pulls only the real ids out of a Copy Links dump", () => {
    // The titles carry 2016, 3, 12, 4, 24, 7 and 2019 — none may survive.
    expect(parseInputs(COPY_LINKS_DUMP)).toEqual([177013, 895243, 820175]);
  });

  it("trusts any digit run when the whole input is numbers (typed by hand)", () => {
    expect(parseInputs("1234")).toEqual([1234]);
    expect(parseInputs("#42, 7")).toEqual([42, 7]);
  });

  it("trusts only id-shaped runs once prose is mixed in", () => {
    expect(parseInputs("read 3 of 12 chapters in 2024")).toEqual([]);
    expect(parseInputs("page 24 · 12345678 · 2019")).toEqual([]);
  });

  it("still takes a short id from a URL inside prose", () => {
    expect(parseInputs("an old one https://nhentai.net/g/42/ from 2013")).toEqual([42]);
  });

  it("returns an empty list for nothing usable", () => {
    expect(parseInputs("")).toEqual([]);
    expect(parseInputs("   \n  ")).toEqual([]);
    expect(parseInputs("hello world")).toEqual([]);
  });

  it("returns numbers, not strings", () => {
    expect(parseInputs("nhentai.net/g/007")).toEqual([7]);
  });

  // Documented consequences of the "prose means strict" rule — asserted so a
  // future loosening of the heuristic is a deliberate change, not a surprise.
  describe("known limitations", () => {
    it("drops a pre-10000 bare id when prose is present", () => {
      expect(parseInputs("old gallery 4242 from the archive")).toEqual([]);
    });

    it("accepts an id-shaped number that is really part of a title", () => {
      expect(parseInputs("Serial Experiments 123456 - Read Online")).toEqual([123456]);
    });
  });
});

describe("readAddParam", () => {
  it("reads one id", () => {
    expect(readAddParam("?add=177013")).toEqual([177013]);
    expect(readAddParam("add=177013")).toEqual([177013]);
  });

  it("reads a comma separated batch in order", () => {
    expect(readAddParam("?add=177013,895243,820175")).toEqual([177013, 895243, 820175]);
  });

  it("reads a percent-encoded nhentai URL (what a share sheet hands over)", () => {
    expect(readAddParam("?add=https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F")).toEqual([177013]);
  });

  it("joins repeated params instead of dropping all but the first", () => {
    expect(readAddParam("?add=177013&add=895243")).toEqual([177013, 895243]);
  });

  it("ignores unrelated params", () => {
    expect(readAddParam("?utm_source=shortcut&add=177013&view=stats")).toEqual([177013]);
  });

  it("returns an empty list when there is nothing to add", () => {
    expect(readAddParam("")).toEqual([]);
    expect(readAddParam("?view=stats")).toEqual([]);
    expect(readAddParam("?add=")).toEqual([]);
    expect(readAddParam("?add=not-an-id")).toEqual([]);
  });
});

describe("extractHashtag", () => {
  it("reads bare, hashed and URL forms", () => {
    expect(extractHashtag("177013")).toBe(177013);
    expect(extractHashtag("  177013 ")).toBe(177013);
    expect(extractHashtag("#177013")).toBe(177013);
    expect(extractHashtag("https://nhentai.net/g/177013/")).toBe(177013);
  });

  it("returns null when there is no id", () => {
    expect(extractHashtag("")).toBeNull();
    expect(extractHashtag("nhentai.net/g/abc")).toBeNull();
    expect(extractHashtag("177013 895243")).toBeNull();
  });
});

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
