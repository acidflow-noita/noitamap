#!/usr/bin/env node
/** Prepare native clue windows from the captured map tiles, never the full PNG. */
import sharp from "sharp";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

export async function readRegion(root, meta, rect) {
  const size = meta.tileSize,
    overlap = meta.overlap,
    left = Math.floor(rect.x - meta.originX),
    top = Math.floor(rect.y - meta.originY);
  const { width, height } = rect,
    layers = [];
  if (
    left < 0 ||
    top < 0 ||
    left + width > meta.width ||
    top + height > meta.height
  )
    throw Error("Clue is outside the captured main world.");
  for (
    let ty = Math.floor(top / size);
    ty <= Math.floor((top + height - 1) / size);
    ty++
  )
    for (
      let tx = Math.floor(left / size);
      tx <= Math.floor((left + width - 1) / size);
      tx++
    ) {
      const path = join(
          root,
          "map_files",
          String(meta.maxLevel),
          `${tx}_${ty}.webp`,
        ),
        tileX = tx * size - (tx > 0 ? overlap : 0),
        tileY = ty * size - (ty > 0 ? overlap : 0);
      const m = await sharp(path).metadata(),
        x = Math.max(left, tileX),
        y = Math.max(top, tileY),
        w = Math.min(left + width, tileX + m.width) - x,
        h = Math.min(top + height, tileY + m.height) - y;
      if (w > 0 && h > 0)
        layers.push({
          input: await sharp(path)
            .extract({ left: x - tileX, top: y - tileY, width: w, height: h })
            .png()
            .toBuffer(),
          left: x - left,
          top: y - top,
        });
    }
  return sharp({ create: { width, height, channels: 3, background: "#000" } })
    .composite(layers)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
export async function prepareClues(site = "task/guessr/site") {
  const root = resolve(site),
    mapRoot = join(root, "captured"),
    meta = JSON.parse(await readFile(join(mapRoot, "source.json"), "utf8"));
  const selection = JSON.parse(
    await readFile(
      new URL("./captured-locations.json", import.meta.url),
      "utf8",
    ),
  );
  const items = selection.locations;
  const previous = await readFile(join(root, "pack.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const sameSource =
    previous?.version?.startsWith(
      "captured-" + meta.sha256.slice(0, 12) + "-",
    ) &&
    previous.travelStep === 256 &&
    previous.bounds?.x === meta.originX &&
    previous.bounds?.y === meta.originY &&
    previous.bounds?.width === meta.width &&
    previous.bounds?.height === meta.height;
  const dir = join(root, "clues");
  await mkdir(dir, { recursive: true });
  sharp.cache({ memory: 64, files: 32, items: 64 });
  sharp.concurrency(2);
  const places = [];
  let written = 0;
  for (const p of items) {
    const cached =
      sameSource &&
      previous.places.find((old) => old.x === p.x && old.y === p.y);
    if (cached && Object.keys(cached.views ?? {}).length === 175) {
      const valid = Object.entries(cached.views).every(([key, frame]) => {
        const [dx, dy, level] = key.split(",").map(Number);
        return (
          [dx, dy, level].every(Number.isInteger) &&
          Math.abs(dx) <= 2 &&
          Math.abs(dy) <= 2 &&
          level >= 0 &&
          level <= 6 &&
          frame.width === 27 * 2 ** level &&
          frame.height === 12 * 2 ** level &&
          /^clues\/\d+\.webp$/.test(frame.image)
        );
      });
      const present =
        valid &&
        (
          await Promise.all(
            Object.values(cached.views).map((frame) =>
              stat(join(root, frame.image))
                .then((s) => s.size > 0)
                .catch(() => false),
            ),
          )
        ).every(Boolean);
      if (present) {
        places.push({
          ...p,
          image: cached.views["0,0,0"].image,
          views: cached.views,
        });
        console.log(`Reused ${places.length}/${items.length}: ${p.name}`);
        continue;
      }
    }
    // A bounded neighbourhood covers every prepared zoom and movement position.
    const extent = { x: p.x - 1376, y: p.y - 896, width: 2752, height: 1792 };
    const region = await readRegion(mapRoot, meta, extent),
      views = {};
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (let level = 0; level <= 6; level++) {
          const width = 27 * 2 ** level,
            height = 12 * 2 ** level,
            left = Math.floor(p.x + dx * 256 - width / 2 - extent.x),
            top = Math.floor(p.y + dy * 256 - height / 2 - extent.y);
          const bytes = await sharp(region.data, { raw: region.info })
            .extract({ left, top, width, height })
            .webp({ lossless: true, effort: 1 })
            .toBuffer();
          const id = BigInt(
              "0x" +
                createHash("sha256").update(bytes).digest("hex").slice(0, 16),
            ).toString(),
            file = `${id}.webp`;
          try {
            await stat(join(dir, file));
          } catch {
            await writeFile(join(dir, file), bytes);
            written++;
          }
          views[`${dx},${dy},${level}`] = {
            image: `clues/${file}`,
            width,
            height,
          };
        }
    const { fact, ...fields } = p;
    places.push({ ...fields, image: views["0,0,0"].image, views });
    console.log(`Prepared ${places.length}/${items.length}: ${p.name}`);
  }
  const pack = {
    version:
      "captured-" +
      meta.sha256.slice(0, 12) +
      "-" +
      createHash("sha256")
        .update(JSON.stringify(selection) + "|bounded-ninety-percent-camera-v1")
        .digest("hex")
        .slice(0, 8),
    seed: selection.seed,
    bounds: {
      x: meta.originX,
      y: meta.originY,
      width: meta.width,
      height: meta.height,
    },
    overview: "",
    map: {
      width: meta.width,
      height: meta.height,
      tileSize: meta.tileSize,
      overlap: meta.overlap,
      maxLevel: meta.maxLevel,
      tiles: "captured/map_files/",
    },
    demo: selection.demo,
    travelStep: 256,
    camera: {
      movement: "ninety-percent-view",
      boundary: "widest-origin-view",
      coordinateUnits: "native-pixels",
    },
    places,
  };
  await writeFile(join(root, "pack.json"), JSON.stringify(pack) + "\n");
  await writeFile(
    join(root, "_headers"),
    "/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n\n/clues/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  );
  console.log(
    `Prepared ${places.length} locations, ${written} new clue files, ${meta.tiles} reference tiles. No uploads.`,
  );
  return pack;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  await prepareClues(process.argv[2]);
