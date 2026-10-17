// Per-user scrape budget, counted in Postgres.
//
// See prisma/migrations/7_scrape_budget for why this is not an in-memory
// bucket. The short version: on Vercel, process memory is per lambda instance,
// so an in-memory limit multiplies by however many instances a caller can make
// the platform spin up.

import "server-only";
import { Prisma } from "./generated/prisma/client";
import { prisma } from "./db";
import { consumeUsageBudget, coverBytePrecheckSql } from "./usage-budget";
import { COVER_GLOBAL_BYTES, COVER_GLOBAL_REQUESTS, COVER_USER_BYTES, COVER_USER_REQUESTS, UsageLimitError } from "./usage-limits";

/** Admit a request before any upstream work; both request counters or neither. */
export async function consumeCoverRequestBudget(userId: string): Promise<BudgetVerdict> {
  try {
    await prisma.$transaction(async (tx) => {
      await consumeUsageBudget(tx, {
        kind: "cover-request-user", userId, amount: 1, limit: COVER_USER_REQUESTS, period: "day",
        message: "Daily cover request limit reached. Try again tomorrow.",
      });
      await consumeUsageBudget(tx, {
        kind: "cover-request-global", userId: "", amount: 1, limit: COVER_GLOBAL_REQUESTS, period: "month",
        message: "Deployment cover request limit reached. Try again next month.",
      });
    });
    return { allowed: true, used: 1, limit: COVER_USER_REQUESTS };
  } catch (error) {
    if (!(error instanceof UsageLimitError)) throw error;
    return { allowed: false, limit: COVER_USER_REQUESTS, retryAfterSeconds: error.retryAfterSeconds };
  }
}

/** Read-only fast rejection, never a replacement for the after-fetch charge. */
export async function checkCoverByteBudget(userId: string): Promise<BudgetVerdict> {
  const [row] = await prisma.$queryRaw<{ reset_in: number }[]>(coverBytePrecheckSql(userId));
  return row
    ? { allowed: false, limit: COVER_USER_BYTES, retryAfterSeconds: Math.max(1, row.reset_in) }
    : { allowed: true, used: 0, limit: COVER_USER_BYTES };
}

/** Charge delivered image bytes to BOTH counters or neither. */
export async function consumeCoverBudget(userId: string, bytes: number): Promise<BudgetVerdict> {
  try {
    await prisma.$transaction(async (tx) => {
      await consumeUsageBudget(tx, {
        kind: "cover-user", userId, amount: bytes, limit: COVER_USER_BYTES, period: "month",
        message: "Monthly cover budget reached. Try again next month.",
      });
      await consumeUsageBudget(tx, {
        kind: "cover-global", userId: "", amount: bytes, limit: COVER_GLOBAL_BYTES, period: "month",
        message: "Deployment cover budget reached. Try again next month.",
      });
    });
    return { allowed: true, used: bytes, limit: COVER_USER_BYTES };
  } catch (error) {
    // Throwing inside the transaction rolls back a successful first charge
    // when the other counter denies. Database failures must fail closed.
    if (!(error instanceof UsageLimitError)) throw error;
    return { allowed: false, limit: COVER_USER_BYTES, retryAfterSeconds: error.retryAfterSeconds };
  }
}

/**
 * Scrapes allowed per user per window.
 *
 * Sized against the workload it has to leave alone, not against the attack: the
 * batch path exists for pasting a phone's whole tab list, which can be dozens of
 * ids in one go (see lib/sources.ts `parseInputs`). 120/hour allows several such pastes
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
