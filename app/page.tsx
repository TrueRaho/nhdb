import NhdbApp from "./components/NhdbApp";
import { listTitles } from "./lib/titles";
import { dbTitleToItem } from "./lib/mappers";

export default async function Home() {
  const titles = await listTitles();
  const items = titles.map(dbTitleToItem);
  return <NhdbApp initialItems={items} />;
}
