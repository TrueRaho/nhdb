import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFunction } from "node:net";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, buildConnector: vi.fn(actual.buildConnector) };
});
import { buildConnector } from "undici";
import { assertPublicHostname } from "./net-address";
import { fetchPublic } from "./public-fetch";

const connectionLookup = (vi.mocked(buildConnector).mock.calls[0][0] as { lookup: LookupFunction }).lookup;

function resolveConnection(hostname: string, all: boolean) {
  return new Promise<unknown>((resolve, reject) => {
    connectionLookup(hostname, { all }, ((error: Error | null, address: unknown, family: number) => {
      if (error) reject(error);
      else resolve(all ? address : { address, family });
    }) as Parameters<LookupFunction>[2]);
  });
}

beforeEach(() => { lookup.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("public fetch connection guard", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"])(
    "refuses %s at connect time even after a public preflight", async (address) => {
      lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValueOnce([{ address, family: 6 }]);
      await assertPublicHostname("rebind.example");
      // Real Node fetch + real Agent: its socket lookup rejects before dialling.
      await expect(fetchPublic("https://rebind.example/", { signal: AbortSignal.timeout(1000) }))
        .rejects.toMatchObject({ cause: { name: "UnsafeUrlError" } });
      expect(lookup).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])("returns only checked IPs without a second lookup (all=%s)", async (all) => {
    // Infer the real address family, rather than trusting the resolver's label.
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 6 }, { address: "2606:4700:4700::1111", family: 4 }]);
    const addresses = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    expect(await resolveConnection("public.example", all)).toEqual(all ? addresses : addresses[0]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("public.example", { all: true });
  });

  it("refuses mixed answers, empty answers and resolver failures", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }, { address: "10.0.0.1" }])
      .mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(resolveConnection("public.example", true)).rejects.toMatchObject({ name: "UnsafeUrlError" });
    await expect(resolveConnection("public.example", false)).rejects.toMatchObject({ name: "UnsafeUrlError" });
    await expect(resolveConnection("public.example", true)).rejects.toThrow("ENOTFOUND");
  });

  it("also refuses private IP literals that Node would not look up", async () => {
    await expect(fetchPublic("http://127.0.0.1/", {})).rejects.toMatchObject({ cause: { name: "UnsafeUrlError" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses the standard TLS connector with only lookup overridden", () => {
    expect(vi.mocked(buildConnector).mock.calls[0][0]).toEqual({ lookup: expect.any(Function) });
  });

  it("limits the localhost exception to explicit dev scrapers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response());
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NODE_ENV", "development");
    await fetchPublic("http://localhost:3333/scrape", {}, true);
    const dispatcher = (index: number) => (fetch.mock.calls.at(index)![1] as RequestInit & { dispatcher: unknown }).dispatcher;
    const local = dispatcher(0);
    for (const url of ["http://other.test/", "https://localhost/", "http://127.0.0.1/"]) {
      await fetchPublic(url, {}, true);
      expect(dispatcher(-1)).not.toBe(local);
    }
    vi.stubEnv("NODE_ENV", "production");
    await fetchPublic("http://localhost:3333/scrape", {}, true);
    expect(dispatcher(-1)).not.toBe(local);
  });
});
