import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));

import { open, seal, SecretBoxError, secretStorageAvailable } from "./secret-box";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

beforeEach(() => vi.stubEnv("SCRAPER_CRED_KEY", KEY));
afterEach(() => vi.unstubAllEnvs());

describe("secret-box", () => {
  it("round-trips a secret", () => {
    expect(open(seal("s3cret-token"))).toBe("s3cret-token");
  });

  it("round-trips non-ASCII and empty values", () => {
    expect(open(seal("пароль 🔐"))).toBe("пароль 🔐");
    expect(open(seal(""))).toBe("");
  });

  it("never repeats a ciphertext for the same plaintext", () => {
    // A fresh nonce per seal: identical secrets must not be identifiable as
    // identical by looking at the column.
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("does not leak the plaintext into the stored form", () => {
    expect(seal("s3cret-token")).not.toContain("s3cret-token");
  });

  it("refuses a ciphertext produced under a different key", () => {
    const sealed = seal("token");
    vi.stubEnv("SCRAPER_CRED_KEY", OTHER_KEY);
    expect(() => open(sealed)).toThrow(SecretBoxError);
  });

  it("refuses a tampered ciphertext rather than returning altered bytes", () => {
    // This is why GCM and not CTR: the value becomes an Authorization header,
    // so a malleable ciphertext would let a row edit steer that header.
    const [version, iv, tag, body] = seal("token").split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 0xff;
    expect(() => open([version, iv, tag, flipped.toString("base64url")].join("."))).toThrow(SecretBoxError);
  });

  it("refuses a tampered auth tag", () => {
    const [version, iv, tag, body] = seal("token").split(".");
    const flipped = Buffer.from(tag, "base64url");
    flipped[0] ^= 0xff;
    expect(() => open([version, iv, flipped.toString("base64url"), body].join("."))).toThrow(SecretBoxError);
  });

  it.each(["", "garbage", "v1.only.three", "v2.a.b.c"])("refuses malformed stored value %j", (stored) => {
    expect(() => open(stored)).toThrow(SecretBoxError);
  });

  it("fails closed when no key is configured", () => {
    vi.stubEnv("SCRAPER_CRED_KEY", "");
    expect(secretStorageAvailable()).toBe(false);
    expect(() => seal("token")).toThrow(/SCRAPER_CRED_KEY is not set/);
  });

  it("rejects a key of the wrong length instead of padding it", () => {
    vi.stubEnv("SCRAPER_CRED_KEY", Buffer.from("too short").toString("base64"));
    expect(secretStorageAvailable()).toBe(false);
    expect(() => seal("token")).toThrow(/must decode to 32 bytes/);
  });
});
