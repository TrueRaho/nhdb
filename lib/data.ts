// Client-facing shape of a title, produced by lib/mappers.ts from DB rows.
export type Item = {
  hashtag: number;
  titleName: string;
  alterName: string;
  imageLink: string;
  pages: number;
  uploadedAt: number;
  addedAt: number;
  readCount: number;
  lastReadAt: number | null;
  tags: string[];
  artists: string[];
  groups: string[];
  parodies: string[];
  characters: string[];
};
