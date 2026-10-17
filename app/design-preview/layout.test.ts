import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); } }));
import DesignPreviewLayout from "./layout";

afterEach(() => vi.unstubAllEnvs());

describe("design preview harnesses", () => {
  it("terminates rendering with notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => DesignPreviewLayout({ children: "harness" })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("keeps the harness available in pnpm dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(DesignPreviewLayout({ children: "harness" })).toBe("harness");
  });
});
