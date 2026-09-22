// Server-only env access. Next.js auto-loads .env into process.env.
// Do not import this module from client components.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  // Neon Managed Better Auth: the branch's Auth API URL (Console → Auth →
  // Configuration). Every database branch gets its own, so a preview branch
  // authenticates against its own isolated user set.
  get NEON_AUTH_BASE_URL() {
    return required("NEON_AUTH_BASE_URL");
  },
  // HMAC key for the signed session_data cookie. The SDK itself rejects
  // anything under 32 characters; the check is repeated here so a too-short
  // value fails at startup with a message that says what to do about it.
  get NEON_AUTH_COOKIE_SECRET() {
    const v = required("NEON_AUTH_COOKIE_SECRET");
    if (v.length < 32) {
      throw new Error(
        "NEON_AUTH_COOKIE_SECRET must be at least 32 characters " +
          "(generate one with: openssl rand -base64 32)",
      );
    }
    return v;
  },
};
