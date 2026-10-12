import { galleryIdOf, parseWebUrl, siteKey } from "../../lib/sources";

export const DEFAULT_AUDIT_SINCE = "2026-10-05";
export const AUDIT_TITLES_SQL = `SELECT user_id, hashtag, source, source_id, url, title_name,
to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM titles WHERE user_id = $1 ORDER BY hashtag`;

export interface AuditTitle {
  user_id: string;
  hashtag: number;
  source: string;
  source_id: string;
  url: string | null;
  title_name: string;
  created_at: string | Date;
}

export function auditSince(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new Error("--since must be a valid YYYY-MM-DD date (UTC)");
  }
  return date;
}

function createdAt(raw: string | Date): Date {
  // titles.created_at is timestamp WITHOUT time zone, stored as UTC. Do not
  // interpret a SQL timestamp using the CLI machine's local time zone.
  let text = typeof raw === "string" ? raw.replace(" ", "T") : raw;
  if (typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += "Z";
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid created_at in audit input");
  return date;
}

/** Validate an export/driver result instead of silently skipping malformed rows. */
export function parseAuditTitles(value: unknown): AuditTitle[] {
  if (!Array.isArray(value)) throw new Error("Audit input must be a JSON array of title rows");
  return value.map((row, i) => {
    if (!row || typeof row !== "object" ||
        !Number.isSafeInteger(row.hashtag) || row.hashtag <= 0 ||
        ![row.user_id, row.source, row.source_id].every((s) => typeof s === "string" && s.length > 0) ||
        !(row.url === null || typeof row.url === "string") ||
        typeof row.title_name !== "string" ||
        !(typeof row.created_at === "string" || row.created_at instanceof Date)) {
      throw new Error(`Malformed title row at index ${i}`);
    }
    createdAt(row.created_at);
    // Keep exactly the projection, never spread arbitrary export fields.
    return { user_id: row.user_id, hashtag: row.hashtag, source: row.source, source_id: row.source_id, url: row.url, title_name: row.title_name, created_at: row.created_at };
  });
}

export function auditTitleIds(rows: AuditTitle[], since = DEFAULT_AUDIT_SINCE) {
  const cutoff = auditSince(since).getTime();
  const key = (user: string, source: string, id: string) => JSON.stringify([user, source, id]);
  const identities = rows.map((row) => {
    const url = row.url ? parseWebUrl(row.url) : null;
    const id = url ? galleryIdOf(url) : null;
    return url && id ? { source: siteKey(url.hostname), id } : null;
  });
  // Include older rows when checking collisions. Both existing stored keys
  // and keys a later re-scrape would produce matter; always include the owner.
  const byKey = new Map<string, Set<number>>();
  const add = (k: string, index: number) => {
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k)!.add(index);
  };
  rows.forEach((row, i) => {
    add(key(row.user_id, row.source, row.source_id), i);
    const current = identities[i];
    if (current) add(key(row.user_id, current.source, current.id), i);
  });
  const mismatches = [];
  const unreadable = [];
  let inWindow = 0;
  for (const [i, row] of rows.entries()) {
    if (createdAt(row.created_at).getTime() < cutoff) continue;
    inWindow++;
    const current = identities[i];
    if (!current) {
      unreadable.push({ ...row, created_at: createdAt(row.created_at).toISOString(), reason: row.url ? "unrecognised_url" : "missing_url" });
    } else if (current.id !== row.source_id) {
      const collisions = [...(byKey.get(key(row.user_id, current.source, current.id)) ?? [])]
        .filter((other) => other !== i).map((other) => rows[other].hashtag).sort((a, b) => a - b);
      mismatches.push({ ...row, created_at: createdAt(row.created_at).toISOString(), current_source: current.source, current_id: current.id, collides_with: collisions });
    }
  }
  return { since: auditSince(since).toISOString(), scanned: rows.length, in_window: inWindow, mismatches, unreadable };
}
