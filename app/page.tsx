import NhdbApp from "../components/NhdbApp";
import { listTitles, getReadLogs } from "../lib/titles";
import { dbTitleToItem } from "../lib/mappers";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [titles, logs] = await Promise.all([listTitles(), getReadLogs()]);
  const items = titles.map(dbTitleToItem);
  const readLogs = logs.map((l: { hashtag: number; readAt: Date }) => ({ hashtag: l.hashtag, readAt: l.readAt.toISOString() }));
  return <NhdbApp initialItems={items} initialReadLogs={readLogs} />;
}
