// Per-user scrape budget, counted in Postgres.
//
// See prisma/migrations/7_scrape_budget for why this is not an in-memory
// bucket. The short version: on Vercel, process memory is per lambda instance,
// so an in-memory limit multiplies by however many instances a caller can make
// the platform spin up.

import "server-only";
import { Prisma } from "./generated/prisma/client";
import { prisma } from "./db";

/**
 * Scrapes allowed per user per window.
 *
 * Sized against the workload it has to leave alone, not against the attack: the
 * batch path exists for pasting a phone's whole tab list, which can be dozens of
 * ids in one go (see lib/utils.ts `parseInputs`). 120/hour allows several such pastes
 * back to back, while capping one account at 120 Playwright pages an hour on the
 * free Render box.
 */
export const SCRAPE_LIMIT = 120;
export const SCRAPE_WINDOW = "1 hour";

export type BudgetVerdict =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; limit: number; retryAfterSeconds: number };

/**
 * Charge one scrape to `userId`, atomically.
 *
 * The whole decision is one statement, because "read the counter, then write it"
 * is a lost-update race that two concurrent scrapes from the same account would
 * win routinely — the batch pool fires four at a time by design.
 *
 * The `WHERE` on the conflict path is what makes it exact: when the caller is
 * already at the limit and still inside the window, the UPDATE matches nothing,
 * `RETURNING` yields no row, and nothing is incremented. So `used` never climbs
 * past the limit and a caller being throttled cannot push their own reset out.
 */
export async function consumeScrapeBudget(userId: string): Promise<BudgetVerdict> {
  const window = Prisma.raw(`INTERVAL '${SCRAPE_WINDOW}'`);
  const rows = await prisma.$queryRaw<{ used: number; window_at: Date }[]>(Prisma.sql`
    INSERT INTO scrape_budget AS b (user_id, window_at, used)
    VALUES (${userId}, NOW(), 1)
    ON CONFLICT (user_id) DO UPDATE
      SET window_at = CASE WHEN b.window_at <= NOW() - ${window} THEN NOW() ELSE b.window_at END,
          used      = CASE WHEN b.window_at <= NOW() - ${window} THEN 1    ELSE b.used + 1 END
      WHERE b.used < ${SCRAPE_LIMIT} OR b.window_at <= NOW() - ${window}
    RETURNING used, window_at
  `);

  const row = rows[0];
  if (row) return { allowed: true, used: row.used, limit: SCRAPE_LIMIT };

  // Denied. Re-read only to tell the caller when to come back; if the row has
  // vanished underneath us (a window rolled over between the two statements),
  // say the window length rather than pretend to know.
  const [current] = await prisma.$queryRaw<{ reset_in: number }[]>(Prisma.sql`
    SELECT CEIL(EXTRACT(EPOCH FROM (window_at + ${window} - NOW())))::int AS reset_in
    FROM scrape_budget WHERE user_id = ${userId}
  `);
  return {
    allowed: false,
    limit: SCRAPE_LIMIT,
    retryAfterSeconds: Math.max(1, current?.reset_in ?? 3600),
  };
}
