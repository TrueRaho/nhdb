import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTITY_KINDS, normalizeEntityName, parseScrapePayload, type EntityKind } from "../scrape-payload";
import { galleryIdOf, refFromUrl, refKey, siteKey } from "../sources";
import { readPage, type PageReading } from "./extract";

// The fixture corpus: one `<id>.html` (a page as a site serves it, or as the
// browser layer sees it after its scripts ran) and one `<id>.json` saying what
// reading it must give. The directory is read when the suite runs, so a new
// fixture is a new test without touching this file. A fixture's expectation:
//
//   url          where the page was served from (the reading's pageUrl)
//   rendered     true when the HTML is the DOM after JavaScript ran
//   expect.gallery     true: the page is a title; false: it is not
//   expect.follow      (gallery false) the link the reading must follow instead
//   expect.source_id   the id galleryIdOf finds in `url`
//   expect.title_name / pages / uploaded_at / image_link — exact, when given
//                      (uploaded_at: null means "no day on the page")
//   expect.<kind>      names that must be among the title's <kind>; an empty
//                      list means the title has none of that kind
//   expect.not.<kind>  names that must NOT be among the title's <kind>
//   expect.exact.<kind>  the complete set of names, without extra entities
//
// Names compare through normalizeEntityName, the fold the write boundary
// applies, so a fixture may write "Big Breasts" for "big breasts". A gallery
// reading must also pass the write boundary under the page's own key — what
// the scraper does with it next.

interface Expectation {
  gallery: boolean;
  follow?: string;
  source_id?: string;
  title_name?: string;
  pages?: number;
  uploaded_at?: string | null;
  image_link?: string;
  not?: Partial<Record<EntityKind, string[]>>;
  exact?: Partial<Record<EntityKind, string[]>>;
  tags?: string[];
  artists?: string[];
  groups?: string[];
  characters?: string[];
  parodies?: string[];
}

interface Fixture {
  url: string;
  description?: string;
  rendered?: boolean;
  expect: Expectation;
}

// Checks the reader does not pass yet, per fixture — each a production defect
// in extract.ts, traced to its cause. The fixture's own test runs every OTHER
// check; each listed one runs as its own `it.fails`, which turns red the day
// the reader gets it right — then delete it here. Check names:
//   reading                       read as the right kind (gallery / follow / refusal);
//                                 listing it moves every reading-dependent check here
//   source_id, title_name, pages, uploaded_at, image_link, storable
//   <kind>:<name>  <kind>:empty   a required name / an empty kind
//   not.<kind>:<name>             a forbidden name
//   <prefix>*                     every check whose name starts with <prefix>
// Empty: every fixture reads right. A new fixture the reader gets wrong goes here
// with its cause until a GENERIC rule fixes it (never a branch for one site).
const KNOWN_MISSES: Record<string, { checks: string[]; why: string }> = {};

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const ids = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();

const EXPECT_KEYS = new Set(["gallery", "follow", "source_id", "title_name", "pages", "uploaded_at", "image_link", "not", "exact", ...ENTITY_KINDS]);
const fold = (names: string[]) => names.map(normalizeEntityName);

function load(id: string): { fx: Fixture; html: string } {
  const fx = JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as Fixture;
  const htmlPath = join(DIR, `${id}.html`);
  if (!existsSync(htmlPath)) throw new Error(`${id}.json has no ${id}.html beside it`);
  // An expectation this file does not know would be silently skipped.
  if (typeof fx.url !== "string") throw new Error(`${id}.json: url must be a string`);
  if (typeof fx.expect?.gallery !== "boolean") throw new Error(`${id}.json: expect.gallery must be a boolean`);
  for (const key of Object.keys(fx.expect)) if (!EXPECT_KEYS.has(key)) throw new Error(`${id}.json: unknown expectation "${key}"`);
  for (const key of Object.keys(fx.expect.not ?? {})) {
    if (!(ENTITY_KINDS as readonly string[]).includes(key)) throw new Error(`${id}.json: unknown expectation "not.${key}"`);
  }
  for (const [key, names] of Object.entries(fx.expect.exact ?? {})) {
    if (!(ENTITY_KINDS as readonly string[]).includes(key) || !Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new Error(`${id}.json: invalid expectation "exact.${key}"`);
    }
  }
  return { fx, html: readFileSync(htmlPath, "utf8") };
}

interface Check {
  name: string;
  run: () => void;
}

// Every check the fixture asks for. The reading-dependent ones exist only
// once the page was read as the gallery it should be.
function checksOf(fx: Fixture, reading: PageReading): { independent: Check[]; dependent: Check[] } {
  const want = fx.expect;
  const shown = JSON.stringify(reading).slice(0, 300);
  const independent: Check[] = [{
    name: "reading",
    run: () => {
      if (want.gallery) expect(reading.kind, `read as a gallery: ${shown}`).toBe("gallery");
      else if (want.follow !== undefined) expect(reading, "the reading must follow the gallery link").toMatchObject({ kind: "follow", url: want.follow });
      else expect(reading.kind, `refused, not read: ${shown}`).toBe("none");
    },
  }];
  if (want.source_id !== undefined) {
    independent.push({ name: "source_id", run: () => expect(galleryIdOf(new URL(fx.url)), "galleryIdOf(url)").toBe(want.source_id) });
  }
  if (!want.gallery || reading.kind !== "gallery") return { independent, dependent: [] };

  const title = reading.title;
  const dependent: Check[] = [];
  for (const field of ["title_name", "pages", "uploaded_at", "image_link"] as const) {
    if (want[field] !== undefined) dependent.push({ name: field, run: () => expect(title[field], field).toBe(want[field]) });
  }
  for (const kind of ENTITY_KINDS) {
    const got = fold(title[kind].map((e) => e.name));
    const exact = want.exact?.[kind];
    if (exact !== undefined) {
      dependent.push({ name: `exact.${kind}`, run: () => expect([...got].sort(), `${kind}: exact names`).toEqual(fold(exact).sort()) });
    }
    const required = want[kind];
    if (required !== undefined && required.length === 0) {
      dependent.push({ name: `${kind}:empty`, run: () => expect(got, `${kind} must be empty`).toEqual([]) });
    }
    for (const name of fold(required ?? [])) {
      dependent.push({ name: `${kind}:${name}`, run: () => expect(got, `${kind} must include "${name}"`).toContain(name) });
    }
    for (const name of fold(want.not?.[kind] ?? [])) {
      dependent.push({ name: `not.${kind}:${name}`, run: () => expect(got, `${kind} must not include "${name}"`).not.toContain(name) });
    }
  }
  dependent.push({
    name: "storable",
    run: () => {
      const ref = refFromUrl(fx.url);
      expect(ref, "the fixture url names a title").not.toBeNull();
      const stored = parseScrapePayload({ source: ref!.source, source_id: ref!.id, url: ref!.url, ...title });
      expect(refKey({ source: stored.source, id: stored.source_id })).toBe(refKey(ref!));
      expect(stored.source).toBe(siteKey(new URL(fx.url).hostname));
    },
  });
  return { independent, dependent };
}

const matches = (pattern: string, name: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

/** The fixture's checks, split into those that must pass and its known misses. */
function plan(id: string): { passing: Check[]; misses: Check[]; stale: string[] } {
  const { fx, html } = load(id);
  const { independent, dependent } = checksOf(fx, readPage(html, fx.url));
  const patterns = KNOWN_MISSES[id]?.checks ?? [];
  const missReading = patterns.includes("reading");
  const isMiss = (c: Check) => patterns.some((p) => matches(p, c.name)) || (missReading && dependent.includes(c));
  const all = [...independent, ...dependent];
  return {
    passing: all.filter((c) => !isMiss(c)),
    misses: all.filter(isMiss),
    // A pattern that names no check is a stale or mistyped entry.
    stale: patterns.filter((p) => !all.some((c) => matches(p, c.name))),
  };
}

describe("fixture corpus", () => {
  it("has fixtures to run", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it("lists known misses only for checks that exist", () => {
    for (const id of Object.keys(KNOWN_MISSES)) {
      expect(ids, "KNOWN_MISSES names a missing fixture").toContain(id);
      expect(plan(id).stale, `KNOWN_MISSES["${id}"] names checks that do not exist`).toEqual([]);
    }
  });

  it.each(ids)("%s", (id) => {
    for (const check of plan(id).passing) check.run();
  });

  for (const id of ids) {
    if (!KNOWN_MISSES[id]) continue;
    let misses: Check[];
    try {
      misses = plan(id).misses;
    } catch {
      continue; // a fixture that does not load fails its own test above
    }
    for (const check of misses) it.fails(`${id} — known miss: ${check.name}`, check.run);
  }
});
