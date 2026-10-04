// Optional real-PostgreSQL integration checks. Never uses DATABASE_URL or .env.
// NHDB_TEST_DATABASE_URL must explicitly point to a disposable local database.
// Set PG_BIN_DIR if PostgreSQL's psql is not on PATH.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimStatements, COLLECTION_TABLES } from "../scripts/lib/claim";

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

function claimSql(owner: string) {
  // The production driver binds these values. psql's input needs SQL literals;
  // escape only the test parameters, never identifiers or an arbitrary URL.
  return "BEGIN;\n" + claimStatements(owner).map(({ text, values }) =>
    text.replace(/\$(\d+)/g, (_, index: string) => `'${values[Number(index) - 1].replaceAll("'", "''")}'`) + ";",
  ).join("\n") + "\nCOMMIT;";
}

function addOtherUser() {
  query(`INSERT INTO titles (user_id, hashtag, source, source_id, title_name, image_link, pages, uploaded_at)
    VALUES ('other', 101, 'nhentai', '101', 'other title', '/one', 1, '2026-01-01');
    INSERT INTO tags (user_id, tag_name, tag_link) VALUES ('other', 'shared', '/tag/shared');
    INSERT INTO titlestotags (user_id, hashtag, id_tag)
    SELECT 'other', 101, id_tag FROM tags WHERE user_id = 'other';`);
}

describe.skipIf(!databaseUrl)("multi-user PostgreSQL migration", () => {
  beforeEach(() => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("NHDB_TEST_DATABASE_URL must point to a disposable LOCAL PostgreSQL instance.");
    }
    schema = `nhdb_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
    query(`CREATE SCHEMA "${schema}";`);
    // Replay in deploy order, stopping at 6 to seed the single-user rows it
    // has to adopt, then carry on through every later migration.
    const migrations = readdirSync("prisma/migrations").filter((name) => /^\d+_/.test(name)).sort();
    const apply = (name: string) => query(readFileSync(join("prisma/migrations", name, "migration.sql"), "utf8"));
    migrations.filter((name) => name < "6_multi_user").forEach(apply);
    query(`INSERT INTO titles (hashtag, title_name, image_link, pages, uploaded_at)
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
      INSERT INTO read_logs (hashtag) VALUES (101);`);
    migrations.filter((name) => name >= "6_multi_user").forEach(apply);
  });

  afterEach(() => {
    if (schema) query(`DROP SCHEMA "${schema}" CASCADE;`);
    schema = "";
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
});
