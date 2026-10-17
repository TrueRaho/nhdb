import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { queryRaw, transaction } = vi.hoisted(() => {
  const queryRaw = vi.fn();
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRaw: queryRaw }));
  return { queryRaw, transaction };
});
vi.mock("./db", () => ({ prisma: { $queryRaw: queryRaw, $transaction: transaction } }));
import { checkCoverByteBudget, consumeCoverBudget, consumeCoverRequestBudget, consumeScrapeBudget } from "./rate-limit";
import { COVER_GLOBAL_BYTES, COVER_GLOBAL_REQUESTS, COVER_USER_BYTES, COVER_USER_REQUESTS, UsageLimitError } from "./usage-limits";

beforeEach(() => vi.resetAllMocks());

describe("cover byte budgets", () => {
  function runTransaction() {
    transaction.mockImplementation(async (run) => run({ $queryRaw: queryRaw }));
  }

  it("charges exact bytes to the session owner and a distinct global scope in one transaction", async () => {
    runTransaction();
    queryRaw.mockResolvedValue([{ used: BigInt(512) }]);
    expect(await consumeCoverBudget("alice", 512)).toMatchObject({ allowed: true });
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining(["cover-user", "alice", 512, COVER_USER_BYTES]));
    expect(queryRaw.mock.calls[1][0].values).toEqual(expect.arrayContaining(["cover-global", "", 512, COVER_GLOBAL_BYTES]));
  });

  it.each(["user", "global"])("rolls back ALL charges on a %s denial; denial increments nothing", async (denied) => {
    let committed = 0;
    let rolledBack = false;
    transaction.mockImplementation(async (run) => {
      try {
        const result = await run({ $queryRaw: queryRaw });
        committed++;
        return result;
      } catch (error) {
        expect(error).toBeInstanceOf(UsageLimitError);
        rolledBack = true;
        throw error;
      }
    });
    if (denied === "global") queryRaw.mockResolvedValueOnce([{ used: BigInt(100) }]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 360 }]);
    expect(await consumeCoverBudget("alice", 100)).toMatchObject({ allowed: false, retryAfterSeconds: 360 });
    expect(committed).toBe(0);
    expect(rolledBack).toBe(true);
    expect(queryRaw.mock.calls.filter(([q]) => q.sql.includes("INSERT INTO"))).toHaveLength(denied === "user" ? 1 : 2);
  });

  it("fails closed on a counter store error", async () => {
    runTransaction();
    queryRaw.mockRejectedValue(new Error("db unavailable"));
    await expect(consumeCoverBudget("alice", 100)).rejects.toThrow("db unavailable");
  });
});

describe("existing scrape budget", () => {
  it("allows only after the conditional upsert returns a row", async () => {
    queryRaw.mockResolvedValue([{ used: 1 }]);
    expect(await consumeScrapeBudget("alice")).toEqual({ allowed: true, used: 1, limit: 120 });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][0].sql).toContain("ON CONFLICT (user_id) DO UPDATE");
  });

  it("denies without charging and clamps retry to at least a second", async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: -1 }]);
    expect(await consumeScrapeBudget("alice")).toEqual({ allowed: false, limit: 120, retryAfterSeconds: 1 });
    expect(queryRaw.mock.calls[1][0].sql).toContain("SELECT CEIL");
  });
});

describe("cover request budgets", () => {
  it("charges one admitted attempt to user/day and deployment/month in one transaction", async () => {
    transaction.mockImplementation(async (run) => run({ $queryRaw: queryRaw }));
    queryRaw.mockResolvedValue([{ used: BigInt(1) }]);
    expect(await consumeCoverRequestBudget("alice")).toMatchObject({ allowed: true });
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining(["cover-request-user", "alice", 1, COVER_USER_REQUESTS, "day"]));
    expect(queryRaw.mock.calls[1][0].values).toEqual(expect.arrayContaining(["cover-request-global", "", 1, COVER_GLOBAL_REQUESTS, "month"]));
  });

  it.each(["user", "global"])("throws inside the transaction for a %s denial so neither request counter commits", async (denied) => {
    let committed = false;
    let rolledBack = false;
    transaction.mockImplementation(async (run) => {
      try {
        const result = await run({ $queryRaw: queryRaw });
        committed = true;
        return result;
      } catch (error) {
        expect(error).toBeInstanceOf(UsageLimitError);
        rolledBack = true;
        throw error;
      }
    });
    if (denied === "global") queryRaw.mockResolvedValueOnce([{ used: BigInt(1) }]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ reset_in: 864 }]);
    expect(await consumeCoverRequestBudget("alice")).toMatchObject({ allowed: false, retryAfterSeconds: 864 });
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
    expect(queryRaw.mock.calls.filter(([q]) => q.sql.includes("INSERT INTO"))).toHaveLength(denied === "user" ? 1 : 2);
  });

  it("fails closed on request counter errors", async () => {
    transaction.mockImplementation(async (run) => run({ $queryRaw: queryRaw }));
    queryRaw.mockRejectedValue(new Error("db unavailable"));
    await expect(consumeCoverRequestBudget("alice")).rejects.toThrow("db unavailable");
  });
});

describe("read-only cover byte pre-check", () => {
  it("allows absent or unexhausted current counters without charging", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await checkCoverByteBudget("alice")).toMatchObject({ allowed: true });
    expect(transaction).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0][0].sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it("denies an exhausted counter with a positive Retry-After and no writes", async () => {
    queryRaw.mockResolvedValue([{ reset_in: 0 }]);
    expect(await checkCoverByteBudget("alice")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(transaction).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});
