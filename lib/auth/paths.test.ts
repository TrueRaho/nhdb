import { describe, expect, it } from "vitest";
import { authPath, safeReturnPath } from "./paths";

describe("safeReturnPath", () => {
  it.each([undefined, ["/add/123"], "https://evil.example", "//evil.example", "/\\evil.example", "/\nevil.example", "/%2f%2fevil.example", "/%5cevil.example", "/auth/sign-in", "/api/auth/sign-out", "/%61uth/sign-in", "/x/../auth/sign-in", "/%broken"])("rejects unsafe or looping destination %j", (value) => {
    expect(safeReturnPath(value)).toBe("/");
  });

  it("preserves a local share-sheet destination and filters", () => {
    expect(safeReturnPath("/add/177013?source=share#details")).toBe("/add/177013?source=share#details");
    expect(authPath("/auth/sign-in", "/?add=177013,895243")).toBe("/auth/sign-in?next=%2F%3Fadd%3D177013%2C895243");
  });
});
