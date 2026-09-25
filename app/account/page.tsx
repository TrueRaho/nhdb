import { Suspense } from "react";
import type { Metadata } from "next";
import { getSessionUser, requireUserIdOrRedirect } from "../../lib/session";
import { listScraperEndpoints, SCRAPER_ENDPOINT_LIMIT } from "../../lib/scraper-endpoints";
import { secretStorageAvailable } from "../../lib/secret-box";
import { AccountFrame, AccountSkeleton, AccountView } from "../../components/AccountView";

export const metadata: Metadata = {
  title: "account · nhdb",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  // The session read is dynamic, so it resolves inside Suspense — the shell
  // around it stays prerenderable under cacheComponents.
  return (
    <AccountFrame>
      <Suspense fallback={<AccountSkeleton />}>
        <AccountBody />
      </Suspense>
    </AccountFrame>
  );
}

async function AccountBody() {
  const userId = await requireUserIdOrRedirect("/account");
  const [user, endpoints] = await Promise.all([getSessionUser(), listScraperEndpoints(userId)]);

  return (
    <AccountView
      email={user?.email ?? ""}
      name={user?.name ?? ""}
      endpoints={endpoints}
      limit={SCRAPER_ENDPOINT_LIMIT}
      // Surfaced so a deployment missing SCRAPER_CRED_KEY explains itself in
      // the form rather than only when a save fails.
      secretStorageReady={secretStorageAvailable()}
    />
  );
}
