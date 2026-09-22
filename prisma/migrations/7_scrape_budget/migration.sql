-- Per-user scrape budget.
--
-- Sign-up is open, and every account shares ONE scraper: the ngrok box, or the
-- free Render container where a browser fallback costs a 15-30s Playwright page.
-- The client-side pool cap (MAX_CONCURRENT_SCRAPES = 4) is per tab, so it caps
-- politeness, not abuse.
--
-- This lives in Postgres rather than in process memory because the app runs on
-- Vercel: an in-memory bucket is per lambda instance, so N concurrent instances
-- would grant N times the limit to a caller who simply opens N connections.
-- One atomic upsert against the database already in the request path is exact
-- at any concurrency, and costs one round trip on a path that is about to spend
-- hundreds of milliseconds (impit) or tens of seconds (Playwright) anyway.
--
-- Deliberately timestamptz, unlike titles.created_at / read_logs.read_at, which
-- are naive `timestamp` holding UTC for historical reasons (see CLAUDE.md — the
-- two-hop AT TIME ZONE dance those columns force is exactly the trap not worth
-- inheriting in a new table). Nothing here is ever rendered as wall-clock.

CREATE TABLE "scrape_budget" (
  "user_id"   VARCHAR(64)  NOT NULL,
  -- Start of the window currently being counted, not the last request's time.
  "window_at" TIMESTAMPTZ  NOT NULL,
  "used"      INTEGER      NOT NULL,

  CONSTRAINT "scrape_budget_pkey" PRIMARY KEY ("user_id")
);

-- No foreign key to titles/neon_auth on purpose: the budget must be chargeable
-- for a user's very first scrape, before they own a single row, and it must not
-- become a second place that has to know when an account is deleted. A stale
-- row is one tuple that the next window overwrites.
