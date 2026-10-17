import { afterEach, describe, expect, it, vi } from "vitest";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("node:http", () => ({ default: { createServer: () => ({ listen }) } }));
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("../lib/scraper", () => ({ scrapeTitle: vi.fn(), closeScraper: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  listen.mockClear();
});

describe("scraper server bind address", () => {
  it.each([
    [undefined, "127.0.0.1"],
    ["", "127.0.0.1"],
    ["test-secret", "0.0.0.0"],
  ])("binds with secret %s to %s", async (secret, host) => {
    vi.resetModules();
    vi.stubEnv("SCRAPER_SECRET", secret);
    vi.stubEnv("DISABLE_NGROK", "1");
    vi.stubEnv("RENDER", "");
    vi.stubEnv("PORT", "3333");
    // Import the real entry point without installing process-wide handlers.
    vi.spyOn(process, "on").mockReturnValue(process);
    await import("./scraper-server");
    expect(listen).toHaveBeenCalledExactlyOnceWith(3333, host, expect.any(Function));
  });
});
