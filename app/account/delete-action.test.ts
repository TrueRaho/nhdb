import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/session", () => ({ requireUserId: vi.fn() }));
vi.mock("../../lib/db", () => ({ prisma: { $transaction: vi.fn() } }));
vi.mock("../../lib/auth/server", () => ({ auth: { deleteUser: vi.fn(), signOut: vi.fn() } }));
vi.mock("../../lib/account-deletion", () => ({ deleteAccountData: vi.fn() }));
vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }) }));
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { updateTag } from "next/cache";
import { requireUserId } from "../../lib/session";
import { prisma } from "../../lib/db";
import { auth } from "../../lib/auth/server";
import { deleteAccountData } from "../../lib/account-deletion";
import { deleteAccountAction } from "./delete-action";

const clearCookie = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(redirect).mockImplementation((path) => { throw new Error(`redirect:${path}`); });
  vi.mocked(requireUserId).mockResolvedValue("user-a");
  vi.mocked(deleteAccountData).mockResolvedValue([101, 102]);
  vi.mocked(prisma.$transaction).mockImplementation(async (fn) => (fn as (tx: unknown) => Promise<unknown>)({ transaction: true }));
  vi.mocked(auth.deleteUser).mockResolvedValue({ data: { success: true, message: "User deleted" }, error: null } as never);
  vi.mocked(auth.signOut).mockResolvedValue({ data: { success: true }, error: null } as never);
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => [
      { name: "__Secure-neon-auth.session_token" },
      { name: "__Secure-neon-auth.local.session_data" }, { name: "unrelated" },
    ], set: clearCookie,
  } as never);
});

describe("delete account action", () => {
  it("rejects an unauthenticated direct call before data or auth writes", async () => {
    vi.mocked(requireUserId).mockRejectedValue(new Error("Unauthorized"));
    await expect(deleteAccountAction("DELETE")).rejects.toThrow("Unauthorized");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it.each(["", "delete", "DELETE ", null, { userId: "user-b", confirmation: "DELETE" }])("requires exact confirmation: %j", async (value) => {
    expect(await deleteAccountAction(value as string)).toEqual({ ok: false, error: "Type DELETE to confirm." });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });
  it("commits the session owner's data before deleting their login, then signs out", async () => {
    await expect(deleteAccountAction("DELETE")).rejects.toThrow("redirect:/auth/sign-in?account=deleted");
    expect(deleteAccountData).toHaveBeenCalledWith({ transaction: true }, "user-a");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auth.deleteUser).toHaveBeenCalledWith({});
    expect(vi.mocked(prisma.$transaction).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(auth.deleteUser).mock.invocationCallOrder[0]);
    expect(vi.mocked(auth.deleteUser).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(auth.signOut).mock.invocationCallOrder[0]);
    expect(vi.mocked(updateTag).mock.calls.flat()).toEqual([
      "titles-list:user-a", "dataset:user-a", "stats:user-a", "similar:user-a",
      "title:user-a:101", "similar:user-a:101", "title:user-a:102", "similar:user-a:102",
    ]);
    expect(clearCookie.mock.calls.map(([name]) => name)).toEqual(["__Secure-neon-auth.session_token", "__Secure-neon-auth.local.session_data"]);
    expect(clearCookie).toHaveBeenCalledWith("__Secure-neon-auth.session_token", "", {
      maxAge: 0, expires: new Date(0), path: "/", secure: true, httpOnly: true, sameSite: "lax",
    });
  });
  it("does not delete the login or invalidate tags if the transaction rolls back", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("database failure"));
    expect((await deleteAccountAction("DELETE")).ok).toBe(false);
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: { message: "disabled" } },
    { data: { success: true, message: "Verification email sent" }, error: null },
    { data: null, error: null },
  ])("reports a remaining login honestly: %j", async (response) => {
    vi.mocked(auth.deleteUser).mockResolvedValue(response as never);
    await expect(deleteAccountAction("DELETE")).rejects.toThrow("redirect:/auth/sign-in?account=data-deleted");
    expect(auth.signOut).toHaveBeenCalled();
  });
  it("clears local sessions even when both auth calls fail", async () => {
    vi.mocked(auth.deleteUser).mockRejectedValue(new Error("offline"));
    vi.mocked(auth.signOut).mockRejectedValue(new Error("offline"));
    await expect(deleteAccountAction("DELETE")).rejects.toThrow("redirect:/auth/sign-in?account=data-deleted");
    expect(clearCookie).toHaveBeenCalledTimes(2);
  });
});
