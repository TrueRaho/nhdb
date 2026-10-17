"use server";

import { cookies } from "next/headers";
import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { NEON_AUTH_COOKIE_PREFIX } from "@neondatabase/auth/server";
import { auth } from "../../lib/auth/server";
import { SIGN_IN_PATH } from "../../lib/auth/paths";
import { requireUserId } from "../../lib/session";
import { prisma } from "../../lib/db";
import { deleteAccountData } from "../../lib/account-deletion";
import { datasetTag, similarAnyTag, similarTag, statsTag, titleTag, titlesListTag } from "../../lib/cache-tags";

export async function deleteAccountAction(confirmation: string): Promise<{ ok: false; error: string }> {
  const userId = await requireUserId();
  if (confirmation !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };

  let hashtags: number[];
  try {
    hashtags = await prisma.$transaction((tx) => deleteAccountData(tx, userId), { timeout: 30_000 });
  } catch {
    return { ok: false, error: "Could not delete your data. Try again." };
  }
  updateTag(titlesListTag(userId));
  updateTag(datasetTag(userId));
  updateTag(statsTag(userId));
  updateTag(similarAnyTag(userId));
  for (const hashtag of hashtags) {
    updateTag(titleTag(userId, hashtag));
    updateTag(similarTag(userId, hashtag));
  }

  let authDeleted = false;
  try {
    // Supported by @neondatabase/auth 0.5.0-beta. A verification email is
    // NOT confirmation that the user was deleted; inspect the actual result.
    const result = await auth.deleteUser({});
    authDeleted = !result.error && result.data?.success === true && result.data.message === "User deleted";
  } catch { /* Data is already committed; report the remaining login honestly. */ }
  try { await auth.signOut(); } catch { /* Always clear this browser below. */ }
  // Also expire local cached session cookies if Auth is unavailable. Remote
  // session revocation then remains unconfirmed; never leave this browser signed in.
  const jar = await cookies();
  for (const cookie of jar.getAll()) {
    if (cookie.name.startsWith(NEON_AUTH_COOKIE_PREFIX)) {
      // __Secure- cookies require Secure even on an expiry Set-Cookie.
      jar.set(cookie.name, "", { maxAge: 0, expires: new Date(0), path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    }
  }
  // Cookie writes re-render the calling page. Redirect here so that its auth
  // guard cannot replace our precise outcome with a generic sign-in redirect.
  redirect(`${SIGN_IN_PATH}?account=${authDeleted ? "deleted" : "data-deleted"}`);
}
