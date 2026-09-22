"use server";

import { requireUserId } from "../../lib/session";
import {
  listScraperEndpoints,
  replaceScraperEndpoints,
  ScraperConfigError,
  SCRAPER_ENDPOINT_LIMIT,
  type ScraperEndpointInput,
  type ScraperEndpointView,
} from "../../lib/scraper-endpoints";

export type SaveEndpointsResult =
  | { ok: true; endpoints: ScraperEndpointView[] }
  | { ok: false; error: string };

/**
 * Replace the caller's scraper host list.
 *
 * Like every action here, the owner comes from the session — the rows carry no
 * user id and could not be trusted if they did. The whole list arrives at once
 * because that is how it is stored (see lib/scraper-endpoints.ts).
 *
 * Validation errors come back as a value rather than a thrown error: a typo in
 * a URL is an expected outcome of a settings form, and the screen needs to show
 * it next to the field rather than as a crashed action.
 */
export async function saveScraperEndpointsAction(rows: ScraperEndpointInput[]): Promise<SaveEndpointsResult> {
  const userId = await requireUserId();

  if (!Array.isArray(rows)) return { ok: false, error: "Invalid request" };
  if (rows.length > SCRAPER_ENDPOINT_LIMIT) {
    return { ok: false, error: `At most ${SCRAPER_ENDPOINT_LIMIT} scraper hosts` };
  }
  // Re-checked here rather than trusted from the client: this is a public POST
  // endpoint, and `secret` in particular is three-valued (string / "" / null)
  // with very different meanings, so a wrong type must not reach the DAL.
  for (const row of rows) {
    if (!row || typeof row !== "object") return { ok: false, error: "Invalid request" };
    if (typeof row.url !== "string") return { ok: false, error: "Invalid request" };
    if (row.label !== undefined && typeof row.label !== "string") return { ok: false, error: "Invalid request" };
    if (row.secret !== null && typeof row.secret !== "string") return { ok: false, error: "Invalid request" };
  }

  try {
    await replaceScraperEndpoints(userId, rows);
  } catch (e) {
    if (e instanceof ScraperConfigError) return { ok: false, error: e.message };
    console.error("saving scraper endpoints failed:", e);
    return { ok: false, error: "Could not save. Try again." };
  }
  // Read back rather than echoing the input: the stored form is normalised
  // (trailing slashes dropped, labels trimmed) and hasSecret is derived.
  return { ok: true, endpoints: await listScraperEndpoints(userId) };
}
