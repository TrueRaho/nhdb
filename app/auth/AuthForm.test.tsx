// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signIn, signUp, sendVerificationEmail, getSession } = vi.hoisted(() => ({
  signIn: vi.fn(), signUp: vi.fn(), sendVerificationEmail: vi.fn(), getSession: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { signIn: { email: signIn }, signUp: { email: signUp }, sendVerificationEmail, getSession } }));
vi.mock("@/components/SignOutButton", () => ({ SignOutButton: () => <button>Sign out</button> }));
import { AuthForm } from "./AuthForm";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("auth forms", () => {
  it("submits email and password and exposes provider errors", async () => {
    signIn.mockResolvedValue({ error: { message: "Invalid email or password" } });
    render(<AuthForm mode="sign-in" next="/add/123" />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Invalid email or password");
    expect(signIn).toHaveBeenCalledWith({ email: "alice@example.test", password: "password123" });
  });

  it("keeps email verification callbacks on the application origin", async () => {
    signUp.mockResolvedValue({ error: { message: "Try another email" } });
    render(<AuthForm mode="sign-up" next="//evil.example" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("Try another email");
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ name: "Alice", callbackURL: `${window.location.origin}/` }));
  });

  it("sends a verification email and allows retrying network failures", async () => {
    sendVerificationEmail.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: {} });
    render(<AuthForm mode="verify-email" next="/add/123" initialEmail="alice@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Send verification email" }));
    await screen.findByText("Could not reach the sign-in service. Please try again.");
    fireEvent.click(screen.getByRole("button", { name: "Send verification email" }));
    await screen.findByRole("status");
    expect(sendVerificationEmail).toHaveBeenLastCalledWith({ email: "alice@example.test", callbackURL: `${window.location.origin}/add/123` });
  });

  it("refreshes verification status without trusting the cached session", async () => {
    getSession.mockResolvedValue({ data: { user: { emailVerified: false } } });
    render(<AuthForm mode="verify-email" next="/" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue after verification" }));
    await waitFor(() => expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } }));
    await screen.findByText("Your email is not verified yet. Open the link in your verification email first.");
  });
});
