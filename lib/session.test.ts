import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, redirect } = vi.hoisted(() => ({ getSession: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }) }));
vi.mock("server-only", () => ({}));
vi.mock("./auth/server", () => ({ auth: { getSession } }));
vi.mock("next/navigation", () => ({ redirect }));

import { getSessionUser, requireUserId, requireUserIdOrRedirect, UnauthorizedError } from "./session";

const user = { id: "alice", email: "alice@example.test", name: "Alice", emailVerified: true };
beforeEach(() => vi.clearAllMocks());

describe("session authorization", () => {
  it.each([
    { data: null },
    { data: { session: null, user } },
    { data: { session: {}, user: null } },
    { data: { session: {}, user }, error: { message: "invalid session" } },
  ])("fails closed without a valid session: %j", async (response) => {
    getSession.mockResolvedValue(response);
    expect(await getSessionUser()).toBeNull();
    await expect(requireUserId()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it.each([false, undefined, null])("does not authorize missing or false email verification: %j", async (emailVerified) => {
    getSession.mockResolvedValue({ data: { session: {}, user: { ...user, emailVerified } } });
    await expect(requireUserId()).rejects.toThrow("Email not verified");
    await expect(requireUserIdOrRedirect("/add/123")).rejects.toThrow("redirect:/auth/verify-email?next=%2Fadd%2F123");
  });

  it("returns only the authenticated user's id", async () => {
    getSession.mockResolvedValue({ data: { session: {}, user } });
    expect(await requireUserId()).toBe("alice");
    expect(await requireUserIdOrRedirect()).toBe("alice");
  });

  it("preserves the requested application route in sign-in redirects", async () => {
    getSession.mockResolvedValue({ data: null });
    await expect(requireUserIdOrRedirect("/add/123?source=share")).rejects.toThrow("redirect:/auth/sign-in?next=%2Fadd%2F123%3Fsource%3Dshare");
  });
});
