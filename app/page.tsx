import { Suspense } from "react";
import { requireUserIdOrRedirect, getSessionUser } from "../lib/session";
import { AccountControls } from "../components/AccountControls";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import NhdbApp from "../components/NhdbApp";
import { queryTitles, getDataset } from "../lib/titles";
import { dbTitleToItem } from "../lib/mappers";

const PAGE_SIZE = 60;

async function CollectionLoader() {
  const userId = await requireUserIdOrRedirect();
  const user = await getSessionUser();
  const [query, dataset] = await Promise.all([
    queryTitles(userId, { limit: PAGE_SIZE, offset: 0, sortField: "added-at", sortDir: "desc" }),
    getDataset(userId),
  ]);
  const items = query.items.map(dbTitleToItem);
  return (
    <>
    <AccountControls userId={userId} email={user?.email ?? ""} />
    <NhdbApp
      key={userId}
      userId={userId}
      initialItems={items}
      initialTotal={query.total}
      dataset={dataset}
      pageSize={PAGE_SIZE}
    />
    </>
  );
}

export default function Home() {
  return (
    <>
      <Suspense>
        <CollectionLoader />
      </Suspense>
      {/* Mounted here rather than in the root layout so /add/<id> — the
          share-sheet screen, whose whole point is opening instantly — ships
          neither script. */}
      <SpeedInsights />
      <Analytics />
    </>
  );
}
