// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signIn, signUp, sendVerificationEmail, getSession, verifyEmailOtp } = vi.hoisted(() => ({
  signIn: vi.fn(), signUp: vi.fn(), sendVerificationEmail: vi.fn(), getSession: vi.fn(), verifyEmailOtp: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { signIn: { email: signIn }, signUp: { email: signUp }, sendVerificationEmail, getSession, emailOtp: { verifyEmail: verifyEmailOtp } } }));
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

  it("resends the code for a known address and allows retrying network failures", async () => {
    sendVerificationEmail.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: {} });
    render(<AuthForm mode="verify-email" next="/add/123" initialEmail="alice@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await screen.findByText("Could not reach the sign-in service. Please try again.");
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await screen.findByText(/an email is on its way/);
    expect(sendVerificationEmail).toHaveBeenLastCalledWith({ email: "alice@example.test", callbackURL: `${window.location.origin}/add/123` });
  });

  it("leads with the code field when the address is known, and asks for it otherwise", () => {
    const { unmount } = render(<AuthForm mode="verify-email" next="/" initialEmail="alice@example.test" />);
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send verification email" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use another email" }));
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "alice@example.test");
    expect(screen.getByRole("button", { name: "Send verification email" })).toBeTruthy();
    unmount();
    render(<AuthForm mode="verify-email" next="/" />);
    expect(screen.getByRole("button", { name: "Send verification email" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resend code" })).toBeNull();
  });

  it("offers sign-out on the verify screen only when a session exists", () => {
    const { rerender } = render(<AuthForm mode="verify-email" next="/" />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByRole("link", { name: /back to sign in/ })).toBeTruthy();
    rerender(<AuthForm mode="verify-email" next="/" signedIn />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("keeps the return path in the mode tabs and marks the current one", () => {
    render(<AuthForm mode="sign-in" next="/add/177013" />);
    expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe("/auth/sign-up?next=%2Fadd%2F177013");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("aria-current")).toBe("page");
  });

  it("sends an unverified sign-in and a fresh sign-up to verification", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: window.location.origin, replace });
    try {
      signIn.mockResolvedValue({ error: { code: "EMAIL_NOT_VERIFIED", message: "x" } });
      const { unmount } = render(<AuthForm mode="sign-in" next="/add/1" />);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.test" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/verify-email?next=%2Fadd%2F1"));
      unmount();

      signUp.mockResolvedValue({ data: { user: { emailVerified: false } } });
      render(<AuthForm mode="sign-up" next="/account" />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "A" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.test" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/verify-email?next=%2Faccount"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches between sign-in and sign-up in place, keeping the URL and title in step", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    try {
      render(<AuthForm mode="sign-in" next="/add/1" />);
      const name = screen.getByLabelText("Name");
      expect(name.closest("[inert]")).not.toBeNull();
      expect(name.hasAttribute("required")).toBe(false);

      fireEvent.click(screen.getByRole("link", { name: "Create account" }));
      expect(replaceState).toHaveBeenLastCalledWith(null, "", "/auth/sign-up?next=%2Fadd%2F1");
      expect(document.title).toBe("Create account · nhdb");
      expect(screen.getByRole("link", { name: "Create account" }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByLabelText("Name").closest("[inert]")).toBeNull();
      expect(screen.getByLabelText("Name").hasAttribute("required")).toBe(true);
      expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Start your library");

      // A modified click is left to the browser (open in a new tab): not
      // prevented by the form. The probe stops jsdom from navigating itself.
      let prevented: boolean | undefined;
      const probe = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
      document.addEventListener("click", probe);
      fireEvent.click(screen.getByRole("link", { name: "Sign in" }), { metaKey: true });
      document.removeEventListener("click", probe);
      expect(prevented).toBe(false);
      expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    } finally {
      replaceState.mockRestore();
    }
  });

  it("reveals the password on demand", () => {
    render(<AuthForm mode="sign-in" next="/" />);
    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("refreshes verification status without trusting the cached session", async () => {
    getSession.mockResolvedValue({ data: { user: { emailVerified: false } } });
    render(<AuthForm mode="verify-email" next="/" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue after verification" }));
    await waitFor(() => expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } }));
    await screen.findByText("Your email is not verified yet. Enter the code or open the link from your verification email first.");
  });

  it("verifies a numeric code, then re-reads the session before continuing", async () => {
    verifyEmailOtp.mockResolvedValue({ data: { status: true } });
    getSession.mockResolvedValue({ data: { user: { emailVerified: true } } });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: window.location.origin, replace });
    try {
      render(<AuthForm mode="verify-email" next="/account" initialEmail="alice@example.test" />);
      fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: " 123456 " } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/account"));
      expect(verifyEmailOtp).toHaveBeenCalledWith({ email: "alice@example.test", otp: "123456" });
      expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
      expect(sendVerificationEmail).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a rejected code without leaving the screen", async () => {
    verifyEmailOtp.mockResolvedValue({ error: { message: "Invalid OTP" } });
    render(<AuthForm mode="verify-email" next="/" initialEmail="alice@example.test" />);
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByText("Invalid OTP");
    expect(getSession).not.toHaveBeenCalled();
  });
});
