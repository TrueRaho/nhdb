// Mock collection data for nhdb. Generic placeholder titles + abstract gradients.

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
  palette: [string, string];
  tags: string[];
  artists: string[];
  groups: string[];
  parodies: string[];
  characters: string[];
  seed: number;
};

export const TAGS_POOL = [
  "romance", "comedy", "school-life", "fantasy", "sci-fi", "mystery",
  "slice-of-life", "drama", "action", "adventure", "historical", "horror",
  "psychological", "supernatural", "sports", "music", "cooking", "mecha",
  "vanilla", "fluffy", "long-hair", "glasses", "twintails", "short-hair",
  "uniform", "casual", "seasonal", "festival", "rainy", "sunset",
  "fullcolor", "monochrome", "screentone", "digital",
];

export const ARTIST_POOL = [
  "yrnkj-ulxpuh", "buzr-zekulu", "egkn-tscsbfv", "xee-uvokpogg",
  "mxbav-utiba", "mup-tyzy", "nxrwav-bctmxq", "mmj-lmclfuka",
  "aplfquc-srxjl", "lmo-heuvpsc", "asfivgf-mgjsjs", "pvhz-xwjdtnko",
];

export const GROUP_POOL = [
  "sljpcw-njedwcylo", "cffog-itcbq", "ppyyyznx-jlz", "zouna-wksynm",
  "ibhkzh-morfy", "ferdxyoz-rcyu",
];

export const PARODY_POOL = [
  "original", "kscmffk-lupvfl", "fezckwjct-tasuqlr", "psphvjc-qsrp",
  "dpeojl-vkrwhbd", "cadactz-ngbnwjn", "zouna-yzga", "vngb-zujach",
];

export const CHARACTER_POOL = [
  "chl", "ksmf", "wfsj", "kira", "lbf", "dets", "ubuy", "lfw", "ggvy", "ahz",
  "xmgj", "tca", "lde", "dzb", "mup", "fko",
];

export const PALETTES: [string, string][] = [
  ["#ff2d87", "#5b1a8a"],
  ["#ff5470", "#1a1a3e"],
  ["#a259ff", "#1a0a2e"],
  ["#ff8a3d", "#3a0e2e"],
  ["#00d4ff", "#0a1f4a"],
  ["#ff2d87", "#0a0a1a"],
  ["#ec4899", "#3b0a4a"],
  ["#f472b6", "#1e1b4b"],
  ["#fb7185", "#0f172a"],
  ["#c084fc", "#1e1b4b"],
  ["#7c3aed", "#0c0a1a"],
  ["#06b6d4", "#0c1a2e"],
];

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

export function generateCollection(count = 32): Item[] {
  const items: Item[] = [];
  const titleNames = [
    "Quiet Hours", "Paper Moon", "After School", "Summer Static",
    "Velvet Circuit", "Crimson Rail", "Eclipse Hours", "Starbound",
    "Last Bus Home", "Midnight Library", "Tape Room", "Window Seat",
    "Slow Train", "Soda Pop", "Rooftop Notes", "Letter Day",
    "Folding Light", "Indigo Field", "Marker", "Postcard",
    "Late Reply", "Open Window", "Tide Pool", "Studio Hours",
    "Print Run", "Galley Proof", "Headphones", "Linework",
    "Margin Notes", "Drafting Table", "Cup of Tea", "Sketchbook",
  ];
  for (let i = 0; i < count; i++) {
    const seed = 4242 + i * 17;
    const rng = mulberry32(seed);
    const hashtag = 100000 + Math.floor(rng() * 800000);
    const pages = 8 + Math.floor(rng() * 220);
    const readCount = Math.floor(rng() * 14);
    const daysAgoAdded = Math.floor(rng() * 540);
    const daysAgoRead = readCount > 0 ? Math.floor(rng() * daysAgoAdded) : null;
    const daysAgoUploaded = daysAgoAdded + Math.floor(rng() * 800);
    const palette = PALETTES[i % PALETTES.length];
    const tagCount = 6 + Math.floor(rng() * 6);
    const tags = pick(rng, TAGS_POOL, tagCount);
    const artists = pick(rng, ARTIST_POOL, 1 + Math.floor(rng() * 2));
    const groups = rng() > 0.5 ? pick(rng, GROUP_POOL, 1) : [];
    const parodies = pick(rng, PARODY_POOL, 1);
    const characters = pick(rng, CHARACTER_POOL, 1 + Math.floor(rng() * 4));
    const title = titleNames[i % titleNames.length];
    const altTitle = `${title} — vol. ${1 + (i % 4)}`;
    items.push({
      hashtag, titleName: title, alterName: altTitle, imageLink: "", pages,
      uploadedAt: daysAgoUploaded, addedAt: daysAgoAdded,
      readCount, lastReadAt: daysAgoRead, palette,
      tags, artists, groups, parodies, characters, seed,
    });
  }
  return items;
}
