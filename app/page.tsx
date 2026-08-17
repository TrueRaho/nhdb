import { Suspense } from "react";
import { connection } from "next/server";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import NhdbApp from "../components/NhdbApp";
import { queryTitles, getDataset } from "../lib/titles";
import { dbTitleToItem } from "../lib/mappers";

const PAGE_SIZE = 60;

async function CollectionLoader() {
  await connection();
  const [query, dataset] = await Promise.all([
    queryTitles({ limit: PAGE_SIZE, offset: 0, sortField: "added-at", sortDir: "desc" }),
    getDataset(),
  ]);
  const items = query.items.map(dbTitleToItem);
  return (
    <NhdbApp
      initialItems={items}
      initialTotal={query.total}
      dataset={dataset}
      pageSize={PAGE_SIZE}
    />
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
