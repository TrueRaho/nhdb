import { Suspense } from "react";
import { connection } from "next/server";
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
    <Suspense>
      <CollectionLoader />
    </Suspense>
  );
}
