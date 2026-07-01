-- Denormalized "tag value" stats, maintained entirely inside Postgres.
--
--   tags.title_count      — how many titles carry this tag (the tag's "value").
--   titles.avg_tag_value  — mean of a title's tags' title_count values.
--
-- The library sorts titles by avg_tag_value, so it must stay correct as titles
-- are added/removed. Rather than recompute on read, statement-level triggers on
-- titlestotags keep both columns current: adding one title shifts the value of
-- every tag it shares, which shifts the average of every title holding those
-- tags — the triggers recalculate exactly that affected set.

-- 1. Columns ----------------------------------------------------------------
ALTER TABLE "tags"   ADD COLUMN "title_count"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "titles" ADD COLUMN "avg_tag_value" DOUBLE PRECISION;

-- 2. Backfill from current data ---------------------------------------------
UPDATE "tags" t
SET "title_count" = COALESCE(c.n, 0)
FROM (SELECT id_tag, COUNT(*) AS n FROM "titlestotags" GROUP BY id_tag) c
WHERE c.id_tag = t.id_tag;

UPDATE "titles" ti
SET "avg_tag_value" = s.avg
FROM (
  SELECT tt.hashtag, AVG(t."title_count")::float8 AS avg
  FROM "titlestotags" tt JOIN "tags" t USING (id_tag)
  GROUP BY tt.hashtag
) s
WHERE ti.hashtag = s.hashtag;

-- 3. Index for the ORDER BY -------------------------------------------------
CREATE INDEX "titles_avg_tag_value_idx" ON "titles" ("avg_tag_value");

-- 4. Trigger functions ------------------------------------------------------
-- Both are statement-level and read the row set touched by the statement from a
-- transition table (new_rows / old_rows), so a batch createMany/deleteMany is
-- handled in one pass.

CREATE OR REPLACE FUNCTION nhdb_ttt_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Each inserted tag now covers one more title.
  UPDATE "tags" t
  SET "title_count" = (SELECT COUNT(*) FROM "titlestotags" tt WHERE tt.id_tag = t.id_tag)
  WHERE t.id_tag IN (SELECT DISTINCT id_tag FROM new_rows);

  -- Every title holding any of those tags has a new average (this includes the
  -- freshly inserted titles, which now hold the tags).
  UPDATE "titles" ti
  SET "avg_tag_value" = s.avg
  FROM (
    SELECT tt.hashtag, AVG(t."title_count")::float8 AS avg
    FROM "titlestotags" tt JOIN "tags" t USING (id_tag)
    WHERE tt.hashtag IN (
      SELECT DISTINCT hashtag FROM "titlestotags"
      WHERE id_tag IN (SELECT DISTINCT id_tag FROM new_rows)
    )
    GROUP BY tt.hashtag
  ) s
  WHERE ti.hashtag = s.hashtag;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nhdb_ttt_after_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Each removed tag now covers one fewer title (may reach 0).
  UPDATE "tags" t
  SET "title_count" = (SELECT COUNT(*) FROM "titlestotags" tt WHERE tt.id_tag = t.id_tag)
  WHERE t.id_tag IN (SELECT DISTINCT id_tag FROM old_rows);

  -- Recompute averages for titles that still hold those tags AND for the titles
  -- that just lost a tag (their own tag set shrank).
  UPDATE "titles" ti
  SET "avg_tag_value" = s.avg
  FROM (
    SELECT tt.hashtag, AVG(t."title_count")::float8 AS avg
    FROM "titlestotags" tt JOIN "tags" t USING (id_tag)
    WHERE tt.hashtag IN (
      SELECT DISTINCT hashtag FROM "titlestotags"
      WHERE id_tag IN (SELECT DISTINCT id_tag FROM old_rows)
      UNION
      SELECT DISTINCT hashtag FROM old_rows
    )
    GROUP BY tt.hashtag
  ) s
  WHERE ti.hashtag = s.hashtag;

  -- A title that lost its last tag has no average anymore.
  UPDATE "titles" ti
  SET "avg_tag_value" = NULL
  WHERE ti.hashtag IN (SELECT DISTINCT hashtag FROM old_rows)
    AND NOT EXISTS (SELECT 1 FROM "titlestotags" tt WHERE tt.hashtag = ti.hashtag);

  RETURN NULL;
END;
$$;

-- 5. Triggers ---------------------------------------------------------------
CREATE TRIGGER trg_ttt_after_insert
  AFTER INSERT ON "titlestotags"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nhdb_ttt_after_insert();

CREATE TRIGGER trg_ttt_after_delete
  AFTER DELETE ON "titlestotags"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nhdb_ttt_after_delete();
