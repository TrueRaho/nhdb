import { beforeEach, describe, expect, it, vi } from "vitest";

const { set, request } = vi.hoisted(() => {
  process.env.NEON_AUTH_BASE_URL = "https://auth.nhdb.test/neondb/auth";
  process.env.NEON_AUTH_COOKIE_SECRET = "a-test-secret-that-is-long-enough-000";
  return { set: vi.fn(), request: { cookie: "" } };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ set }),
  headers: async () => new Headers({ cookie: request.cookie }),
}));
// Supplies only handler() and middleware(), neither exercised here — and its
// bare `next/headers` import does not resolve outside Next's bundler.
vi.mock("@neondatabase/auth/next/server", () => ({ createNeonAuth: () => ({ handler: vi.fn(), middleware: vi.fn() }) }));

import { auth } from "./server";

const now = new Date().toISOString();
const upstreamSession = {
  session: { id: "s1", token: "tok", userId: "alice", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now, updatedAt: now },
  user: { id: "alice", email: "alice@example.test", name: "Alice", emailVerified: true, createdAt: now, updatedAt: now },
};

beforeEach(() => {
  set.mockReset();
  // A cache miss: the session token, but no session_data cookie.
  request.cookie = "__Secure-neon-auth.session_token=tok.sig";
  // Neon Auth answers get-session and refreshes its own cache cookie.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstreamSession), {
    headers: [
      ["content-type", "application/json"],
      ["set-cookie", "__Secure-neon-auth.session_data=refreshed; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=None"],
    ],
  })));
});

describe("auth.getSession", () => {
  it("reads the session while a Server Component renders, where cookies are read-only", async () => {
    set.mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
    });
    const { data, error } = await auth.getSession();
    expect(error).toBeNull();
    expect(data?.user.id).toBe("alice");
  });

  it("still stores the refreshed cookie where Next allows writing it", async () => {
    await auth.getSession();
    expect(set).toHaveBeenCalledWith("__Secure-neon-auth.session_data", "refreshed", expect.objectContaining({ httpOnly: true, secure: true }));
  });
});
