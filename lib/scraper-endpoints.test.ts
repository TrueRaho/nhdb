import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));
type Row = { userId: string; position: number; label: string | null; url: string; secretEnc: string | null };
const { findMany, deleteMany, createMany, transaction } = vi.hoisted(() => ({
  findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(async () => []),
  deleteMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 0 })),
  // Typed with its argument so `mock.calls` keeps the rows this file asserts on.
  createMany: vi.fn<(args: { data: Row[] }) => Promise<{ count: number }>>(async () => ({ count: 0 })),
  transaction: vi.fn(),
}));
vi.mock("./db", () => ({
  prisma: {
    scraperEndpoint: { findMany, deleteMany, createMany },
    $transaction: transaction,
  },
}));

import { seal } from "./secret-box";
import {
  listScraperEndpoints, replaceScraperEndpoints, resolveScraperTargets, ScraperConfigError,
} from "./scraper-endpoints";

const USER = "alice";

/** The rows handed to createMany by the last replaceScraperEndpoints call. */
const written = (): Row[] => createMany.mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SCRAPER_CRED_KEY", randomBytes(32).toString("base64"));
  findMany.mockResolvedValue([]);
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ scraperEndpoint: { deleteMany, createMany } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("listScraperEndpoints", () => {
  it("reports that a secret exists without ever returning it", async () => {
    findMany.mockResolvedValue([
      { position: 0, label: "mac", url: "https://a.example.com", secretEnc: seal("token") },
      { position: 1, label: null, url: "https://b.example.com", secretEnc: null },
    ]);
    const view = await listScraperEndpoints(USER);
    expect(view).toEqual([
      { position: 0, label: "mac", url: "https://a.example.com", hasSecret: true },
      { position: 1, label: "", url: "https://b.example.com", hasSecret: false },
    ]);
    expect(JSON.stringify(view)).not.toContain("token");
  });
});

describe("replaceScraperEndpoints", () => {
  it("numbers positions from 0 in submitted order", async () => {
    await replaceScraperEndpoints(USER, [
      { url: "https://a.example.com", secret: "" },
      { url: "https://b.example.com/", secret: "" },
    ]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(written().map((r) => [r.position, r.url])).toEqual([
      [0, "https://a.example.com"],
      [1, "https://b.example.com"],
    ]);
  });

  it("carries a kept secret across a reorder, because it is keyed by URL", async () => {
    const sealed = seal("token-a");
    findMany.mockResolvedValue([
      { url: "https://a.example.com", secretEnc: sealed },
      { url: "https://b.example.com", secretEnc: null },
    ]);
    // a moves to the bottom and keeps its secret (secret: null = "leave it").
    await replaceScraperEndpoints(USER, [
      { url: "https://b.example.com", secret: null },
      { url: "https://a.example.com", secret: null },
    ]);
    expect(written()).toMatchObject([
      { position: 0, url: "https://b.example.com", secretEnc: null },
      { position: 1, url: "https://a.example.com", secretEnc: sealed },
    ]);
  });

  it("does NOT carry a secret onto a different URL", async () => {
    // A credential belongs to a host: repointing a row at another machine must
    // not quietly send the old machine's token to the new one.
    findMany.mockResolvedValue([{ url: "https://old.example.com", secretEnc: seal("token") }]);
    await replaceScraperEndpoints(USER, [{ url: "https://new.example.com", secret: null }]);
    expect(written()[0].secretEnc).toBeNull();
  });

  it("stores a new secret encrypted, never as plaintext", async () => {
    await replaceScraperEndpoints(USER, [{ url: "https://a.example.com", secret: "brand-new" }]);
    const stored = written()[0].secretEnc!;
    expect(stored).not.toContain("brand-new");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("clears the secret when an empty string is submitted", async () => {
    findMany.mockResolvedValue([{ url: "https://a.example.com", secretEnc: seal("token") }]);
    await replaceScraperEndpoints(USER, [{ url: "https://a.example.com", secret: "" }]);
    expect(written()[0].secretEnc).toBeNull();
  });

  it("rejects a duplicated host", async () => {
    await expect(replaceScraperEndpoints(USER, [
      { url: "https://a.example.com", secret: "" },
      { url: "https://a.example.com/", secret: "" },
    ])).rejects.toThrow(/listed twice/);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("names the offending row when a URL is unusable", async () => {
    await expect(replaceScraperEndpoints(USER, [
      { url: "https://ok.example.com", secret: "" },
      { url: "http://insecure.example.com", secret: "" },
    ])).rejects.toThrow(/^Host 2: /);
  });

  it("rejects more hosts than the schema allows", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ url: `https://h${i}.example.com`, secret: "" }));
    await expect(replaceScraperEndpoints(USER, rows)).rejects.toThrow(ScraperConfigError);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("writes nothing when the list is emptied", async () => {
    await replaceScraperEndpoints(USER, []);
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("resolveScraperTargets", () => {
  it("decrypts secrets and keeps priority order", async () => {
    findMany.mockResolvedValue([
      { position: 0, label: "mac", url: "https://a.example.com", secretEnc: seal("token-a") },
      { position: 1, label: null, url: "https://b.example.com", secretEnc: null },
    ]);
    expect(await resolveScraperTargets(USER)).toEqual([
      { url: "https://a.example.com", secret: "token-a", label: "mac" },
      { url: "https://b.example.com", secret: null, label: "https://b.example.com" },
    ]);
  });

  it("drops a host whose secret will not decrypt instead of calling it unauthenticated", async () => {
    // Silently downgrading a credentialed call to an anonymous one is the kind
    // of fallback that turns a key rotation into a security incident.
    vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([
      { position: 0, label: null, url: "https://a.example.com", secretEnc: "v1.aaaa.bbbb.cccc" },
      { position: 1, label: null, url: "https://b.example.com", secretEnc: null },
    ]);
    expect(await resolveScraperTargets(USER)).toEqual([
      { url: "https://b.example.com", secret: null, label: "https://b.example.com" },
    ]);
  });
});
