// @vitest-environment jsdom
import { Activity } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/app/account/delete-action", () => ({ deleteAccountAction: vi.fn() }));
import { deleteAccountAction } from "@/app/account/delete-action";
import { DeleteAccount } from "./DeleteAccount";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(deleteAccountAction).mockResolvedValue({ ok: false, error: "Could not delete your data. Try again." });
});
afterEach(cleanup);

describe("account deletion confirmation", () => {
  it("requires typing the exact confirmation and explains irreversible data and login deletion", async () => {
    const { container } = render(<DeleteAccount />);
    const button = screen.getByRole("button", { name: "Permanently delete my account" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/your login remains; contact the operator/i)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "delete" } });
    await act(async () => fireEvent.submit(container.querySelector("form")!));
    expect(deleteAccountAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    expect(button.disabled).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(deleteAccountAction).toHaveBeenCalledWith("DELETE");
    expect(screen.getByRole("alert").textContent).toContain("Could not delete your data");
  });
  it("clears confirmation when Activity hides a retained account page", async () => {
    const view = (mode: "visible" | "hidden") => <Activity mode={mode}><DeleteAccount /></Activity>;
    const { rerender } = render(view("visible"));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    rerender(view("hidden"));
    rerender(view("visible"));
    await waitFor(() => expect((screen.getByLabelText("Type DELETE to confirm") as HTMLInputElement).value).toBe(""));
    expect((screen.getByRole("button", { name: "Permanently delete my account" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
