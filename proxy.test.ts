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
});
