// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ON_OFF, SegmentedToggle } from "./Primitives";

afterEach(cleanup);

const pressed = (label: string) => screen.getByText(label).getAttribute("aria-pressed");

// The four filter toggles now share this control, and two of them key it on a
// boolean — the case where `key` and a naive truthiness check both go wrong.
describe("SegmentedToggle", () => {
  it("marks the selected option and reports the one clicked", () => {
    const onChange = vi.fn();
    render(<SegmentedToggle value="or" options={[
      { id: "and", label: "all" },
      { id: "or", label: "any" },
    ]} onChange={onChange} />);

    expect(pressed("any")).toBe("true");
    expect(pressed("all")).toBe("false");

    fireEvent.click(screen.getByText("all"));
    expect(onChange).toHaveBeenCalledWith("and");
  });

  it("renders both boolean options and distinguishes false from unselected", () => {
    const onChange = vi.fn();
    // `false` is a real value here, not "nothing selected" — the off pill has
    // to light up, and both pills have to exist despite `false` being falsy.
    render(<SegmentedToggle value={false} options={ON_OFF} onChange={onChange} />);

    expect(pressed("off")).toBe("true");
    expect(pressed("on")).toBe("false");

    fireEvent.click(screen.getByText("on"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("swallows clicks while disabled", () => {
    const onChange = vi.fn();
    render(<SegmentedToggle value={false} options={ON_OFF} onChange={onChange} disabled />);
    fireEvent.click(screen.getByText("on"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
