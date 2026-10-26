import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { AUDIT_TITLES_SQL, auditSince, auditTitleIds, parseAuditTitles, type AuditTitle } from "./audit-title-ids";

const title = (hashtag: number, patch: Partial<AuditTitle> = {}): AuditTitle => ({
  user_id: "owner", hashtag, source: "manga.example", source_id: "some-title",
  url: "https://manga.example/some-title/", title_name: "Some title", created_at: "2026-10-05 00:00:00", ...patch,
});

describe("read-only title ID audit", () => {
  it("R3.7: preserves the UTC cutoff through the real Neon type parser in Berlin", async () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    try {
      const textProjection = AUDIT_TITLES_SQL.includes("to_char(created_at");
      const row = title(1, { source_id: "old", created_at: textProjection ? "2026-10-05T01:00:00.000Z" : "2026-10-05 01:00:00" });
      const fields = Object.keys(row).map((name) => ({ name, dataTypeID: name === "created_at" ? textProjection ? 25 : 1114 : name === "hashtag" ? 23 : 25 }));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ fields, rows: [Object.values(row).map(String)], command: "SELECT", rowCount: 1 }));
      const sql = neon("postgresql://u:p@ep-test.neon.tech/nhdb_test");
      const driverRows = await sql.query(AUDIT_TITLES_SQL, ["owner"]);
      expect(auditTitleIds(parseAuditTitles(driverRows))).toMatchObject({ in_window: 1, mismatches: [{ hashtag: 1, created_at: "2026-10-05T01:00:00.000Z" }] });
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it("R3.7: reads SQL timestamps without seconds as UTC in Berlin", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    try {
      expect(auditTitleIds([title(1, { source_id: "old", created_at: "2026-10-05 01:00" })]).in_window).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it("lists confirmed old year, paging-query and underscore IDs without changing the input", () => {
    const rows = [
      title(1, { source_id: "2019", url: "https://manga.example/morningledgermvylxao-2019/" }),
      title(2, { source_id: "2", url: "https://manga.example/another-title/?p=2" }),
      title(3, { source_id: "1234", url: "https://manga.example/sister_1234/" }),
      title(4),
    ];
    const before = JSON.stringify(rows);
    const report = auditTitleIds(rows);
    expect(report.mismatches.map((r) => [r.hashtag, r.source_id, r.current_id])).toEqual([
      [1, "2019", "morningledgermvylxao-2019"], [2, "2", "another-title"], [3, "1234", "sister_1234"],
    ]);
    expect(report).toMatchObject({ scanned: 4, in_window: 4, unreadable: [] });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("uses an inclusive UTC cutoff and checks older collisions only within the same owner", () => {
    const rows = [
      title(1, { source_id: "old", created_at: "2026-10-05 00:00:00" }),
      title(2, { created_at: "2026-10-04T23:59:59.999Z" }),
      title(3, { user_id: "other", created_at: "2026-10-04T23:59:59Z" }),
      title(4, { source_id: "earlier", created_at: "2026-10-05T01:00:00+02:00" }),
    ];
    expect(auditTitleIds(rows)).toMatchObject({ in_window: 1, mismatches: [{ hashtag: 1, collides_with: [2, 4] }] });
  });

  it("flags two old rows that would converge on the same future identity", () => {
    const report = auditTitleIds([title(1, { source_id: "one" }), title(2, { source_id: "two" })]);
    expect(report.mismatches.map((r) => r.collides_with)).toEqual([[2], [1]]);
  });

  it("keeps null/invalid/listing URLs separate from ID mismatches", () => {
    const report = auditTitleIds([title(1, { url: null }), title(2, { url: "broken" }), title(3, { url: "https://manga.example/tag/foo/" })]);
    expect(report.mismatches).toEqual([]);
    expect(report.unreadable.map((r) => r.reason)).toEqual(["missing_url", "unrecognised_url", "unrecognised_url"]);
  });

  it("shows the current source as well as ID when the saved URL names another site", () => {
    expect(auditTitleIds([title(1, { source: "old.example", source_id: "old" })]).mismatches[0]).toMatchObject({ current_source: "manga.example", current_id: "some-title" });
  });

  it("accepts SQL timestamps and Date objects and rejects malformed exports or dates", () => {
    expect(parseAuditTitles([title(1, { created_at: new Date("2026-10-05T00:00:00Z") })])).toHaveLength(1);
    for (const value of [null, {}, [title(1, { created_at: "not a date" })], [{ ...title(1), source_id: null }], [{ ...title(1), hashtag: "1" }]]) {
      expect(() => parseAuditTitles(value)).toThrow();
    }
    for (const day of ["yesterday", "2026-02-30", "2026-13-01", "2026-10-05T12:00:00Z"]) expect(() => auditSince(day)).toThrow();
    expect(parseAuditTitles([{ ...title(1), secret: "do-not-include" }])[0]).not.toHaveProperty("secret");
  });

  it("runs the offline CLI without DB/session access and refuses write/owner flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "nhdb-id-audit-"));
    try {
      const input = join(dir, "snapshot.json");
      writeFileSync(input, JSON.stringify([title(1, { source_id: "2019", url: "https://manga.example/morningledgermvylxao-2019/" })]));
      const run = (args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/audit-title-ids.ts", ...args], {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DATABASE_URL: "postgresql://do-not-contact.invalid/unused", APP_URL: "http://do-not-contact.invalid", NHDB_SESSION_COOKIE: "do-not-include" },
      });
      const output = run([`--from-json=${input}`]);
      expect(JSON.parse(output).mismatches[0].current_id).toBe("morningledgermvylxao-2019");
      expect(output).not.toContain("do-not-include");
      for (const args of [[], ["--write"], ["--user-id=other"], [`--from-json=${input}`, "--database"]]) expect(() => run(args)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
