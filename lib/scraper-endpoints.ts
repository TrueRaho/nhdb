// A user's own scraper hosts: read, validate, store.
//
// The database is shared but the scraper is not — everyone brings their own, in
// priority order, the way the single owner used to have an ngrok box first and
// a Render container behind it.
//
// Deliberately uncached. It is one small indexed read on a path that is about
// to spend hundreds of milliseconds on the network, and a settings screen whose
// save does not take effect immediately is worse than useless.

import "server-only";
import { prisma } from "./db";
import { open, seal, SecretBoxError } from "./secret-box";
import { normalizeScraperUrl, UnsafeUrlError } from "./net-guard";

/** Matches the CHECK constraint in migration 8 — keep the two in step. */
export const SCRAPER_ENDPOINT_LIMIT = 8;
export const MAX_LABEL_LENGTH = 64;

/** What the settings screen is allowed to see: never a secret, only whether one is set. */
export type ScraperEndpointView = {
  position: number;
  label: string;
  url: string;
  hasSecret: boolean;
};

/**
 * One row as submitted by the form.
 *
 * `secret` is three-valued on purpose, the same way alterName is elsewhere in
 * this app: a string sets it, `""` clears it, and `null` means "leave whatever
 * is stored alone" — so the form can show that a secret exists without ever
 * sending it to the browser and receiving it back.
 */
export type ScraperEndpointInput = {
  label?: string;
  url: string;
  secret: string | null;
};

/** A target the scrape route can actually call. */
export type ScraperTarget = {
  url: string;
  /** Decrypted bearer token, or null when the endpoint is called unauthenticated. */
  secret: string | null;
  label: string;
};

export class ScraperConfigError extends Error {
  name = "ValidationError"; // mapped to HTTP 400 by the same check the scrape route uses
}

export async function listScraperEndpoints(userId: string): Promise<ScraperEndpointView[]> {
  const rows = await prisma.scraperEndpoint.findMany({
    where: { userId },
    orderBy: { position: "asc" },
    select: { position: true, label: true, url: true, secretEnc: true },
  });
  return rows.map((r) => ({
    position: r.position,
    label: r.label ?? "",
    url: r.url,
    hasSecret: r.secretEnc !== null,
  }));
}

/**
 * Replace a user's entire endpoint list, in one transaction.
 *
 * Whole-list rewrite rather than per-row patching: `position` is half the
 * primary key, so reordering rows individually needs a temporary shuffle to
 * dodge unique conflicts, and the list is a handful of rows from one form.
 *
 * A row that asks to keep its secret inherits it from the previous row with the
 * SAME URL — the url is what a credential actually belongs to, so moving a row
 * up the list keeps its token while repointing it at a different host correctly
 * does not.
 */
export async function replaceScraperEndpoints(userId: string, inputs: ScraperEndpointInput[]): Promise<void> {
  if (inputs.length > SCRAPER_ENDPOINT_LIMIT) {
    throw new ScraperConfigError(`At most ${SCRAPER_ENDPOINT_LIMIT} scraper hosts`);
  }

  const existing = await prisma.scraperEndpoint.findMany({
    where: { userId },
    select: { url: true, secretEnc: true },
  });
  const secretByUrl = new Map(existing.map((r) => [r.url, r.secretEnc]));

  const seen = new Set<string>();
  const rows = inputs.map((input, index) => {
    let url: string;
    try {
      url = normalizeScraperUrl(input.url);
    } catch (cause) {
      const detail = cause instanceof UnsafeUrlError ? cause.message : "Invalid URL";
      throw new ScraperConfigError(`Host ${index + 1}: ${detail}`);
    }
    if (seen.has(url)) throw new ScraperConfigError(`Host ${index + 1}: ${url} is listed twice`);
    seen.add(url);

    const label = (input.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);

    let secretEnc: string | null;
    if (input.secret === null) {
      secretEnc = secretByUrl.get(url) ?? null; // keep what this host already had
    } else if (input.secret === "") {
      secretEnc = null;
    } else {
      try {
        secretEnc = seal(input.secret);
      } catch (cause) {
        throw new ScraperConfigError(
          cause instanceof SecretBoxError ? cause.message : "Could not store the secret",
        );
      }
    }
    return { userId, position: index, label: label || null, url, secretEnc };
  });

  await prisma.$transaction(async (tx) => {
    await tx.scraperEndpoint.deleteMany({ where: { userId } });
    if (rows.length) await tx.scraperEndpoint.createMany({ data: rows });
  });
}

/**
 * The hosts the scrape route should try, best first.
 *
 * An endpoint whose stored secret will not decrypt (key rotated, row tampered
 * with) is DROPPED rather than called without a credential: sending no
 * Authorization to a scraper that expects one merely fails, but silently
 * downgrading a credentialed call is the kind of fallback that becomes a hole.
 * The reason is logged so the user can see why a host went quiet.
 */
export async function resolveScraperTargets(userId: string): Promise<ScraperTarget[]> {
  const rows = await prisma.scraperEndpoint.findMany({
    where: { userId },
    orderBy: { position: "asc" },
    select: { position: true, label: true, url: true, secretEnc: true },
  });

  const targets: ScraperTarget[] = [];
  for (const row of rows) {
    let secret: string | null = null;
    if (row.secretEnc !== null) {
      try {
        secret = open(row.secretEnc);
      } catch {
        console.error(`scraper endpoint ${row.position} for a user has an unreadable secret — skipping it`);
        continue;
      }
    }
    targets.push({ url: row.url, secret, label: row.label ?? row.url });
  }
  return targets;
}
