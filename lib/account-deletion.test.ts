import { describe, expect, it, vi } from "vitest";
import { accountDeletionSql, deleteAccountData } from "./account-deletion";

describe("account data deletion", () => {
  it("fails closed for a missing owner", () => {
    expect(() => accountDeletionSql("")).toThrow("Missing user ID");
  });
  it("binds the owner on every statement and sweeps unlinked entities before deleting titles", async () => {
    const statements = accountDeletionSql("user-a");
    expect(statements[0].text).toContain("pg_advisory_xact_lock");
    expect(statements.every((sql) => sql.values.includes("user-a"))).toBe(true);
    expect(statements.filter((sql) => /DELETE FROM titles\b/.test(sql.text))).toHaveLength(1);
    expect(statements.slice(1, 6).every((sql) => sql.text.includes("NOT EXISTS"))).toBe(true);
    for (const table of ["read_logs", "scraper_endpoints"]) {
      expect(statements.some((sql) => sql.text.includes(`DELETE FROM ${table} WHERE user_id =`))).toBe(true);
    }
    expect(statements.some((sql) => /\b(?:scrape_budget|usage_budget)\b/.test(sql.text))).toBe(false);
    const seen: string[] = [];
    const query = vi.fn().mockImplementation(async (sql) => { seen.push(sql.text); return [{ hashtag: 101 }]; });
    const execute = vi.fn().mockImplementation(async (sql) => { seen.push(sql.text); return 0; });
    expect(await deleteAccountData({ $queryRaw: query, $executeRaw: execute }, "user-a")).toEqual([101]);
    expect(seen).toEqual(statements.map((sql) => sql.text));
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].text).toContain("pg_advisory_xact_lock");
  });
  it("stops at a failing statement so the enclosing transaction can roll back", async () => {
    const execute = vi.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("failed"));
    const query = vi.fn();
    await expect(deleteAccountData({ $queryRaw: query, $executeRaw: execute }, "user-a")).rejects.toThrow("failed");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
  });
});
