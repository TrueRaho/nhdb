import type { SourceId } from "../sources";
import type { SiteAdapter } from "./common";
import { ehentai } from "./ehentai";
import { hentaifox, imhentai } from "./galleryadults";
import { hentai2read } from "./hentai2read";
import { hitomi } from "./hitomi";
import { nhentai } from "./nhentai";
import { pururin } from "./pururin";

/** One adapter per supported site — adding a site is an entry here plus one in lib/sources.ts. */
export const ADAPTERS: Record<SourceId, SiteAdapter> = {
  nhentai,
  ehentai,
  hitomi,
  hentaifox,
  imhentai,
  pururin,
  hentai2read,
};
