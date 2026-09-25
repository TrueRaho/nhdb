// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ON_OFF, Segmented, SegmentedToggle } from "./Primitives";

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
