// Client-safe limits and expected errors; no database or session imports.
export const TITLE_LIMIT = 5000;
export const COMMIT_LIMIT = 240;
export const READ_LIMIT = 500;
export const EXPORT_LIMIT = 20;
export const READ_DEDUPE_MINUTES = 10;
// Enough for 3072 maximum-sized covers, or 5000 covers averaging 629 KiB.
export const COVER_USER_BYTES = 3 * 1024 ** 3;
export const COVER_GLOBAL_BYTES = 4_000_000_000;
// Two full 5000-title gallery passes/day; half the launch invocation target/month.
export const COVER_USER_REQUESTS = 10_000;
export const COVER_GLOBAL_REQUESTS = 500_000;

export class UsageLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super(message);
    this.name = "UsageLimitError";
  }
}
