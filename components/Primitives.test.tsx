// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NhCover, ON_OFF, Segmented, SegmentedToggle } from "./Primitives";
import type { Item } from "../lib/data";

afterEach(cleanup);

const checked = (name: string) => screen.getByRole("radio", { name }).getAttribute("aria-checked");

// The four filter toggles now share this control, and two of them key it on a
// boolean — the case where `key` and a naive truthiness check both go wrong.
describe("SegmentedToggle", () => {
  it("marks the selected option and reports the one clicked", () => {
    const onChange = vi.fn();
    render(<SegmentedToggle label="Match" value="or" options={[
      { id: "and", label: "all" },
      { id: "or", label: "any" },
    ]} onChange={onChange} />);

    expect(screen.getByRole("radiogroup", { name: "Match" })).toBeTruthy();
    expect(checked("any")).toBe("true");
    expect(checked("all")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "all" }));
    expect(onChange).toHaveBeenCalledWith("and");
  });

  it("renders both boolean options and distinguishes false from unselected", () => {
    const onChange = vi.fn();
    // `false` is a real value here, not "nothing selected" — the off pill has
    // to light up, and both pills have to exist despite `false` being falsy.
    render(<SegmentedToggle label="Ghost tags" value={false} options={ON_OFF} onChange={onChange} />);

    expect(checked("off")).toBe("true");
    expect(checked("on")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "on" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("swallows clicks and keys while disabled", () => {
    const onChange = vi.fn();
    render(<SegmentedToggle label="Related tags" value={false} options={ON_OFF} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("radio", { name: "on" }));
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Segmented", () => {
  const OPTIONS = [
    { id: "all", label: "all" },
    { id: "unread", label: "unread" },
    { id: "read", label: "read" },
  ] as const;

  it("slides one thumb to the selected segment instead of painting each button", () => {
    const { container, rerender } = render(<Segmented label="Read status" value="all" options={OPTIONS} onChange={() => {}} />);
    const thumb = () => container.querySelector<HTMLElement>("[aria-hidden]")!;
    expect(thumb().style.transform).toBe("translateX(0%)");
    expect(thumb().style.width).toContain("/ 3");
    rerender(<Segmented label="Read status" value="read" options={OPTIONS} onChange={() => {}} />);
    expect(thumb().style.transform).toBe("translateX(200%)");
  });

  it("is one tab stop, and arrow keys move and select with wrap-around", () => {
    const onChange = vi.fn();
    render(<Segmented label="Read status" value="all" options={OPTIONS} onChange={onChange} />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(screen.getByRole("radio", { name: "all" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("unread");
    fireEvent.keyDown(screen.getByRole("radio", { name: "all" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("read");
    fireEvent.keyDown(screen.getByRole("radio", { name: "all" }), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("read");
  });

  it("uses tab semantics for view switchers", () => {
    render(<Segmented label="View" kind="tab" value="stats" options={[
      { id: "gallery", label: "library" },
      { id: "stats", label: "analysis" },
    ]} onChange={() => {}} />);
    expect(screen.getByRole("tablist", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "analysis" }).getAttribute("aria-selected")).toBe("true");
  });
});

const HITOMI_PAGE = "https://hitomi.la/galleries/1234567.html";

const item = (imageLink: string, url = HITOMI_PAGE): Item => ({
  hashtag: 1_000_000_007, source: "hitomi", sourceId: "1234567", url, titleName: "Some Title", alterName: "",
  imageLink, pages: 20, uploadedAt: null, addedAt: 0, readCount: 0, lastReadAt: null,
  tags: [], artists: [], groups: [], parodies: [], characters: [],
});

const HITOMI = "https://tn.gold-usergeneratedcontent.net/webpbigtn/a/bc/abc.webp";

/** The <img>'s address relative to this origin, or null when none is drawn. */
function coverRequest(container: HTMLElement): string | null {
  const img = container.querySelector("img");
  if (!img) return null;
  const src = new URL(img.getAttribute("src")!, window.location.href);
  expect(src.origin).toBe(window.location.origin);
  return `${src.pathname}${src.search}`;
}

describe("NhCover", () => {
  it("loads the cover through the same-origin proxy, never from the site's CDN", () => {
    const { container } = render(<NhCover item={item(HITOMI)} />);
    // The page's origin rides along: the proxy sends it as the Referer that
    // hotlink-guarded CDNs (Hitomi's among them) check for.
    expect(coverRequest(container)).toBe(
      `/api/cover?src=${encodeURIComponent(HITOMI)}&ref=${encodeURIComponent("https://hitomi.la")}`,
    );
    // The procedural title is hidden while a real cover is expected.
    expect(screen.queryByText("Some Title")).toBeNull();
  });

  it("sends only the page's origin, never its path, as the Referer hint", () => {
    const { container } = render(<NhCover item={item(HITOMI, "https://www.somesite.org/gallery/42/?utm_source=x")} />);
    expect(coverRequest(container)).toBe(
      `/api/cover?src=${encodeURIComponent(HITOMI)}&ref=${encodeURIComponent("https://www.somesite.org")}`,
    );
  });

  it("asks without a Referer hint when the title has no page address", () => {
    const { container } = render(<NhCover item={item(HITOMI, "")} />);
    expect(coverRequest(container)).toBe(`/api/cover?src=${encodeURIComponent(HITOMI)}`);
  });

  it("accepts a cover on any CDN — which hosts serve covers is no longer a list", () => {
    const cover = "https://evil.example/cover.jpg";
    const { container } = render(<NhCover item={item(cover)} />);
    expect(coverRequest(container)).toBe(
      `/api/cover?src=${encodeURIComponent(cover)}&ref=${encodeURIComponent("https://hitomi.la")}`,
    );
  });

  it("falls back to the procedural cover when the image fails", () => {
    const { container } = render(<NhCover item={item(HITOMI)} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Some Title")).toBeTruthy();
  });

  // The proxy only fetches web addresses on a named host; asking it for
  // anything else would just be a broken image.
  it.each([
    ["no cover", ""],
    ["a javascript: link", "javascript:alert(1)"],
    ["a data: URI", "data:image/png;base64,iVBORw0KGgo="],
    ["a relative path", "/covers/1.jpg"],
    ["an IP literal", "https://169.254.169.254/latest/meta-data"],
    ["credentials in the link", "https://user:pass@cdn.example/cover.jpg"],
    ["an explicit port", "https://cdn.example:8443/cover.jpg"],
    ["another scheme", "ftp://cdn.example/cover.jpg"],
  ])("draws the procedural cover for %s, without asking the proxy", (_what, link) => {
    const { container } = render(<NhCover item={item(link)} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Some Title")).toBeTruthy();
  });
});
