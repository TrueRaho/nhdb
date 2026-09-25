import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { middleware } = vi.hoisted(() => ({ middleware: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ auth: { middleware } }));
import proxy from "./proxy";

beforeEach(() => {
  middleware.mockReset();
  middleware.mockImplementation(() => async () => NextResponse.next());
});

describe("proxy", () => {
  it("includes the original path and query in the login URL", async () => {
    await proxy(new NextRequest("https://nhdb.example/add/177013?source=share"));
    expect(middleware).toHaveBeenCalledWith({ loginUrl: "/auth/sign-in?next=%2Fadd%2F177013%3Fsource%3Dshare" });
  });

  it.each(["/api/scrape", "/auth/verify-email"])("leaves %s accessible to its own handler", async (path) => {
    const response = await proxy(new NextRequest(`https://nhdb.example${path}`));
    expect(response.status).toBe(200);
    expect(middleware).not.toHaveBeenCalled();
  });

  it("continues to run the SDK for its authentication endpoints", async () => {
    await proxy(new NextRequest("https://nhdb.example/api/auth/sign-in/email"));
    expect(middleware).toHaveBeenCalled();
  });

  it("lets the page it passes through read the cookies the SDK just issued", async () => {
    middleware.mockImplementation(() => async () => {
      const response = NextResponse.next();
      response.headers.append("set-cookie", "__Secure-neon-auth.local.session_data=fresh.jwt; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
      response.headers.append("set-cookie", "__Secure-neon-auth.gone=; Path=/; Max-Age=0; HttpOnly; Secure");
      return response;
    });
    const request = new NextRequest("https://nhdb.example/", {
      headers: { cookie: "theme=dark; __Secure-neon-auth.session_token=tok.sig%2B%3D; __Secure-neon-auth.local.session_data=stale.jwt; __Secure-neon-auth.gone=x" },
    });

    const response = await proxy(request);

    // What the page's headers() will see: fresh cache, dead cookie dropped,
    // everything else byte-for-byte (the token stays percent-encoded).
    expect(response.headers.get("x-middleware-request-cookie")).toBe(
      "theme=dark; __Secure-neon-auth.session_token=tok.sig%2B%3D; __Secure-neon-auth.local.session_data=fresh.jwt",
    );
    // And the browser still gets both.
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("leaves the SDK's redirects alone", async () => {
    const redirect = NextResponse.redirect("https://nhdb.example/auth/sign-in", {
      headers: { "set-cookie": "__Secure-neon-auth.local.session_data=; Path=/; Max-Age=0" },
    });
    middleware.mockImplementation(() => async () => redirect);
    expect(await proxy(new NextRequest("https://nhdb.example/"))).toBe(redirect);
  });
});
