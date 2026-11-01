#!/usr/bin/env node
/** Offline preparation only. Copies exact pixels from the existing captured map.
 * No browser generation, image AI, original game edits, or remote publication. */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const output = resolve("public/guessr/practice");
const cache = resolve("task/guessr/tile-cache");
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const sources = JSON.parse(await readFile("src/data/tilesources.json", "utf8"));
const source = sources["regular-main-branch"][0];
const image = JSON.parse(source.dziContent).Image;
const max = Math.ceil(
  Math.log2(Math.max(Number(image.Size.Width), Number(image.Size.Height))),
);
const origin = { x: Number(image.TopLeft.X), y: Number(image.TopLeft.Y) };
const root = source.url.replace(/\.dzi$/, "_files/");
const bounds = { x: -17920, y: -6144, width: 36352, height: 26112 };
const locations = [
  [
    "At the mountain",
    0,
    -180,
    "Forest",
    "surface",
    "The entrance to the Mines sits underneath the mountain.",
  ],
  [
    "The great tree",
    -1664,
    -700,
    "Forest",
    "surface",
    "The tree towers above the western edge of the forest.",
  ],
  [
    "Water cave",
    -1792,
    768,
    "Water Cave",
    "secrets",
    "The water cave is west of the Mines, below the tree.",
  ],
  [
    "Pyramid summit",
    10050,
    -900,
    "Desert",
    "surface",
    "The pyramid is one of the landmarks east of the mountain.",
  ],
  [
    "Inside the pyramid",
    10240,
    100,
    "Pyramid",
    "surface",
    "The pyramid has more to discover than its surface suggests.",
  ],
  [
    "By the lake",
    -13200,
    200,
    "Lake",
    "surface",
    "The lake lies beyond the snowy surface to the west.",
  ],
  [
    "Desert watchtower",
    13900,
    -700,
    "Desert",
    "surface",
    "Look up as well as down when exploring the desert.",
  ],
  [
    "The Mines",
    700,
    700,
    "Mines",
    "caverns",
    "The first level has many routes, but the mountain gives you a starting point.",
  ],
  [
    "Collapsed passages",
    -1500,
    600,
    "Collapsed Mines",
    "caverns",
    "The collapsed mines extend west of the main Mines.",
  ],
  [
    "Western passages",
    -3400,
    650,
    "Western caves",
    "secrets",
    "Side passages reward exploring beyond the main descent.",
  ],
  [
    "Coal Pits",
    -600,
    2200,
    "Coal Pits",
    "caverns",
    "The Coal Pits sit below the first Holy Mountain.",
  ],
  [
    "Fungal Caverns",
    -2800,
    2300,
    "Fungal Caverns",
    "caverns",
    "Fungal terrain is found west of the Coal Pits.",
  ],
  [
    "First Holy Mountain",
    -300,
    1590,
    "Holy Mountain",
    "secrets",
    "Holy Mountains divide the main descent into levels.",
  ],
  [
    "Lava lake",
    2600,
    1100,
    "Lava Lake",
    "secrets",
    "The lava lake is east of the Mines.",
  ],
  [
    "Across the chasm",
    3600,
    1300,
    "Chasm",
    "secrets",
    "The eastern chasm separates the Mines from another route.",
  ],
  [
    "Snowy Depths",
    -1700,
    4000,
    "Snowy Depths",
    "caverns",
    "Open snowy caverns follow the Coal Pits.",
  ],
  [
    "Buried temple",
    -4400,
    3600,
    "Magical Temple",
    "secrets",
    "A temple is hidden west of the Snowy Depths.",
  ],
  [
    "Hiisi Base",
    -500,
    5700,
    "Hiisi Base",
    "caverns",
    "Metal corridors distinguish Hiisi Base from the caverns above it.",
  ],
  [
    "Jungle canopy",
    -500,
    7500,
    "Underground Jungle",
    "caverns",
    "Dense jungle lies beneath Hiisi Base.",
  ],
  [
    "Lukki territory",
    -3700,
    7700,
    "Lukki Lair",
    "caverns",
    "Lukki territory stretches west of the jungle.",
  ],
  [
    "Overgrown caverns",
    14000,
    3400,
    "Overgrown Cavern",
    "caverns",
    "The overgrown caverns occupy a large area to the east.",
  ],
  [
    "The Vault",
    100,
    9500,
    "The Vault",
    "caverns",
    "The Vault follows the jungle on the main route down.",
  ],
  [
    "Frozen machinery",
    -10240,
    1792,
    "Frozen Vault",
    "caverns",
    "Frozen machinery can be found far to the west.",
  ],
  [
    "Temple of the Art",
    400,
    11700,
    "Temple of the Art",
    "caverns",
    "The Temple of the Art is near the bottom of the main descent.",
  ],
  [
    "Wizard territory",
    10000,
    13500,
    "Wizards’ Den",
    "caverns",
    "The Wizards’ Den lies east of the Temple of the Art.",
  ],
  [
    "Deep laboratory",
    3556,
    13026,
    "Laboratory",
    "secrets",
    "The laboratory is below the Temple of the Art.",
  ],
  [
    "The Tower",
    9900,
    7400,
    "The Tower",
    "secrets",
    "The Tower is a separate ascent reached through a portal.",
  ],
  [
    "Golden secret",
    15000,
    -3300,
    "Gold",
    "secrets",
    "Some of the richest places lie far from the main path.",
  ],
  [
    "Cloud ruins",
    7350,
    -4600,
    "Sky temples",
    "surface",
    "The surface is not the highest place worth exploring.",
  ],
  [
    "Deep below",
    0,
    16000,
    "Deep caverns",
    "caverns",
    "The world continues beneath the usual end of a run.",
  ],
];
const pending = new Map();
async function tile(level, x, y) {
  const key = `${level}-${x}-${y}`;
  if (!pending.has(key))
    pending.set(
      key,
      (async () => {
        const path = join(cache, key + ".webp");
        try {
          return await readFile(path);
        } catch {}
        const response = await fetch(`${root}${level}/${x}_${y}.webp`, {
          signal: AbortSignal.timeout(25000),
        });
        if (!response.ok)
          throw Error(`Map tile ${key}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(path, bytes);
        return bytes;
      })(),
    );
  return pending.get(key);
}
async function crop(rect, level = max) {
  const scale = 2 ** (max - level),
    size = Number(image.TileSize),
    overlap = Number(image.Overlap);
  const left = Math.floor((rect.x - origin.x) / scale),
    top = Math.floor((rect.y - origin.y) / scale);
  const width = Math.round(rect.width / scale),
    height = Math.round(rect.height / scale);
  const layers = [];
  for (
    let ty = Math.floor(top / size);
    ty <= Math.floor((top + height - 1) / size);
    ty++
  ) {
    for (
      let tx = Math.floor(left / size);
      tx <= Math.floor((left + width - 1) / size);
      tx++
    ) {
      const data = await tile(level, tx, ty);
      const tileX = tx * size - (tx > 0 ? overlap : 0),
        tileY = ty * size - (ty > 0 ? overlap : 0);
      const meta = await sharp(data).metadata();
      const x = Math.max(left, tileX),
        y = Math.max(top, tileY);
      const w = Math.min(left + width, tileX + meta.width) - x,
        h = Math.min(top + height, tileY + meta.height) - y;
      if (w > 0 && h > 0)
        layers.push({
          input: await sharp(data)
            .extract({ left: x - tileX, top: y - tileY, width: w, height: h })
            .toBuffer(),
          left: x - left,
          top: y - top,
        });
    }
  }
  return sharp({
    create: { width, height, channels: 3, background: "#080c10" },
  })
    .composite(layers)
    .webp({ lossless: true })
    .toBuffer();
}
const places = [];
for (let i = 0; i < locations.length; i++) {
  const [name, x, y, biome, theme, fact] = locations[i];
  const id = "p-" + String(i + 1).padStart(2, "0");
  const bytes = await crop({
    x: x - 512,
    y: y - 384,
    width: 1024,
    height: 768,
  });
  const filename =
    id +
    "-" +
    createHash("sha256").update(bytes).digest("hex").slice(0, 10) +
    ".webp";
  await writeFile(join(output, filename), bytes);
  places.push({
    id,
    name,
    x,
    y,
    biome,
    theme,
    fact,
    image: `/guessr/practice/${filename}`,
  });
  console.log(
    `Prepared practice location ${i + 1}/${locations.length}: ${name}`,
  );
}
const board = await crop(bounds, max - 6);
await writeFile(join(output, "overview.webp"), board);
await writeFile(
  join(output, "pack.json"),
  JSON.stringify(
    {
      version: "capture-78633191-v1",
      seed: 78633191,
      bounds,
      overview: "/guessr/practice/overview.webp",
      places,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Practice pack ready: ${places.length} locations. No remote changes.`,
);
