-- Per-user scraper endpoints.
--
-- The database is shared; the scraper is not. Each user runs their own (a local
-- box behind a tunnel, a Render container, whatever) and registers it here, in
-- priority order: position 0 is the primary, 1..n are the fallbacks tried when
-- it is unreachable — the same shape as the single owner's ngrok + Render pair
-- that used to live in SCRAPER_SERVICE_URL / SCRAPER_SERVICE_URL_FALLBACK.
--
-- Ordering is a plain `position` column with the pair as the primary key, and
-- the whole list is rewritten on every save (delete + re-insert in one
-- transaction). That is deliberately dumber than patching individual rows:
-- reordering through a unique key otherwise needs a temporary shuffle to dodge
-- conflicts, and the list is at most a handful of rows typed into one form.
--
-- secret_enc holds the scraper's bearer token, AES-256-GCM encrypted by
-- lib/secret-box.ts — never plaintext. Several people's service credentials now
-- sit in one table, so a database dump must not hand them over. NULL means the
-- endpoint is called without an Authorization header (a local scraper started
-- with DISABLE_NGROK=1 and no secret).

CREATE TABLE "scraper_endpoints" (
  "user_id"    VARCHAR(64)  NOT NULL,
  -- 0 = primary. Contiguous from 0, enforced by the rewrite-whole-list write.
  "position"   INTEGER      NOT NULL,
  "label"      VARCHAR(64),
  "url"        VARCHAR(255) NOT NULL,
  "secret_enc" TEXT,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT "scraper_endpoints_pkey" PRIMARY KEY ("user_id", "position"),
  CONSTRAINT "scraper_endpoints_position_check" CHECK ("position" >= 0 AND "position" < 8)
);

-- No foreign key to titles for the same reason the scrape budget has none: a
-- user must be able to configure a scraper before they own a single title.
