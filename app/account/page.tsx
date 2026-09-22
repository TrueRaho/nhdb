import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionUser, requireUserIdOrRedirect } from "../../lib/session";
import { listScraperEndpoints, SCRAPER_ENDPOINT_LIMIT } from "../../lib/scraper-endpoints";
import { secretStorageAvailable } from "../../lib/secret-box";
import { ScraperSettings } from "../../components/ScraperSettings";
import { SignOutButton } from "../../components/SignOutButton";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Separator } from "../../components/ui/separator";

export const metadata: Metadata = {
  title: "account · nhdb",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  // The session read is dynamic, so it resolves inside Suspense — the shell
  // around it stays prerenderable under cacheComponents.
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-16">
      <header className="flex items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> library
        </Link>
        <span className="flex-1" />
        <h1 className="font-display text-lg font-bold tracking-tight">account</h1>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">loading…</p>}>
        <AccountBody />
      </Suspense>
    </main>
  );
}

async function AccountBody() {
  const userId = await requireUserIdOrRedirect("/account");
  const [user, endpoints] = await Promise.all([getSessionUser(), listScraperEndpoints(userId)]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signed in</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{user?.email}</p>
            {user?.name && <p className="truncate text-sm text-muted-foreground">{user.name}</p>}
          </div>
          <SignOutButton />
        </CardContent>
      </Card>

      <Separator />

      <ScraperSettings
        initialEndpoints={endpoints}
        limit={SCRAPER_ENDPOINT_LIMIT}
        // Surfaced so a deployment missing SCRAPER_CRED_KEY explains itself in
        // the form rather than only when a save fails.
        secretStorageReady={secretStorageAvailable()}
      />
    </div>
  );
}
