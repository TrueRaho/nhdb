import { describe, expect, it } from "vitest";
import { claimStatements, UNCLAIMED_USER_ID } from "./claim";

describe("legacy claim owner validation", () => {
  it.each(["", " ", "x".repeat(65), "x'; DELETE FROM titles; --", UNCLAIMED_USER_ID])(
    "rejects invalid owner %j before connecting to the database", (owner) => {
      expect(() => claimStatements(owner)).toThrow("valid Neon Auth user ID");
    },
  );
});
