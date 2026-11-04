/** Offline private data packaging. Does not copy, crop, or generate images. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateOutput } from "./private-output.mjs";
import { prepareAreaStarts } from "../../src/guessr/starting-view.ts";
import type { AreaDefinition } from "../../src/guessr/area-rules.ts";
import type { PrivateImageSet } from "../../src/guessr/image-game-server.ts";
import {
  preparedGameConfig,
  type PreparedGameCatalog,
} from "../../src/guessr/prepared-rounds.ts";

async function write(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareWorkerData(
  options: {
    indexPath?: string;
    inventoryPath?: string;
    outputDirectory?: string;
    publicConfigPath?: string;
    referenceRoot?: string;
    onProgress?: () => void;
  } = {},
) {
  const [index, inventory] = (await Promise.all([
    readFile(
      options.indexPath ?? "task/guessr/private/image-set.json",
      "utf8",
    ).then(JSON.parse),
    readFile(
      options.inventoryPath ?? "task/guessr/area-inventory/inventory.json",
      "utf8",
    ).then(JSON.parse),
  ])) as [
    PrivateImageSet,
    { capture: { sha256: string }; puzzleAreas: AreaDefinition[] },
  ];
  if (index.capture.sha256 !== inventory.capture.sha256)
    throw new Error("Area masks and images must use the same captured map.");
  const output = privateOutput(
    resolve(options.outputDirectory ?? "task/guessr/private/worker-assets"),
  );
  const c = index.capture;
  const capture = {
    originX: c.originX,
    originY: c.originY,
    width: c.width,
    height: c.height,
    tileSize: c.tileSize,
    overlap: c.overlap,
    maxLevel: c.maxLevel,
  };
  const columns = Math.ceil(c.width / c.tileSize),
    rows = Math.ceil(c.height / c.tileSize);
  const grid = Buffer.alloc(12 + columns * rows * 16);
  grid.write("NGG1");
  grid.writeUInt32LE(columns, 4);
  grid.writeUInt32LE(rows, 8);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const id = index.levels[c.maxLevel].images[`${x},${y}`];
      if (!/^[a-f0-9]{32}$/.test(id ?? "") || !index.images[id])
        throw new Error(`Missing native image ${x},${y}.`);
      Buffer.from(id, "hex").copy(grid, 12 + (y * columns + x) * 16);
    }
  await write(resolve(output, "game-data/native-grid.bin"), grid);
  const catalog: PreparedGameCatalog = {
    schemaVersion: 1,
    version: index.version,
    capture,
    areas: [],
  };
  let samplerBytes = 0,
    positions = 0;
  const excluded: string[] = [];
  for (const area of inventory.puzzleAreas) {
    try {
      if (
        !area.runs?.length ||
        !area.scoring ||
        !area.difficultyTier ||
        area.difficultyRule
      ) {
        excluded.push(area.id);
        continue;
      }
      const sampler = prepareAreaStarts(index, area);
      if (!sampler.pixels) {
        excluded.push(area.id);
        continue;
      }
      if (sampler.pixels > 0xffffffff)
        throw new Error(
          `Area ${area.id} exceeds the sampler's native-pixel limit.`,
        );
      const data = Buffer.alloc(8 + sampler.rectangles.length * 20);
      data.write("NGS1");
      data.writeUInt32LE(sampler.rectangles.length, 4);
      let total = 0;
      sampler.rectangles.forEach((r, n) => {
        const offset = 8 + n * 20;
        data.writeInt32LE(r.x, offset);
        data.writeInt32LE(r.y, offset + 4);
        data.writeUInt32LE(r.width, offset + 8);
        data.writeUInt32LE(r.height, offset + 12);
        total += r.width * r.height;
        data.writeUInt32LE(total, offset + 16);
      });
      const filename =
        createHash("sha256").update(area.id).digest("hex").slice(0, 32) + ".bin";
      await write(resolve(output, "game-data/starts", filename), data);
      const definition: AreaDefinition = {
        id: area.id,
        label: area.label,
        originY: area.originY,
        runs: area.runs,
        bounds: area.bounds,
        cells: area.cells,
        difficultyTier: area.difficultyTier,
        scoring: area.scoring,
      };
      catalog.areas.push({ definition, starts: filename, positions: total });
      samplerBytes += data.byteLength;
      positions += total;
    } finally { options.onProgress?.(); }
  }
  if (!catalog.areas.length)
    throw new Error("No reviewed playable areas are available.");
  const text = JSON.stringify(catalog);
  await write(resolve(output, "game-data/catalog.json"), text + "\n");
  if (options.publicConfigPath) {
    const config = preparedGameConfig(
      catalog,
      options.referenceRoot ?? "https://guessr-map.sage-data.xyz/map_files/",
    );
    await write(
      resolve(options.publicConfigPath),
      JSON.stringify(config, null, 2) + "\n",
    );
  }
  return {
    directory: output,
    areas: catalog.areas.length,
    positions,
    excluded,
    catalogBytes: Buffer.byteLength(text),
    gridBytes: grid.byteLength,
    samplerBytes,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(
      await prepareWorkerData({
        publicConfigPath: "public/guessr/config.json",
        referenceRoot: process.env.GUESSR_REFERENCE_ROOT,
      }),
      null,
      2,
    ),
  );
}
