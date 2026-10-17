-- Expand-only: leave scrape_budget (and its deployed primary key) untouched.
-- One reusable row per kind/owner; windows reset in place, never grow by month.
-- The deployment-wide cover counter uses kind='cover-global', user_id=''.
CREATE TABLE usage_budget (
  kind VARCHAR(32) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  window_at TIMESTAMPTZ NOT NULL,
  used BIGINT NOT NULL CHECK (used >= 0),
  PRIMARY KEY (kind, user_id)
);
