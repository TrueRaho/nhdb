// Optional real-PostgreSQL integration checks. Never uses DATABASE_URL or .env.
// NHDB_TEST_DATABASE_URL must explicitly point to Neon's schema-only "tests"
// branch, database nhdb_test, or a disposable local nhdb_test/nhdb_test_*.
// Never production. Every test builds and drops only its own nhdb_test_* schema.
// Set PG_BIN_DIR if PostgreSQL's psql is not on PATH.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLegacySource, isSourceKey, legacyUrl, MAX_URL, siteKey, titleUrl } from "../lib/sources";
import { claimStatements, COLLECTION_TABLES } from "../scripts/lib/claim";
import type { Prisma } from "../lib/generated/prisma/client";
import type { ScrapeResult } from "../lib/scrape-payload";
import { titleUpsertSql } from "../lib/title-upsert";
import { AUDIT_TITLES_SQL, auditTitleIds, parseAuditTitles } from "../scripts/lib/audit-title-ids";

const databaseUrl = process.env.NHDB_TEST_DATABASE_URL;
const psql = process.env.PG_BIN_DIR ? join(process.env.PG_BIN_DIR, "psql") : "psql";
let schema = "";

function query(sql: string) {
  return execFileSync(psql, ["-X", "-q", "-A", "-t", "--set=ON_ERROR_STOP=1", "--dbname", databaseUrl!], {
    input: `SET search_path TO "${schema}";\n${sql}`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function assertDisposable(raw: string) {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const neon = /^[a-z0-9.-]+\.neon\.tech$/i.test(url.hostname) && url.pathname === "/nhdb_test";
  const authority = raw.match(/^postgres(?:ql)?:\/\/([^/?#]*)/i)?.[1] ?? "";
  const safeAuthority = authority && (authority.match(/@/g)?.length ?? 0) <= 1 &&
    !/[\s\\]/.test(authority) && !/%(?:2f|5c|40|3f|23)/i.test(authority);
  const safeQuery = [...url.searchParams.keys()].every((key) => ["sslmode", "channel_binding"].includes(key));
  if (!(neon || local && /^\/nhdb_test(?:_[a-z0-9_]+)?$/i.test(url.pathname)) ||
      !["postgres:", "postgresql:"].includes(url.protocol) || !safeAuthority || !safeQuery || url.hash) {
    throw new Error("NHDB_TEST_DATABASE_URL must point to local nhdb_test/nhdb_test_* or Neon tests/nhdb_test; only sslmode/channel_binding query options are allowed.");
  }
}

describe("DB integration target guard", () => {
  it.each(["postgresql://nhdb_test@127.0.0.1:55432/nhdb_test", "postgresql://localhost/nhdb_test_audit", "postgres://[::1]/nhdb_test",
    "postgresql://u:p@ep-x.c-2.eu-west-2.aws.neon.tech/nhdb_test?sslmode=require&channel_binding=require",
    "postgresql://localhost/nhdb_test?sslmode=disable",
  ])("accepts an approved disposable target: %s", (raw) => {
    expect(() => assertDisposable(raw)).not.toThrow();
  });
  it.each([
    "postgresql://cloud.example/nhdb_test",
    "postgresql://127.0.0.1/nhdb_test?host=cloud.example",
    "postgresql://127.0.0.1/production",
    "postgresql://ep-x.neon.tech/neondb",
    "postgresql://ep-x.neon.tech/nhdb_test_other",
    "postgresql://ep-x.neon.tech.evil.example/nhdb_test",
    "postgresql://evil.example@ep-x.neon.tech@127.0.0.1/nhdb_test",
    "postgresql://u%40evil:p@ep-x.neon.tech/nhdb_test",
    "postgresql://ep-x.neon.tech/nhdb_test#fragment",
    ...["host=evil", "hostaddr=1.2.3.4", "dbname=neondb", "options=x", "service=x", "port=5432", "user=other", "password=x"].map((query) => `postgresql://ep-x.neon.tech/nhdb_test?${query}`),
  ])("refuses a cloud or non-disposable test target before psql: %s", (raw) => {
    expect(() => assertDisposable(raw)).toThrow();
  });
});

// A statement the app binds, with its values written in as SQL literals for
// psql. Test parameters only — never an arbitrary value.
function withLiterals(q: Prisma.Sql): string {
  return q.text.replace(/\$(\d+)/g, (_, index: string) => {
    const v = q.values[Number(index) - 1];
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
    throw new Error(`no literal for ${typeof v}`);
  });
}

function claimSql(owner: string) {
  // The production driver binds these values. psql's input needs SQL literals;
  // escape only the test parameters, never identifiers or an arbitrary URL.
  return "BEGIN;\n" + claimStatements(owner).map(({ text, values }) =>
    text.replace(/\$(\d+)/g, (_, index: string) => `'${values[Number(index) - 1].replaceAll("'", "''")}'`) + ";",
  ).join("\n") + "\nCOMMIT;";
}

// Every migration directory, in the lexicographic order prisma replays them.
const migrationNames = () => readdirSync("prisma/migrations").filter((name) => /^\d+[a-z]?_/.test(name)).sort();

// The single-user rows migration 6 has to adopt.
const SINGLE_USER_ROWS = `INSERT INTO titles (hashtag, title_name, image_link, pages, uploaded_at)
  VALUES (101, 'legacy one', '/one', 10, '2026-01-01'), (102, 'legacy two', '/two', 20, '2026-01-02');
  INSERT INTO tags (tag_name, tag_link) VALUES ('shared', '/tag/shared');
  INSERT INTO titlestotags (hashtag, id_tag) SELECT t.hashtag, e.id_tag FROM titles t CROSS JOIN tags e;
  INSERT INTO artists (artist_name, artist_link) VALUES ('artist', '/artist');
  INSERT INTO titlestoartists SELECT 101, id_artist FROM artists;
  INSERT INTO groups (group_name, group_link) VALUES ('group', '/group');
  INSERT INTO titlestogroups SELECT 101, id_group FROM groups;
  INSERT INTO characters (character_name, character_link) VALUES ('character', '/character');
  INSERT INTO titlestocharacters SELECT 101, id_character FROM characters;
  INSERT INTO parodies (parodie_name, parodie_link) VALUES ('parody', '/parody');
  INSERT INTO titlestoparodies SELECT 101, id_parodie FROM parodies;
  INSERT INTO read_logs (hashtag) VALUES (101);`;

// Builds a fresh schema from every migration in deploy order. `seeds` maps a
// migration to SQL run just before it applies — rows written by the app
// version that migration has to adopt.
function migrate(seeds: Record<string, string>) {
  const migrations = migrationNames();
  for (const name of Object.keys(seeds)) {
    if (!migrations.includes(name)) throw new Error(`seed for a migration that does not exist: ${name}`);
  }
  schema = `nhdb_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
  query(`CREATE SCHEMA "${schema}";`);
  for (const name of migrations) {
    if (seeds[name]) query(seeds[name]);
    query(readFileSync(join("prisma/migrations", name, "migration.sql"), "utf8"));
  }
}

function addOtherUser() {
  query(`INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
    VALUES ('other', 101, 'nhentai', '101', 'other title', '/one', 1, '2026-01-01');
    INSERT INTO tags (user_id, tag_name, tag_link) VALUES ('other', 'shared', '/tag/shared');
    INSERT INTO titlestotags (user_id, hashtag, id_tag)
    SELECT 'other', 101, id_tag FROM tags WHERE user_id = 'other';`);
}

// Neon "tests" pays a TLS round trip per psql call and replays migrations per
// test: seconds rather than milliseconds. Local disposable databases work too.
const DB_TIMEOUT = 120_000;

describe.skipIf(!databaseUrl)("multi-user PostgreSQL migration", { timeout: DB_TIMEOUT }, () => {
  beforeEach(() => {
    assertDisposable(databaseUrl!);
    // Replay in deploy order, seeding the single-user rows 6 has to adopt just
    // before it, then carry on through every later migration.
    migrate({ "6_multi_user": SINGLE_USER_ROWS });
  }, DB_TIMEOUT);

  afterEach(() => {
    if (schema) query(`DROP SCHEMA "${schema}" CASCADE;`);
    schema = "";
  }, DB_TIMEOUT);

  it("audits only the verified collection using a read-only parameterised query", () => {
    query(`INSERT INTO titles (user_id, hashtag, source, source_id, url, title_name, image_link, pages, created_at)
      VALUES ('audit-owner', 1000000001, 'manga.example', '2019', 'https://manga.example/summer-story-2019/', 'old id', '', 1, '2026-10-05 01:00:00'),
             ('audit-owner', 1000000002, 'manga.example', 'summer-story-2019', 'https://manga.example/summer-story-2019/', 'existing', '', 1, '2026-10-04'),
             ('other-owner', 1000000001, 'manga.example', '2019', 'https://manga.example/summer-story-2019/', 'other', '', 1, '2026-10-05');`);
    expect(query(`SELECT pg_typeof(t.created_at)::text FROM (${AUDIT_TITLES_SQL.replace("$1", "'audit-owner'")}) t LIMIT 1`)).toBe("text");
    const rows = query(`BEGIN READ ONLY;
      PREPARE audit(text) AS SELECT COALESCE(json_agg(t), '[]'::json) FROM (${AUDIT_TITLES_SQL}) t;
      EXECUTE audit('audit-owner'); COMMIT;`);
    const report = auditTitleIds(parseAuditTitles(JSON.parse(rows)));
    expect(report).toMatchObject({ scanned: 2, in_window: 1, mismatches: [{ user_id: "audit-owner", hashtag: 1000000001, current_id: "summer-story-2019", collides_with: [1000000002] }] });
    expect(report.mismatches[0].created_at).toBe("2026-10-05T01:00:00.000Z");
    expect(query("SELECT source_id FROM titles WHERE user_id = 'audit-owner' AND hashtag = 1000000001")).toBe("2019");
    expect(() => query("BEGIN READ ONLY; UPDATE titles SET title_name = 'must not write'; COMMIT;")).toThrow(/read-only transaction/);
  });

  it("backfills every table without leaving a default owner", () => {
    for (const table of COLLECTION_TABLES) {
      expect(query(`SELECT bool_and(user_id = 'nhdb:unclaimed') FROM "${table}"`)).toBe("t");
    }
    // Scoped to the collection: later migrations add user_id to tables of
    // their own (scrape_budget, scraper_endpoints) that 6 never backfilled.
    expect(query(`SELECT count(*) FROM information_schema.columns
      WHERE table_schema = '${schema}' AND column_name = 'user_id'
        AND table_name IN (${COLLECTION_TABLES.map((t) => `'${t}'`).join(", ")})
        AND is_nullable = 'NO' AND column_default IS NULL`)).toBe(String(COLLECTION_TABLES.length));
    expect(query("SELECT avg_tag_value FROM titles WHERE hashtag = 101")).toBe("2");
    expect(query("SELECT title_count FROM tags")).toBe("2");
  });

  it("rejects cross-user entity links and read history", () => {
    addOtherUser();
    for (const [table, entity, id] of [
      ["titlestoartists", "artists", "id_artist"], ["titlestogroups", "groups", "id_group"],
      ["titlestocharacters", "characters", "id_character"], ["titlestoparodies", "parodies", "id_parodie"],
      ["titlestotags", "tags", "id_tag"],
    ]) {
      expect(() => query(`INSERT INTO "${table}" (user_id, hashtag, "${id}")
        SELECT 'other', 101, "${id}" FROM "${entity}" WHERE user_id = 'nhdb:unclaimed'`)).toThrow();
    }
    expect(() => query("INSERT INTO read_logs (user_id, hashtag) VALUES ('other', 102)")).toThrow();
  });

  it("isolates duplicate hashtags, tag counts, averages and cascading cleanup", () => {
    addOtherUser();
    expect(query("SELECT avg_tag_value FROM titles WHERE user_id = 'other' AND hashtag = 101")).toBe("1");
    expect(query("SELECT avg_tag_value FROM titles WHERE user_id = 'nhdb:unclaimed' AND hashtag = 101")).toBe("2");
    query(`INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
      VALUES ('other', 103, 'nhentai', '103', 'three', '/three', 1, '2026-01-01'),
             ('other', 104, 'nhentai', '104', 'four', '/four', 1, '2026-01-01');
      INSERT INTO titlestotags (user_id, hashtag, id_tag)
      SELECT t.user_id, t.hashtag, e.id_tag FROM titles t JOIN tags e ON e.user_id = t.user_id
      WHERE t.user_id = 'other' AND t.hashtag <> 101;`);
    expect(query("SELECT avg_tag_value FROM titles WHERE user_id = 'other' AND hashtag = 101")).toBe("3");
    expect(query("SELECT avg_tag_value FROM titles WHERE user_id = 'nhdb:unclaimed' AND hashtag = 101")).toBe("2");
    query("DELETE FROM titles WHERE user_id = 'other' AND hashtag <> 101");
    expect(query("SELECT title_count FROM tags WHERE user_id = 'other'")).toBe("1");
    expect(query("SELECT avg_tag_value FROM titles WHERE user_id = 'other' AND hashtag = 101")).toBe("1");
    query("DELETE FROM titles WHERE user_id = 'other'");
    expect(query("SELECT count(*) FROM tags WHERE user_id = 'other'")).toBe("0");
    expect(query("SELECT title_count FROM tags WHERE user_id = 'nhdb:unclaimed'")).toBe("2");
  });

  it("keeps reused entities through a delete/reinsert transaction", () => {
    query(`BEGIN;
      DELETE FROM titlestoartists WHERE user_id = 'nhdb:unclaimed' AND hashtag = 101;
      INSERT INTO titlestoartists (user_id, hashtag, id_artist) SELECT user_id, 101, id_artist FROM artists;
      COMMIT;`);
    expect(query("SELECT count(*) FROM artists")).toBe("1");
  });

  it("claims every legacy table atomically and allows a harmless repeat", () => {
    query(claimSql("new-owner"));
    for (const table of COLLECTION_TABLES) {
      expect(query(`SELECT bool_and(user_id = 'new-owner') FROM "${table}"`)).toBe("t");
    }
    expect(query("SELECT avg_tag_value FROM titles WHERE hashtag = 101")).toBe("2");
    expect(query("SELECT title_count FROM tags")).toBe("2");
    expect(() => query(claimSql("new-owner"))).not.toThrow();
  });

  it("refuses a populated target without changing either collection", () => {
    addOtherUser();
    expect(() => query(claimSql("other"))).toThrow("already has a collection");
    expect(query("SELECT count(*) FROM titles WHERE user_id = 'nhdb:unclaimed'")).toBe("2");
    expect(query("SELECT count(*) FROM titles WHERE user_id = 'other'")).toBe("1");
  });

  describe("9_title_sources", () => {
    const insert = (values: string) =>
      query(`INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
        VALUES ${values}`);

    it("files every existing title as the nhentai gallery it always was", () => {
      expect(query("SELECT string_agg(source || ':' || source_id, ',' ORDER BY hashtag) FROM titles"))
        .toBe("nhentai:101,nhentai:102");
    });

    it("keeps the two hashtag ranges apart", () => {
      // An nhentai row's hashtag is its id, below 1e9…
      expect(() => insert("('u', 5, 'nhentai', '6', 't', '', 1, NULL)")).toThrow();
      expect(() => insert("('u', 1000000000, 'nhentai', '1000000000', 't', '', 1, NULL)")).toThrow();
      // …and nothing else may sit in that range.
      expect(() => insert("('u', 5, 'hitomi', '5', 't', '', 1, NULL)")).toThrow();
      expect(() => insert("('u', 1000000000, 'Hitomi!', '5', 't', '', 1, NULL)")).toThrow();
      expect(() => insert("('u', 1000000000, 'hitomi', '', 't', '', 1, NULL)")).toThrow();
      insert("('u', 5, 'nhentai', '5', 't', '', 1, NULL)");
      insert("('u', 1000000000, 'hitomi', '5', 't', '', 1, NULL)");
    });

    it("refuses a second row for the same title of the same user, not of another user", () => {
      insert("('u', 1000000001, 'hitomi', '5', 't', '', 1, NULL)");
      expect(() => insert("('u', 1000000002, 'hitomi', '5', 't', '', 1, NULL)")).toThrow();
      insert("('v', 1000000003, 'hitomi', '5', 't', '', 1, NULL)");
    });

    it("hands out foreign keys from 1e9 and stores an unknown upload date", () => {
      expect(query("SELECT nextval('titles_foreign_hashtag_seq')")).toBe("1000000000");
      insert("('u', nextval('titles_foreign_hashtag_seq'), 'hentai2read', 'a_b', 't', '', 0, NULL)");
      expect(query("SELECT hashtag, uploaded_at IS NULL FROM titles WHERE source_id = 'a_b'")).toBe("1000000001|t");
    });

    it("upserts by (user, source, source_id) and burns no key on a re-scrape", () => {
      // The statement upsertScrapedTitle runs, with literals for its parameters.
      const upsert = (title: string) => query(`
        INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
        VALUES ('u', COALESCE(
            (SELECT hashtag FROM titles WHERE user_id = 'u' AND source = 'hitomi' AND source_id = '77'),
            nextval('titles_foreign_hashtag_seq')),
          'hitomi', '77', '${title}', '', 3, NULL::date)
        ON CONFLICT (user_id, source, source_id) DO UPDATE SET
          title_name = EXCLUDED.title_name, image_link = EXCLUDED.image_link,
          pages = EXCLUDED.pages, uploaded_at = EXCLUDED.uploaded_at
        RETURNING hashtag`);
      const first = upsert("one");
      expect(upsert("two")).toBe(first);
      expect(query("SELECT title_name FROM titles WHERE source_id = '77'")).toBe("two");
      expect(query("SELECT last_value FROM titles_foreign_hashtag_seq")).toBe(first);
    });
  });

  describe("9a_any_site_titles", () => {
    const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);
    const insert = (values: string) =>
      query(`INSERT INTO titles (user_id, hashtag, source, source_id, url, title_name, image_link, pages, uploaded_at)
        VALUES ${values}`);
    const row = (hashtag: string | number, source: string, id: string, url: string | null, image = "") =>
      `('u', ${hashtag}, ${lit(source)}, ${lit(id)}, ${lit(url)}, 't', ${lit(image)}, 1, NULL)`;

    // The statement upsertScrapedTitle runs (lib/title-upsert.ts), for user 'u'.
    const save = (title: Partial<ScrapeResult> & Pick<ScrapeResult, "source" | "source_id" | "url">) =>
      query(withLiterals(titleUpsertSql("u", {
        title_name: "t", image_link: "", pages: 3, uploaded_at: null,
        tags: [], artists: [], groups: [], characters: [], parodies: [], ...title,
      })));
    const upsertNow = (source: string, id: string, url: string, title = "t") =>
      save({ source, source_id: id, url, title_name: title });

    // The same statement as the previous (migration 9) app version ran it: it
    // knows nothing of `url`, and may still be serving while 9a is applied.
    const upsertBefore9a = (source: string, id: string, title = "t") => query(`
      INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
      VALUES ('u', COALESCE(
          (SELECT hashtag FROM titles WHERE user_id = 'u' AND source = ${lit(source)} AND source_id = ${lit(id)}),
          nextval('titles_foreign_hashtag_seq')),
        ${lit(source)}, ${lit(id)}, ${lit(title)}, '', 3, NULL::date)
      ON CONFLICT (user_id, source, source_id) DO UPDATE SET
        title_name = EXCLUDED.title_name, image_link = EXCLUDED.image_link,
        pages = EXCLUDED.pages, uploaded_at = EXCLUDED.uploaded_at
      RETURNING hashtag`);

    it("replays right after 9_title_sources", () => {
      // '_' sorts before 'a', so the lexicographic replay keeps the order.
      const names = migrationNames();
      expect(names.indexOf("9a_any_site_titles")).toBe(names.indexOf("9_title_sources") + 1);
    });

    it("gives every legacy title the page address lib/sources.ts rebuilds for it", () => {
      // Rebuild with one row per legacy key, written the migration-9 way
      // (no url column yet), in place when 9a runs.
      query(`DROP SCHEMA "${schema}" CASCADE;`);
      migrate({
        "6_multi_user": SINGLE_USER_ROWS,
        "9a_any_site_titles": `INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
          VALUES ('u', 177013, 'nhentai', '177013', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'ehentai', '899557/edd545586a', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'hitomi', '1234567', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'hentaifox', '42', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'imhentai', '1000', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'pururin', '12345', 't', '', 1, NULL),
            ('u', nextval('titles_foreign_hashtag_seq'), 'hentai2read', 'morning_ledger_sctoaea', 't', '', 1, NULL);`,
      });
      const rows = query("SELECT source, source_id, url FROM titles ORDER BY user_id, hashtag")
        .split("\n").map((line) => line.split("|"));
      expect(Object.fromEntries(rows.map(([source, id, url]) => [`${source}:${id}`, url]))).toEqual({
        "nhentai:101": "https://nhentai.net/g/101/",
        "nhentai:102": "https://nhentai.net/g/102/",
        "nhentai:177013": "https://nhentai.net/g/177013/",
        "ehentai:899557/edd545586a": "https://e-hentai.org/g/899557/edd545586a/",
        "hitomi:1234567": "https://hitomi.la/galleries/1234567.html",
        "hentaifox:42": "https://hentaifox.com/gallery/42/",
        "imhentai:1000": "https://imhentai.xxx/gallery/1000/",
        "pururin:12345": "https://pururin.me/gallery/12345/x",
        "hentai2read:morning_ledger_sctoaea": "https://hentai2read.com/morning_ledger_sctoaea/",
      });
      // The SQL CASE and the app's LEGACY table must name the same pages, or
      // a re-scrape of a backfilled row would move it to another address.
      for (const [source, id, url] of rows) {
        expect(isLegacySource(source)).toBe(true);
        expect(url).toBe(legacyUrl(source, id));
      }
      expect(new Set(rows.map(([source]) => source)).size).toBe(7);
    });

    it("files a title from any site under its host name, with a surrogate key and its page", () => {
      // Not a legacy site: siteKey keeps the host name as the source.
      expect(siteKey("hentaiera.com")).toBe("hentaiera.com");
      const first = upsertNow("hentaiera.com", "1234567", "https://hentaiera.com/gallery/1234567/", "one");
      expect(Number(first)).toBeGreaterThanOrEqual(1_000_000_000);
      // A re-scrape keeps the key, burns none, and stores the page it read now.
      expect(upsertNow("hentaiera.com", "1234567", "https://hentaiera.com/g/1234567/", "two")).toBe(first);
      expect(query("SELECT url, title_name FROM titles WHERE source = 'hentaiera.com'"))
        .toBe("https://hentaiera.com/g/1234567/|two");
      expect(query("SELECT last_value FROM titles_foreign_hashtag_seq")).toBe(first);
      // The same id on another site is another title; ids need not be numbers.
      expect(upsertNow("hentairox.com", "1234567", "https://hentairox.com/gallery/1234567/")).not.toBe(first);
      upsertNow("exhentai.org", "899557/edd545586a", "https://exhentai.org/g/899557/edd545586a/");
      upsertNow("doujins.com", "some-series/some-title-84234", "http://doujins.com/some-series/some-title-84234");
      expect(query("SELECT count(*) FROM titles WHERE user_id = 'u'")).toBe("4");
    });

    it("is as wide as the write boundary lets a title be", () => {
      // The longest host name isSourceKey admits, the longest id and the
      // longest page and cover addresses parseScrapePayload admits.
      const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
      const fill = (prefix: string, length: number) => prefix + "x".repeat(length - prefix.length);
      const id = "9".repeat(255);
      const url = fill(`https://${host}/g/`, MAX_URL);
      const cover = fill("https://cdn.example-cdn.net/signed/", MAX_URL);
      expect(host).toHaveLength(253);
      expect(isSourceKey(host)).toBe(true);
      insert(row(1_000_000_000, host, id, url, cover));
      expect(query("SELECT length(source), length(source_id), length(url), length(image_link) FROM titles WHERE user_id = 'u'"))
        .toBe(`253|255|${MAX_URL}|${MAX_URL}`);
      expect(() => insert(row(1_000_000_001, `${host}e`, "1", null))).toThrow();
      expect(() => insert(row(1_000_000_001, "hentaiera.com", `${id}9`, null))).toThrow();
      expect(() => insert(row(1_000_000_001, "hentaiera.com", "1", `${url}x`))).toThrow();
      expect(() => insert(row(1_000_000_001, "hentaiera.com", "1", null, `${cover}x`))).toThrow();
    });

    it("refuses a source that is neither a host name nor a legacy key", () => {
      for (const source of ["Bad Host", "Hitomi!", "HentaiFox.com", "-hentaifox.com", "hentaifox.com-", ".hentaifox.com", ""]) {
        // Both the write boundary and the backstop say no.
        expect(isSourceKey(source)).toBe(false);
        expect(() => insert(row(1_000_000_000, source, "42", null))).toThrow("titles_source_format_check");
      }
      for (const id of ["", "12 34", "899557/ edd545586a"]) {
        expect(() => insert(row(1_000_000_000, "hentaifox.com", id, null))).toThrow("titles_source_format_check");
      }
      insert(row(1_000_000_000, "hentaifox.com", "42", null));
    });

    it("refuses a page address that is not a web address", () => {
      for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>",
        "//hentaifox.com/gallery/42/", "ftp://hentaifox.com/gallery/42/", "/gallery/42/", ""]) {
        expect(() => insert(row(1_000_000_000, "hentaifox.com", "42", url))).toThrow("titles_url_check");
      }
      insert(row(1_000_000_000, "hentaifox.com", "42", "https://hentaifox.com/gallery/42/"));
      insert(row(1_000_000_001, "doujins.com", "84234", "http://doujins.com/series/title-84234"));
      expect(query("SELECT count(*) FROM titles WHERE user_id = 'u'")).toBe("2");
    });

    it("still files an nhentai title under its gallery id, below 1e9", () => {
      expect(() => insert(row(5, "nhentai", "6", "https://nhentai.net/g/6/"))).toThrow("titles_source_hashtag_check");
      expect(() => insert(row(1_000_000_000, "nhentai", "1000000000", "https://nhentai.net/g/1000000000/")))
        .toThrow("titles_source_hashtag_check");
      // A host-name source stays out of nhentai's range — the host nhentai
      // lives at included, which the app files under the legacy key anyway.
      expect(() => insert(row(5, "hentaiera.com", "5", "https://hentaiera.com/gallery/5/")))
        .toThrow("titles_source_hashtag_check");
      expect(() => insert(row(5, "nhentai.net", "5", "https://nhentai.net/g/5/"))).toThrow("titles_source_hashtag_check");
      expect(siteKey("nhentai.net")).toBe("nhentai");
      insert(row(5, "nhentai", "5", "https://nhentai.net/g/5/"));
      expect(query("SELECT hashtag, url FROM titles WHERE user_id = 'u'")).toBe("5|https://nhentai.net/g/5/");
    });

    it("lets two entities share a link, while names stay unique per user", () => {
      for (const [table, idCol, nameCol, linkCol] of [
        ["artists", "id_artist", "artist_name", "artist_link"], ["groups", "id_group", "group_name", "group_link"],
        ["characters", "id_character", "character_name", "character_link"],
        ["parodies", "id_parodie", "parodie_name", "parodie_link"], ["tags", "id_tag", "tag_name", "tag_link"],
      ]) {
        // The statement batchUpsertEntities runs. Two spellings that slug to
        // one page, and two entities whose off-site links the write boundary
        // dropped to "", arrive in one title's save.
        const link = `https://nhentai.net/${table}/quill-ruva/`;
        const ids = query(`
          INSERT INTO "${table}" (user_id, "${nameCol}", "${linkCol}", total_works)
          VALUES ('u', 'quill ruva', '${link}', 0), ('u', 'quill-ruva', '${link}', 0), ('u', 'x', '', 0), ('u', 'y', '', 0)
          ON CONFLICT (user_id, "${nameCol}") DO UPDATE
            SET "${linkCol}" = EXCLUDED."${linkCol}",
                total_works = COALESCE(NULLIF(EXCLUDED.total_works, 0), "${table}".total_works)
          RETURNING "${idCol}"`).split("\n");
        expect(new Set(ids).size).toBe(4);
        expect(query(`SELECT count(*) FROM "${table}" WHERE user_id = 'u' AND "${linkCol}" = '${link}'`)).toBe("2");
        expect(() => query(`INSERT INTO "${table}" (user_id, "${nameCol}", "${linkCol}") VALUES ('u', 'quill ruva', '')`))
          .toThrow(`${table}_user_id_${nameCol}_key`);
      }
      expect(query(`SELECT count(*) FROM pg_indexes WHERE schemaname = '${schema}' AND indexname LIKE '%link_key'`))
        .toBe("0");
    });

    it("keeps what a re-scrape's page no longer shows: pages, upload date, cover", () => {
      // The reader stores 0 pages, no date and no cover when a page does not
      // show them, and the page read now may show less than the one read
      // before: Hitomi's page has no count — the old adapter read it from the
      // gallery's script — and nhentai's mirrors print no date.
      const cover = "https://tn.example-cdn.net/77.webp";
      const hitomi = { source: "hitomi", source_id: "77", url: "https://hitomi.la/galleries/77.html" };
      const key = save({ ...hitomi, title_name: "one", image_link: cover, pages: 24, uploaded_at: "2020-01-02" });
      expect(save({ ...hitomi, title_name: "two", image_link: "", pages: 0, uploaded_at: null })).toBe(key);
      const stored = () => query("SELECT title_name, pages, uploaded_at, image_link FROM titles WHERE source = 'hitomi'");
      expect(stored()).toBe(`two|24|2020-01-02|${cover}`);
      // What the page does show replaces what was stored.
      save({ ...hitomi, title_name: "three", image_link: `${cover}?v=2`, pages: 30, uploaded_at: "2021-03-04" });
      expect(stored()).toBe(`three|30|2021-03-04|${cover}?v=2`);
      // The same for an nhentai title, whose key is its gallery id.
      const nh = { source: "nhentai", source_id: "177013", url: "https://nhentai.net/g/177013/" };
      expect(save({ ...nh, pages: 225, uploaded_at: "2016-06-23", image_link: cover })).toBe("177013");
      expect(save({ ...nh, pages: 0, uploaded_at: null, image_link: "" })).toBe("177013");
      expect(query("SELECT pages, uploaded_at, image_link FROM titles WHERE source = 'nhentai' AND hashtag = 177013"))
        .toBe(`225|2016-06-23|${cover}`);
      // A first save stores what it has: nothing is invented for a new title.
      save({ source: "hentaifox", source_id: "42", url: "https://hentaifox.com/gallery/42/", pages: 0 });
      expect(query("SELECT pages, coalesce(uploaded_at::text, 'NULL'), image_link FROM titles WHERE source = 'hentaifox'"))
        .toBe("0|NULL|");
    });

    it("still takes the previous version's writes, which leave url unset", () => {
      // Expand-only: the migration-9 app may still be serving after 9a applies.
      query(`INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
        VALUES ('u', 7, 'nhentai', '7', 't', '', 1, NULL)`);
      const key = upsertBefore9a("hitomi", "77", "one");
      expect(query("SELECT string_agg(source || ':' || coalesce(url, 'NULL'), ',' ORDER BY hashtag) FROM titles WHERE user_id = 'u'"))
        .toBe("nhentai:NULL,hitomi:NULL");
      // Such a row is still read at its legacy page.
      expect(titleUrl("nhentai", "7", null)).toBe("https://nhentai.net/g/7/");
      expect(titleUrl("hitomi", "77", null)).toBe("https://hitomi.la/galleries/77.html");
      // The new version fills it in on its next save, and the old version's
      // re-scrape — which does not name the column — leaves it alone.
      expect(upsertNow("hitomi", "77", "https://hitomi.la/galleries/77.html", "two")).toBe(key);
      expect(upsertBefore9a("hitomi", "77", "three")).toBe(key);
      expect(query("SELECT url, title_name FROM titles WHERE source = 'hitomi'"))
        .toBe("https://hitomi.la/galleries/77.html|three");
    });
  });
});
