export type ReadLog = {
  hashtag: number;
  readAt: string;
};

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

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
