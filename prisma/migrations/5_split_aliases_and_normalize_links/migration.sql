-- Three global data fixes. The first two are also enforced by the scraper from
-- now on (lib/scraper.ts), so a re-scrape cannot reintroduce either shape.

-- 1. Entity links -> one absolute form ---------------------------------------
-- The scraper stored the href exactly as the markup carried it, which is
-- relative ("/artist/x/"), while older imported rows carry the full URL. A
-- stored link you cannot open without separately knowing the base is only half
-- a link, so absolute wins. titles.image_link is already absolute everywhere
-- and is left alone.
UPDATE "artists"    SET "artist_link"    = 'https://nhentai.net' || "artist_link"    WHERE "artist_link"    LIKE '/%';
UPDATE "groups"     SET "group_link"     = 'https://nhentai.net' || "group_link"     WHERE "group_link"     LIKE '/%';
UPDATE "characters" SET "character_link" = 'https://nhentai.net' || "character_link" WHERE "character_link" LIKE '/%';
UPDATE "parodies"   SET "parodie_link"   = 'https://nhentai.net' || "parodie_link"   WHERE "parodie_link"   LIKE '/%';
UPDATE "tags"       SET "tag_link"       = 'https://nhentai.net' || "tag_link"       WHERE "tag_link"       LIKE '/%';

-- 2. "a | b" names -> one row per name ---------------------------------------
-- nhentai keeps every alias of one entity on a single tag page with " | "
-- between the names, and this splits all five categories the same way so the
-- tables stay uniform. Note what that means per category: for artists and
-- groups the halves are genuinely separate credits, while for parodies the
-- separator carries one work's Japanese and English titles, so
-- "pokemon | pocket monsters" becomes two parody rows for one franchise. That
-- is a deliberate trade of nhentai's semantics for a uniform schema.
--
-- Each block: create the missing halves, point every title at each half, then
-- drop the combined row (its join rows go with it through the FK cascade).
-- A half's link is derived from its name — the combined page's href says
-- nothing about either half — using nhentai's slug rule: lowercase, and every
-- run of non-alphanumerics collapses to a single dash. total_works is carried
-- over rather than zeroed: it is write-only data, and a zero would clobber a
-- real count on the next re-scrape's upsert.

-- artists
INSERT INTO "artists" ("artist_name", "artist_link", total_works)
SELECT DISTINCT btrim(part),
  'https://nhentai.net/artist/' || btrim(regexp_replace(lower(btrim(part)), '[^a-z0-9]+', '-', 'g'), '-') || '/',
  e.total_works
FROM "artists" e, unnest(string_to_array(e."artist_name", '|')) AS part
WHERE e."artist_name" LIKE '%|%' AND btrim(part) <> ''
ON CONFLICT ("artist_name") DO NOTHING;

INSERT INTO "titlestoartists" (hashtag, "id_artist")
SELECT DISTINCT j.hashtag, target."id_artist"
FROM "titlestoartists" j
JOIN "artists" combined ON combined."id_artist" = j."id_artist" AND combined."artist_name" LIKE '%|%'
CROSS JOIN unnest(string_to_array(combined."artist_name", '|')) AS part
JOIN "artists" target ON target."artist_name" = btrim(part)
ON CONFLICT DO NOTHING;

DELETE FROM "artists" WHERE "artist_name" LIKE '%|%';

-- groups
INSERT INTO "groups" ("group_name", "group_link", total_works)
SELECT DISTINCT btrim(part),
  'https://nhentai.net/group/' || btrim(regexp_replace(lower(btrim(part)), '[^a-z0-9]+', '-', 'g'), '-') || '/',
  e.total_works
FROM "groups" e, unnest(string_to_array(e."group_name", '|')) AS part
WHERE e."group_name" LIKE '%|%' AND btrim(part) <> ''
ON CONFLICT ("group_name") DO NOTHING;

INSERT INTO "titlestogroups" (hashtag, "id_group")
SELECT DISTINCT j.hashtag, target."id_group"
FROM "titlestogroups" j
JOIN "groups" combined ON combined."id_group" = j."id_group" AND combined."group_name" LIKE '%|%'
CROSS JOIN unnest(string_to_array(combined."group_name", '|')) AS part
JOIN "groups" target ON target."group_name" = btrim(part)
ON CONFLICT DO NOTHING;

DELETE FROM "groups" WHERE "group_name" LIKE '%|%';

-- characters
INSERT INTO "characters" ("character_name", "character_link", total_works)
SELECT DISTINCT btrim(part),
  'https://nhentai.net/character/' || btrim(regexp_replace(lower(btrim(part)), '[^a-z0-9]+', '-', 'g'), '-') || '/',
  e.total_works
FROM "characters" e, unnest(string_to_array(e."character_name", '|')) AS part
WHERE e."character_name" LIKE '%|%' AND btrim(part) <> ''
ON CONFLICT ("character_name") DO NOTHING;

INSERT INTO "titlestocharacters" (hashtag, "id_character")
SELECT DISTINCT j.hashtag, target."id_character"
FROM "titlestocharacters" j
JOIN "characters" combined ON combined."id_character" = j."id_character" AND combined."character_name" LIKE '%|%'
CROSS JOIN unnest(string_to_array(combined."character_name", '|')) AS part
JOIN "characters" target ON target."character_name" = btrim(part)
ON CONFLICT DO NOTHING;

DELETE FROM "characters" WHERE "character_name" LIKE '%|%';

-- parodies
INSERT INTO "parodies" ("parodie_name", "parodie_link", total_works)
SELECT DISTINCT btrim(part),
  'https://nhentai.net/parody/' || btrim(regexp_replace(lower(btrim(part)), '[^a-z0-9]+', '-', 'g'), '-') || '/',
  e.total_works
FROM "parodies" e, unnest(string_to_array(e."parodie_name", '|')) AS part
WHERE e."parodie_name" LIKE '%|%' AND btrim(part) <> ''
ON CONFLICT ("parodie_name") DO NOTHING;

INSERT INTO "titlestoparodies" (hashtag, "id_parodie")
SELECT DISTINCT j.hashtag, target."id_parodie"
FROM "titlestoparodies" j
JOIN "parodies" combined ON combined."id_parodie" = j."id_parodie" AND combined."parodie_name" LIKE '%|%'
CROSS JOIN unnest(string_to_array(combined."parodie_name", '|')) AS part
JOIN "parodies" target ON target."parodie_name" = btrim(part)
ON CONFLICT DO NOTHING;

DELETE FROM "parodies" WHERE "parodie_name" LIKE '%|%';

-- tags. No rows carry a separator today; the block keeps the rule uniform for
-- whatever a future scrape brings. Writing titlestotags fires the statement
-- triggers from migration 3, so tags.title_count and titles.avg_tag_value are
-- recomputed for everything touched here.
INSERT INTO "tags" ("tag_name", "tag_link", total_works)
SELECT DISTINCT btrim(part),
  'https://nhentai.net/tag/' || btrim(regexp_replace(lower(btrim(part)), '[^a-z0-9]+', '-', 'g'), '-') || '/',
  e.total_works
FROM "tags" e, unnest(string_to_array(e."tag_name", '|')) AS part
WHERE e."tag_name" LIKE '%|%' AND btrim(part) <> ''
ON CONFLICT ("tag_name") DO NOTHING;

INSERT INTO "titlestotags" (hashtag, "id_tag")
SELECT DISTINCT j.hashtag, target."id_tag"
FROM "titlestotags" j
JOIN "tags" combined ON combined."id_tag" = j."id_tag" AND combined."tag_name" LIKE '%|%'
CROSS JOIN unnest(string_to_array(combined."tag_name", '|')) AS part
JOIN "tags" target ON target."tag_name" = btrim(part)
ON CONFLICT DO NOTHING;

DELETE FROM "tags" WHERE "tag_name" LIKE '%|%';

-- 3. One-time orphan sweep ----------------------------------------------------
-- Migration 4's cleanup triggers are AFTER DELETE ON the join tables, so they
-- only ever fire for an entity that HAD a link and lost it. Rows already
-- orphaned when those triggers were created were never reachable by them and
-- have sat there since — migration 4 installed the rule but never applied it to
-- the existing data. This is that missing backfill; from here the triggers keep
-- the invariant on their own.
DELETE FROM "artists"    e WHERE NOT EXISTS (SELECT 1 FROM "titlestoartists"    j WHERE j."id_artist"    = e."id_artist");
DELETE FROM "groups"     e WHERE NOT EXISTS (SELECT 1 FROM "titlestogroups"     j WHERE j."id_group"     = e."id_group");
DELETE FROM "characters" e WHERE NOT EXISTS (SELECT 1 FROM "titlestocharacters" j WHERE j."id_character" = e."id_character");
DELETE FROM "parodies"   e WHERE NOT EXISTS (SELECT 1 FROM "titlestoparodies"   j WHERE j."id_parodie"   = e."id_parodie");
DELETE FROM "tags"       e WHERE NOT EXISTS (SELECT 1 FROM "titlestotags"       j WHERE j."id_tag"       = e."id_tag");
