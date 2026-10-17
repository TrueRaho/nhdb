// Connection-free SQL builders and transaction helpers. Every charge is one
// conditional upsert, just like consumeScrapeBudget; reads only explain denials.
import { Prisma } from "./generated/prisma/client";
import { COVER_GLOBAL_BYTES, COVER_USER_BYTES, UsageLimitError } from "./usage-limits";

type BudgetKind = "cover-user" | "cover-global" | "cover-request-user" | "cover-request-global" | "commit" | "read" | "export";
type Period = "month" | "hour" | "day";
type BudgetDb = Pick<Prisma.TransactionClient, "$queryRaw">;

export interface UsageBudget {
  kind: BudgetKind;
  userId: string;
  amount: number;
  limit: number;
  period: Period;
  message: string;
}

// Calendar windows, explicitly UTC regardless of the database session zone.
function windowStart(period: Period) {
  return Prisma.sql`(date_trunc(${period}, NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
}

export function usageBudgetSql(b: UsageBudget): Prisma.Sql {
  if (!Number.isSafeInteger(b.amount) || b.amount <= 0 || !Number.isSafeInteger(b.limit) || b.limit <= 0) {
    throw new Error("Invalid budget amount or limit");
  }
  const start = windowStart(b.period);
  return Prisma.sql`
    INSERT INTO usage_budget AS b (kind, user_id, window_at, used)
    SELECT ${b.kind}, ${b.userId}, ${start}, ${b.amount}::bigint
    WHERE ${b.amount}::bigint <= ${b.limit}::bigint
    ON CONFLICT (kind, user_id) DO UPDATE
      SET window_at = CASE WHEN b.window_at < ${start} THEN ${start} ELSE b.window_at END,
          used = CASE WHEN b.window_at < ${start} THEN EXCLUDED.used ELSE b.used + EXCLUDED.used END
      WHERE b.window_at < ${start} OR b.used <= ${b.limit}::bigint - EXCLUDED.used
    RETURNING used
  `;
}

export async function consumeUsageBudget(db: BudgetDb, b: UsageBudget): Promise<void> {
  const rows = await db.$queryRaw<{ used: bigint }[]>(usageBudgetSql(b));
  if (rows.length) return;
  // This read never decides whether to charge and never changes the window.
  const interval = Prisma.raw(`INTERVAL '1 ${b.period}'`);
  const [row] = await db.$queryRaw<{ reset_in: number }[]>(Prisma.sql`
    SELECT CEIL(EXTRACT(EPOCH FROM (${windowStart(b.period)} + ${interval} - NOW())))::int AS reset_in
  `);
  throw new UsageLimitError(b.message, Math.max(1, row?.reset_in ?? 3600));
}

// Advisory only: avoid fetching when either current byte counter is already
// exhausted. Concurrent fetches still need the authoritative after-fetch charge.
export function coverBytePrecheckSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT CEIL(EXTRACT(EPOCH FROM (${windowStart("month")} + INTERVAL '1 month' - NOW())))::int AS reset_in
    FROM usage_budget b
    JOIN (VALUES
      ('cover-user', ${userId}, ${COVER_USER_BYTES}::bigint),
      ('cover-global', '', ${COVER_GLOBAL_BYTES}::bigint)
    ) AS limits(kind, user_id, byte_limit) USING (kind, user_id)
    WHERE b.window_at >= ${windowStart("month")} AND b.used >= limits.byte_limit
    LIMIT 1
  `;
}

// Separate statement before quota/count queries: a query that waited on a
// concurrent writer must take a NEW READ COMMITTED snapshot after it wins.
export function userWriteLockSql(userId: string): Prisma.Sql {
  return Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('nhdb:writes:' || ${userId}, 0))`;
}
