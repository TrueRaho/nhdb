// Authenticated encryption for the scraper bearer tokens stored in
// scraper_endpoints.secret_enc.
//
// Why at all: the database is shared between users, so that column holds
// several people's service credentials at once. A dump of the collection is
// already bad; a dump that also hands over everyone's scraper tokens is worse,
// and AES-GCM behind one env var is a cheap way to make the column useless on
// its own.
//
// GCM rather than CBC/CTR because the ciphertext must be *tamper-evident*: the
// value is read back and sent as an `Authorization` header, and a malleable
// ciphertext would let anyone with write access to the row steer that header.
// Decryption of an edited row fails loudly instead.

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for
const KEY_BYTES = 32;
const VERSION = "v1";

/**
 * Thrown when a stored secret cannot be recovered — wrong key, rotated key, or
 * a tampered row. Callers treat the endpoint as misconfigured rather than
 * crashing the request: one unreadable secret must not take the whole scrape
 * path down, and it must never silently fall back to sending no credential.
 */
export class SecretBoxError extends Error {
  name = "SecretBoxError";
}

function key(): Buffer {
  const raw = process.env.SCRAPER_CRED_KEY;
  if (!raw) {
    throw new SecretBoxError(
      "SCRAPER_CRED_KEY is not set — it is required to store a scraper secret " +
        "(generate one with: openssl rand -base64 32)",
    );
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new SecretBoxError(`SCRAPER_CRED_KEY must decode to ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Encrypt a secret for storage. Returns `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

/** Recover a sealed secret, or throw SecretBoxError. */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError("Stored secret is not in the expected format");
  }
  const [, iv, tag, body] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch (cause) {
    // A GCM tag mismatch and a wrong-length key look the same from here on
    // purpose — the caller gets "unusable", not a hint about which it was.
    if (cause instanceof SecretBoxError) throw cause;
    throw new SecretBoxError("Stored secret could not be decrypted", { cause });
  }
}

/** Whether a key is configured at all, for surfacing setup errors in the UI. */
export function secretStorageAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}
