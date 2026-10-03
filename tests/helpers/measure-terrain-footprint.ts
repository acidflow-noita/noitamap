/** No browser. Counts requested full-resolution leaves for a whole nine-plane
 * overview of a prepared bake. This measures avoided work, NOT browser FPS. */
import { deserialize } from "node:v8";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTerrainFootprint } from "../../src/telescope/terrain-footprint";
import { restoreTileLayer } from "../../src/telescope/tile-layer-cache";
import { GENERATOR_CONFIG } from "../../lib/noita-telescope-vm/js/generator_config.js";
if (!process.argv[2])
  throw new Error(
    "Usage: npx tsx tests/helpers/measure-terrain-footprint.ts /path/to/bake",
  );
const snapshot = deserialize(
  readFileSync(resolve(process.argv[2], "generation.bin")),
);
const width = snapshot.width / 512;
const report: any = { seed: snapshot.seed, total: 0, required: 0, planes: [] };
for (const plane of [-1, 0, 1]) {
  const data = snapshot.planes[plane];
  const gen = {
    ...data,
    sceneData: snapshot.sceneData,
    tileLayers: data.tileLayers.map(restoreTileLayer),
    elevatorShafts: data.elevatorShafts?.map(restoreTileLayer),
  };
  const has = createTerrainFootprint(gen, GENERATOR_CONFIG, width);
  let required = 0;
  for (const pw of [-1, 0, 1])
    for (let cy = 0; cy < 48; cy++)
      for (let cx = 0; cx < width; cx++) {
        report.total++;
        if (
          has(
            cx * 512 - width * 256 + pw * width * 512,
            -7168 + plane * 24576 + cy * 512,
            512,
            512,
          )
        )
          required++;
      }
  report.required += required;
  report.planes.push({ plane, required, total: width * 48 * 3 });
}
report.skipped = report.total - report.required;
report.skippedPercent = (report.skipped * 100) / report.total;
console.log(JSON.stringify(report, null, 2));
