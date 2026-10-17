// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_SCRAPER_HOST, NO_SCRAPER_HOST_MESSAGE } from "../lib/scraper-config";
vi.mock("./ScrapeJobsProvider", () => ({ useScrapeJobs: vi.fn() }));
import { useScrapeJobs } from "./ScrapeJobsProvider";
import { AddModal } from "./AddModal";
afterEach(cleanup);

describe("add flow scraper setup", () => {
  it.each([false, true])("links to setup before scraping and on no-host errors (failed=%s)", (failed) => {
    vi.mocked(useScrapeJobs).mockReturnValue({
      jobs: failed ? [{ key: "nhentai:101", input: "101", status: "error", error: NO_SCRAPER_HOST_MESSAGE, errorCode: NO_SCRAPER_HOST }] : [],
      scrapingCount: 0, readyCount: 0, startScrape: vi.fn(), dismiss: vi.fn(), retry: vi.fn(), commitReady: vi.fn(),
    });
    render(<AddModal open onClose={vi.fn()} recentAdds={[]} />);
    expect(screen.getByRole("link", { name: /Set up a host in Account settings/ }).getAttribute("href")).toBe("/account");
    if (failed) {
      expect(screen.getByText(NO_SCRAPER_HOST_MESSAGE)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Set up a scraper host" }).getAttribute("href")).toBe("/account");
    }
  });
});
