import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts: unknown) => Promise<{ address: string }[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));

import { assertPublicHostname, assertReachableHost, isPublicAddress, normalizeScraperUrl, UnsafeUrlError } from "./net-guard";
import * as netAddress from "./net-address";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  lookup.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "224.0.0.1", "192.0.2.1", "198.18.0.1", "203.0.113.5",
  ])("rejects IPv4 %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255"])(
    "allows public IPv4 %s", (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
  ])("rejects IPv6 %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["2606:4700:4700::1111", "2a00:1450:4001:82f::200e"])(
    "allows public IPv6 %s", (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::169.254.169.254", "NAT64-embedded metadata address"],
  ])("unwraps and rejects %s (%s)", (address) => {
    // The whole point: an IPv4-only block list is walked straight past by these.
    expect(isPublicAddress(address)).toBe(false);
  });

  it("allows an IPv4-mapped public address", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });
});

describe("normalizeScraperUrl", () => {
  it("keeps a plain https origin and trims the trailing slash", () => {
    expect(normalizeScraperUrl("  https://scraper.example.com/  ")).toBe("https://scraper.example.com");
  });

  it("keeps a sub-path", () => {
    expect(normalizeScraperUrl("https://example.com/hooks/nhdb")).toBe("https://example.com/hooks/nhdb");
  });

  it.each([
    ["", "empty"],
    ["not a url", "unparseable"],
    ["ftp://example.com", "wrong scheme"],
    ["http://example.com", "plain http in production"],
    ["https://user:pw@example.com", "embedded credentials"],
    ["https://example.com?x=1", "query string"],
    ["https://example.com#f", "fragment"],
    [`https://example.com/${"a".repeat(300)}`, "too long"],
  ])("rejects %s (%s)", (raw) => {
    expect(() => normalizeScraperUrl(raw)).toThrow(UnsafeUrlError);
  });

  it("allows http on loopback outside production, for `pnpm scraper`", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(normalizeScraperUrl("http://localhost:3333")).toBe("http://localhost:3333");
    expect(normalizeScraperUrl("http://127.0.0.1:3333/")).toBe("http://127.0.0.1:3333");
  });

  it("still rejects http on a non-loopback host outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => normalizeScraperUrl("http://evil.example.com")).toThrow(UnsafeUrlError);
  });
});

describe("assertReachableHost", () => {
  it("accepts a name resolving to a public address", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    await expect(assertReachableHost("https://scraper.example.com")).resolves.toBeUndefined();
  });

  it("rejects a name resolving to loopback — the rebinding case", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1" }]);
    await expect(assertReachableHost("https://rebind.example.com")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects when ANY resolved address is private", async () => {
    // One public + one private answer is an attack, not a misconfiguration:
    // taking the first record would make the outcome a coin flip.
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "169.254.169.254" }]);
    await expect(assertReachableHost("https://mixed.example.com")).rejects.toThrow(
      /private address/,
    );
  });

  it("rejects a literal private IP without asking DNS", async () => {
    await expect(assertReachableHost("https://169.254.169.254")).rejects.toThrow(UnsafeUrlError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a host that does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertReachableHost("https://nope.example.com")).rejects.toThrow(/Could not resolve/);
  });

  it("rejects an empty DNS answer", async () => {
    lookup.mockResolvedValue([]);
    await expect(assertReachableHost("https://empty.example.com")).rejects.toThrow(/Could not resolve/);
  });

  it("rejects localhost in production", async () => {
    await expect(assertReachableHost("https://localhost:3333")).rejects.toThrow(UnsafeUrlError);
  });
});

describe("assertPublicHostname", () => {
  it("passes a name whose every address is public", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "2606:4700::1" }]);
    await expect(assertPublicHostname("t.nhentai.net")).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("t.nhentai.net", { all: true });
  });

  it("judges an address literal itself, without asking DNS", async () => {
    await expect(assertPublicHostname("93.184.216.34")).resolves.toBeUndefined();
    await expect(assertPublicHostname("2606:4700:4700::1111")).resolves.toBeUndefined();
    await expect(assertPublicHostname("::1")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicHostname("::ffff:169.254.169.254")).rejects.toThrow(UnsafeUrlError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a name with any private address, an unresolvable one, and a private literal", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "::ffff:169.254.169.254" }]);
    await expect(assertPublicHostname("t.nhentai.net")).rejects.toThrow(UnsafeUrlError);
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicHostname("nope.invalid")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicHostname("169.254.169.254")).rejects.toThrow(UnsafeUrlError);
  });
});

// The address rules moved to lib/net-address.ts so the scraper — plain Node on
// a user's own machine — and the cover proxy can share them; net-guard keeps
// re-exporting them for the scraper-host checks.
describe("lib/net-address", () => {
  it("is what net-guard re-exports, so one error class serves every caller", async () => {
    expect(isPublicAddress).toBe(netAddress.isPublicAddress);
    expect(assertPublicHostname).toBe(netAddress.assertPublicHostname);
    expect(UnsafeUrlError).toBe(netAddress.UnsafeUrlError);
    // /api/scrape catches net-guard's UnsafeUrlError; the throw comes from net-address.
    lookup.mockResolvedValue([{ address: "10.0.0.1" }]);
    const thrown = await netAddress.assertPublicHostname("rebind.example.com").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(UnsafeUrlError);
    expect((thrown as Error).name).toBe("UnsafeUrlError");
  });

  it("loads without server-only, which net-guard still requires", async () => {
    // The scraper imports it outside Next; a server-only import there would
    // break `pnpm scraper`. (server-only is mocked for the rest of this file.)
    vi.resetModules();
    vi.doUnmock("server-only");
    try {
      const fresh = await import("./net-address");
      expect(typeof fresh.assertPublicHostname).toBe("function");
      await expect(import("./net-guard")).rejects.toThrow(/server-only/);
    } finally {
      vi.doMock("server-only", () => ({}));
      vi.resetModules();
    }
  });
});
