// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/app/account/actions", () => ({ saveScraperEndpointsAction: save }));
import { ScraperSettings } from "./ScraperSettings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const EPS = [
  { position: 0, label: "box", url: "https://a.example", hasSecret: true },
  { position: 1, label: "", url: "https://b.example", hasSecret: false },
];
const ui = (eps = EPS, limit = 8) => <ScraperSettings initialEndpoints={eps} limit={limit} secretStorageReady />;
const saveButton = () => screen.getByRole("button", { name: "Save hosts" });
const hostCards = () => screen.getAllByRole("heading", { level: 3 });

describe("ScraperSettings", () => {
  it("explains how to run a host and links to the deployed SCRAPER.md guide", () => {
    render(ui([]));
    expect(screen.getByText(/You need your own before adding titles/)).toBeTruthy();
    expect(screen.getByText(/ngrok installed/)).toBeTruthy();
    expect(screen.getByText("render.yaml")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read SCRAPER.md for setup instructions" }).getAttribute("href")).toBe("/scraper-guide");
  });
  it("renders identical markup on every server render", () => {
    // Row keys become input ids; a module-level counter made each request's
    // markup differ from the browser's first render and broke hydration.
    expect(renderToString(ui())).toBe(renderToString(ui()));
  });

  it("only saves once something changed", () => {
    render(ui());
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saveButton());
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getAllByLabelText("Name · optional")[1], { target: { value: "render" } });
    expect(saveButton().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("keeps stored secrets as null, drops blank rows, trims labels and sends list order", async () => {
    save.mockResolvedValue({ ok: true, endpoints: [] });
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Add fallback host" }));
    fireEvent.click(screen.getByRole("button", { name: "Move box down" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual([
      { label: undefined, url: "https://b.example", secret: null },
      { label: "box", url: "https://a.example", secret: null },
    ]);
  });

  it("sends a replaced secret, and 'Keep saved' undoes the replacement", async () => {
    save.mockResolvedValue({ ok: true, endpoints: EPS });
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Replace secret for box" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep saved" }));
    expect(screen.getByRole("button", { name: "Replace secret for box" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace secret for box" }));
    fireEvent.change(screen.getAllByLabelText("SCRAPER_SECRET")[0], { target: { value: "s3cret" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0][0]).toMatchObject({ url: "https://a.example", secret: "s3cret" });
  });

  it("caps rows at the limit and always keeps one row", () => {
    render(ui([EPS[0]], 2));
    fireEvent.click(screen.getByRole("button", { name: "Add fallback host" }));
    expect(screen.queryByRole("button", { name: /Add .*host/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove box" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove new host" }));
    expect(hostCards()).toHaveLength(1);
    expect(screen.getByLabelText("URL")).toHaveProperty("value", "");
  });

  it("reports a rejected save, then re-keys rows from the saved result", async () => {
    save.mockResolvedValueOnce({ ok: false, error: "Only https URLs" })
      .mockResolvedValueOnce({ ok: true, endpoints: [{ position: 0, label: "", url: "https://c.example", hasSecret: true }] });
    render(ui());
    fireEvent.change(screen.getAllByLabelText("URL")[1], { target: { value: "http://c.example" } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Only https URLs");
    fireEvent.click(saveButton());
    await screen.findByText("Saved.");
    expect(hostCards()).toHaveLength(1);
    expect(screen.getByLabelText("URL")).toHaveProperty("value", "https://c.example");
    expect(screen.getByRole("button", { name: "Replace secret for c.example" })).toBeTruthy();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("announces reordering for screen readers", () => {
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Move box down" }));
    expect(screen.getByRole("status").textContent).toContain("box moved to position 2 of 2.");
  });
});
