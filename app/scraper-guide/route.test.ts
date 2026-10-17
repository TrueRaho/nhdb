import { expect, it } from "vitest";
import { GET } from "./route";

it("serves the local per-user scraper instructions linked from Account", async () => {
  const response = await GET();
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  const text = await response.text();
  expect(text).toContain("# Scraper service");
  expect(text).toContain("/account");
  expect(text).toContain("Production ignores `SCRAPER_SERVICE_URL*`");
  expect(text).toContain("pnpm scraper");
  expect(text).toContain("render.yaml");
});
