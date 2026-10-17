import { describe, expect, it, vi } from "vitest";
import { consumeUsageBudget, coverBytePrecheckSql, usageBudgetSql, userWriteLockSql, type UsageBudget } from "./usage-budget";
import { titleUpsertSql } from "./title-upsert";
import { TITLE_LIMIT, UsageLimitError } from "./usage-limits";
import { parseScrapePayload } from "./scrape-payload";

const budget: UsageBudget = {
  kind: "cover-user", userId: "alice", amount: 1024, limit: 4096, period: "month", message: "Cover limit",
};

describe("conditional usage budget SQL", () => {
  it("pre-checks only current user/global byte counters through a read-only query", () => {
    const sql = coverBytePrecheckSql("alice");
    expect(sql.values).toEqual(expect.arrayContaining(["alice", "month"]));
    expect(sql.sql).toContain("'cover-user'");
    expect(sql.sql).toContain("'cover-global'");
    expect(sql.sql).toContain("b.window_at >=");
    expect(sql.sql).toContain("b.used >= limits.byte_limit");
    expect(sql.sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
  it("binds input and guards both first insert and conflict without a read/charge race", () => {
    const sql = usageBudgetSql(budget);
    expect(sql.values.slice(0, 2)).toEqual(["cover-user", "alice"]);
    expect(sql.sql).toContain("WHERE ?::bigint <= ?::bigint");
    expect(sql.sql).toContain("ON CONFLICT (kind, user_id) DO UPDATE");
    expect(sql.sql).toContain("OR b.used <= ?::bigint - EXCLUDED.used");
    expect(sql.sql).toContain("b.used + EXCLUDED.used");
    expect(sql.sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql.sql).not.toContain("SELECT used");
    // Every reset branch uses the current calendar window, not the last retry.
    expect(sql.values.filter((v) => v === "month")).toHaveLength(5);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid charge %s", (amount) => {
    expect(() => usageBudgetSql({ ...budget, amount })).toThrow("Invalid budget");
  });

  it("allows a charge without any follow-up read", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ used: BigInt(1024) }]);
    await consumeUsageBudget({ $queryRaw }, budget);
    expect($queryRaw).toHaveBeenCalledOnce();
  });

  it("a denial makes no second write and returns an actionable retry interval", async () => {
    const $queryRaw = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 123 }]);
    await expect(consumeUsageBudget({ $queryRaw }, budget)).rejects.toEqual(new UsageLimitError("Cover limit", 123));
    expect($queryRaw).toHaveBeenCalledTimes(2);
    expect($queryRaw.mock.calls[1][0].sql).toMatch(/^\s*SELECT CEIL/);
    expect($queryRaw.mock.calls[1][0].sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it("never converts a database failure into permission", async () => {
    const $queryRaw = vi.fn().mockRejectedValue(new Error("database down"));
    await expect(consumeUsageBudget({ $queryRaw }, budget)).rejects.toThrow("database down");
  });
});

describe("new-title quota SQL", () => {
  const scraped = parseScrapePayload({
    hashtag: 42, title_name: "title", image_link: "", pages: 1, uploaded_at: null,
    tags: [], artists: [], groups: [], characters: [], parodies: [],
  });

  it("lets an existing identity bypass the owner-scoped title cap and reports creation", () => {
    const sql = titleUpsertSql("alice", scraped);
    expect(sql.sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM titles WHERE user_id = \? AND source = \? AND source_id = \?\)\s+OR \(SELECT COUNT\(\*\) FROM titles WHERE user_id = \?\) < \?/);
    expect(sql.values.at(-1)).toBe(TITLE_LIMIT);
    expect(sql.sql).toContain("RETURNING hashtag, (xmax = 0) AS created");
  });

  it("locks by authenticated owner in a separate statement before counting", () => {
    const sql = userWriteLockSql("alice");
    expect(sql.sql).toContain("pg_advisory_xact_lock");
    expect(sql.values).toEqual(["alice"]);
    expect(sql.sql).not.toContain("FROM titles");
  });
});
