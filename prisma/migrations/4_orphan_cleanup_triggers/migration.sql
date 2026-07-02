-- Orphan-entity cleanup, moved from app code (lib/titles.ts deleteTitle) into
-- the database so it is universal: any path that removes join rows — title
-- deletion (cascade) or a re-scrape — drops entities left with zero titles.
--
-- Why CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED (not plain AFTER
-- DELETE): re-scrape (upsertScrapedTitle) deletes a title's join rows and
-- RE-INSERTS them inside one transaction. An immediate trigger would delete a
-- kept entity the moment its old link is removed, and the re-insert would then
-- FK-violate. Deferred triggers fire at COMMIT, after the re-insert, so the
-- NOT EXISTS check sees the final link set: still-referenced entities survive,
-- genuinely dropped ones are cleaned up.
--
-- No interaction with the tags.title_count / titles.avg_tag_value statement
-- triggers (migration 3_avg_tag_value): those run immediately per statement,
-- and orphan cleanup only deletes entity rows that have no titlestotags rows
-- left at commit time.

-- artists ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION nhdb_cleanup_orphan_artist() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "artists" e
  WHERE e."id_artist" = OLD."id_artist"
    AND NOT EXISTS (SELECT 1 FROM "titlestoartists" t WHERE t."id_artist" = e."id_artist");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cleanup_orphan_artist
  AFTER DELETE ON "titlestoartists"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nhdb_cleanup_orphan_artist();

-- groups ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION nhdb_cleanup_orphan_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "groups" e
  WHERE e."id_group" = OLD."id_group"
    AND NOT EXISTS (SELECT 1 FROM "titlestogroups" t WHERE t."id_group" = e."id_group");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cleanup_orphan_group
  AFTER DELETE ON "titlestogroups"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nhdb_cleanup_orphan_group();

-- characters ------------------------------------------------------------

CREATE OR REPLACE FUNCTION nhdb_cleanup_orphan_character() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "characters" e
  WHERE e."id_character" = OLD."id_character"
    AND NOT EXISTS (SELECT 1 FROM "titlestocharacters" t WHERE t."id_character" = e."id_character");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cleanup_orphan_character
  AFTER DELETE ON "titlestocharacters"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nhdb_cleanup_orphan_character();

-- parodies --------------------------------------------------------------

CREATE OR REPLACE FUNCTION nhdb_cleanup_orphan_parody() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "parodies" e
  WHERE e."id_parodie" = OLD."id_parodie"
    AND NOT EXISTS (SELECT 1 FROM "titlestoparodies" t WHERE t."id_parodie" = e."id_parodie");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cleanup_orphan_parody
  AFTER DELETE ON "titlestoparodies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nhdb_cleanup_orphan_parody();

-- tags ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION nhdb_cleanup_orphan_tag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "tags" e
  WHERE e."id_tag" = OLD."id_tag"
    AND NOT EXISTS (SELECT 1 FROM "titlestotags" t WHERE t."id_tag" = e."id_tag");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_cleanup_orphan_tag
  AFTER DELETE ON "titlestotags"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nhdb_cleanup_orphan_tag();
