#!/usr/bin/env node
/** Build an offline review index from actual captured-map crops, with pixel checks. */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { readRegion } from "./prepare-clues.mjs";
import { build } from "esbuild";

const site = resolve(process.argv[2] || "task/guessr/site");
const out = resolve(process.argv[3] || "task/guessr/dataset");
const pack = JSON.parse(await readFile(join(site, "pack.json"), "utf8"));
const meta = JSON.parse(
  await readFile(join(site, "captured/source.json"), "utf8"),
);
const travelStyles = await readFile(
  new URL("../../src/guessr/travel-controls.css", import.meta.url),
  "utf8",
);
await mkdir(out, { recursive: true });
sharp.concurrency(2);
sharp.cache({ memory: 32, files: 16, items: 32 });
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const asset = (path) => relative(out, join(site, path)).split("\\").join("/");
const checkedFiles = new Map(),
  locations = [];
let checkedViews = 0;
const started = Date.now();

for (const place of pack.places) {
  const extent = {
    x: place.x - 1376,
    y: place.y - 896,
    width: 2752,
    height: 1792,
  };
  const region = await readRegion(join(site, "captured"), meta, extent);
  if (Object.keys(place.views).length !== 175)
    throw Error(`${place.id}: expected 175 views`);
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      for (let level = 0; level <= 6; level++) {
        const key = `${dx},${dy},${level}`,
          frame = place.views[key];
        const width = 27 * 2 ** level,
          height = 12 * 2 ** level;
        if (!frame || frame.width !== width || frame.height !== height)
          throw Error(`${place.id}/${key}: incorrect dimensions`);
        const filename = join(site, frame.image),
          bytes = await readFile(filename);
        if (!checkedFiles.has(filename)) {
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (
            !frame.image.endsWith(`/${BigInt("0x" + digest.slice(0, 16))}.webp`)
          )
            throw Error(`${filename}: content name mismatch`);
          checkedFiles.set(filename, { bytes: bytes.length, sha256: digest });
        }
        const decoded = await sharp(bytes)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (
          decoded.info.width !== width ||
          decoded.info.height !== height ||
          decoded.info.channels !== 3
        )
          throw Error(`${place.id}/${key}: decoded size mismatch`);
        const left = Math.floor(
          place.x + dx * pack.travelStep - width / 2 - extent.x,
        );
        const top = Math.floor(
          place.y + dy * pack.travelStep - height / 2 - extent.y,
        );
        for (let row = 0; row < height; row++) {
          const sourceOffset = ((top + row) * extent.width + left) * 3,
            cropOffset = row * width * 3;
          if (
            !region.data
              .subarray(sourceOffset, sourceOffset + width * 3)
              .equals(decoded.data.subarray(cropOffset, cropOffset + width * 3))
          ) {
            throw Error(`${place.id}/${key}: RGB mismatch on row ${row}`);
          }
        }
        checkedViews++;
      }
  locations.push({
    id: place.id,
    name: place.name,
    biome: place.biome,
    hard: !!place.hard,
    x: place.x,
    y: place.y,
    // Candidate labels are for review; they do not imply pixel uniqueness or difficulty guarantees.
    reviewStatus: "candidate",
    views: Object.fromEntries(
      Object.entries(place.views).map(([key, frame]) => [
        key,
        { ...frame, image: asset(frame.image) },
      ]),
    ),
  });
  console.log(
    `Verified ${locations.length}/${pack.places.length}: ${place.id} (${checkedViews} views)`,
  );
}

const csv = [
  [
    "id",
    "name",
    "biome",
    "world_x",
    "world_y",
    "hard_candidate",
    "initial_image",
    "wide_image",
  ],
  ...locations.map((p) => [
    p.id,
    p.name,
    p.biome,
    p.x,
    p.y,
    p.hard,
    p.views["0,0,0"].image,
    p.views["0,0,6"].image,
  ]),
];
await writeFile(
  join(out, "locations.csv"),
  csv
    .map((row) =>
      row.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(","),
    )
    .join("\n") + "\n",
);
await writeFile(
  join(out, "locations.json"),
  JSON.stringify(
    {
      source: "../full_map.png",
      sha256: meta.sha256,
      bounds: pack.bounds,
      travelStep: pack.travelStep,
      locations,
    },
    null,
    2,
  ) + "\n",
);

for (const [name, level] of [
  ["starting-clues", 0],
  ["wider-context", 6],
]) {
  const columns = 5,
    cellWidth = 360,
    cellHeight = 220;
  const width = columns * cellWidth,
    height = Math.ceil(locations.length / columns) * cellHeight + 50;
  const layers = [];
  const labels = [
    `<text x="16" y="30" font-size="20">${level ? "Wider context: 1728 x 768 native pixels" : "Starting clues: 27 x 12 native pixels, enlarged without smoothing"}</text>`,
  ];
  for (const [i, p] of locations.entries()) {
    const x = (i % columns) * cellWidth,
      y = Math.floor(i / columns) * cellHeight + 50;
    const frame = p.views[`0,0,${level}`];
    layers.push({
      input: await sharp(resolve(out, frame.image))
        .resize(324, 144, { kernel: sharp.kernel.nearest })
        .png()
        .toBuffer(),
      left: x + 16,
      top: y + 54,
    });
    labels.push(
      `<text x="${x + 16}" y="${y + 20}" font-size="15">${escape(p.id + " · " + p.name)}</text>`,
    );
    labels.push(
      `<text x="${x + 16}" y="${y + 40}" font-size="12" fill="#94a3b8">${p.x}, ${p.y}${p.hard ? " · hard candidate" : ""}</text>`,
    );
  }
  layers.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="#e2e8f0" font-family="DejaVu Sans, sans-serif">${labels.join("")}</g></svg>`,
    ),
    left: 0,
    top: 0,
  });
  await sharp({ create: { width, height, channels: 3, background: "#0f172a" } })
    .composite(layers)
    .png()
    .toFile(join(out, `${name}.png`));
}

const embedded = JSON.stringify(locations).replaceAll("<", "\\u003c");
const viewer = await build({
  entryPoints: [resolve("src/guessr/dataset-review.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Captured map dataset</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#020617;color:#e2e8f0}body{margin:0;padding:20px}h1{font-size:22px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5}a{color:#93c5fd}button,select{font:inherit;color:inherit;background:#1e293b;border:1px solid #475569;border-radius:5px;padding:7px 10px}button:disabled{opacity:.4}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:20px}nav{display:grid;align-content:start;gap:5px;max-height:80vh;overflow:auto}nav button{text-align:left}nav button[aria-current=true]{border-color:#93c5fd}.panels{display:grid;grid-template-columns:1fr 1fr;gap:15px}.frame{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px}.frame img{display:block;width:100%;aspect-ratio:27/12;object-fit:fill;image-rendering:pixelated;background:#000}.controls{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.view-info{min-height:22px}small{color:#94a3b8}footer{margin-top:20px} @media(max-width:800px){.layout,.panels{grid-template-columns:1fr}nav{max-height:180px}}
${travelStyles}
.camera-controls{margin:12px 0}
.camera-frame{position:relative;aspect-ratio:27/12;overflow:hidden;background:#000}.camera-frame canvas{display:block;width:100%;height:100%;image-rendering:pixelated}.context-frame{position:relative}.context-frame svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}#error{color:#fca5a5}
</style>
<h1>Captured map dataset</h1><p>Actual crops from full_map.png. ${locations.length} candidate locations, seven zoom sizes and overlapping travel views. Each arrow moves 90% of the visible width or height. Exploration stays inside the widest image; movement is disabled when fully zoomed out. This is an offline review page, not the game. Names and difficulty are candidate labels.</p>
<p><a href="starting-clues.png">Starting-clue contact sheet</a> · <a href="wider-context.png">Wider-context contact sheet</a> · <a href="locations.csv">CSV index</a></p>
<div class="layout"><nav aria-label="Locations"></nav><main><h2 id="name"></h2><p id="coords"></p><div class="panels"><section class="frame"><p>Selected view</p><div id="camera" class="camera-frame"></div><p class="view-info" id="info"></p><div class="camera-controls"><div class="camera-zoom" role="group" aria-label="Zoom and reset"><button id="zin" aria-label="Zoom in"></button><button id="zout" aria-label="Zoom out"></button><button id="reset" aria-label="Return to start"></button></div><div class="travel-pad" id="travel" role="group" aria-label="Travel"></div></div><p id="error" role="status"></p><div id="original"></div></section><section class="frame"><p>Widest context around the starting point</p><div class="context-frame"><img id="context" alt="Wide context crop"><svg viewBox="-864 -384 1728 768" aria-label="Current view on the wider image"><rect id="camera-box" fill="none" stroke="#93c5fd" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="M -12 0 H 12 M 0 -12 V 12" fill="none" stroke="#e2e8f0" stroke-width="1" vector-effect="non-scaling-stroke"/></svg></div><p>Preview only: the outline shows your current view. This context panel is not part of the game.</p></section></div><footer><small>Review previews use nearest-neighbour scaling. Downloaded source crops are native-size lossless images. No server, login or network connection is needed.</small></footer></main></div>
<script type="application/json" id="dataset-data">${embedded}</script>
<script>${viewer.outputFiles[0].text}</script></html>`;
await writeFile(join(out, "index.html"), html);
const summary = {
  packVersion: pack.version,
  source: "../full_map.png",
  sourceSha256: meta.sha256,
  sourceWidth: meta.width,
  sourceHeight: meta.height,
  locations: locations.length,
  zoomSizes: Array.from({ length: 7 }, (_, i) => [27 * 2 ** i, 12 * 2 ** i]),
  travelPositionsPerLocation: 25,
  travelStep: pack.travelStep,
  checkedViews,
  uniqueImages: checkedFiles.size,
  clueBytes: [...checkedFiles.values()].reduce((n, f) => n + f.bytes, 0),
  nativeTileRgbMatches: checkedViews,
  referenceTiles: meta.tiles,
  elapsedMs: Date.now() - started,
  scope:
    "Every clue view decoded and compared to native captured-map tiles; direct PNG checks recorded separately. Candidate selection/difficulty still needs visual review.",
};
await writeFile(
  join(out, "validation.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
await writeFile(
  join(out, "README.txt"),
  `NOITAGUESSR IMAGE DATASET\n\nOpen index.html in a browser. It works offline; no dev server is needed.\n\nSource: ../full_map.png (${meta.width} x ${meta.height}, unchanged).\nImages: ../site/clues/ (numeric filenames, lossless WebP).\nGame manifest: ../site/pack.json\nReference-map tiles: ../site/captured/map_files/\n\n${locations.length} candidate locations x 25 travel positions x 7 sizes = ${checkedViews} views.\n${checkedFiles.size} unique image files; identical crops share one file.\nSizes: 27x12, 54x24, 108x48, 216x96, 432x192, 864x384, 1728x768.\nPrepared source positions: -2..2 in each direction, spaced ${pack.travelStep} pixels apart.\nCamera movement: 90% of visible width/height, rounded to native pixels, leaving about 10% overlap.\nExploration is bounded by the widest starting image. All arrows are disabled when fully zoomed out.\nZooming out near an edge clamps the view inside that boundary without a travel penalty.\n\nstarting-clues.png: all initial crops enlarged without smoothing.\nwider-context.png: the widest crop for each candidate.\nlocations.csv / locations.json: coordinates and image index.\nvalidation.json: every view compared against the native tile pixels.\n\nThis is a first reviewable candidate dataset, not a final difficulty-balanced pool.\nIt is taken from the supplied PNG, not downloaded terrain or generated Noita terrain.\nNo source PNG changes, uploads, commits or deployment.\n`,
);
console.log(JSON.stringify(summary));
