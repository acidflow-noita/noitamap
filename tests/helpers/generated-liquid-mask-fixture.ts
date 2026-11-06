import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { serializeTileLayer } from "../../src/telescope/tile-layer-cache";
import { openBakeRenderer } from "../../src/telescope/bake-entry";
import { encodeLiquidMask, maskBlock } from "../../src/liquids/mask-codec";

export async function verifyMasks(seed = 195331) {
  setFullPixelTerrainForBake(true);
  const gen = await generateDynamicMap({ seed, ngPlus: 0, parallelWorlds: [0], unlocks: null });
  const planes: Record<string, any> = {};
  for (const plane of [0, -1, 1] as const) {
    const data = await prepareTerrainPlane(gen, plane);
    planes[String(plane)] = { ...data, seed: gen.seed,
      tileLayers: data.tileLayers.map(serializeTileLayer),
      elevatorShafts: data.elevatorShafts?.map(serializeTileLayer) };
  }
  const snapshot = { seed: gen.seed, planes, sceneData: { scenes: [], sources: {}, staticMasks: [] } };
  const cpu = await openBakeRenderer(snapshot), gpu = await openBakeRenderer(snapshot, "gpu");
  const regions = [
    // Reported generated pool at 626,2043, in an old Daily without a sidecar.
    seed === 2100611341 ? { x: 528, y: 1984, w: 200, h: 120 } : { x: -3230, y: 810, w: 200, h: 120 },
    { x: -3230, y: 810 - 24576, w: 200, h: 120 },
    { x: -3230, y: 810 + 24576, w: 200, h: 120 },
    // A single request straddles two plane finishers and unowned world cells.
    { x: -4032, y: -7184, w: 64, h: 32 },
    // The former basin reservation must no longer cut holes in native output.
    { x: 585, y: 1009, w: 367, h: 15 },
  ];
  const results = [];
  let baselineMs = 0, maskedMs = 0;
  for (const area of regions) {
    const { x, y, w, h } = area;
    const mask = new Uint8Array(w * h).fill(17), other = new Uint8Array(w * h).fill(19);
    const plain = cpu.render(x, y, w, h), masked = cpu.render(x, y, w, h, mask);
    gpu.render(x, y, w, h, other);
    let pixelDifferences = 0, maskDifferences = 0;
    for (let i = 0; i < plain.length; i++) if (plain[i] !== masked[i]) pixelDifferences++;
    for (let i = 0; i < mask.length; i++) if (mask[i] !== other[i]) maskDifferences++;
    const block = maskBlock(x, y, w, h, mask);
    results.push({ ...area, pixelDifferences, maskDifferences,
      opaquePixels: plain.reduce((n, p, i) => n + (i % 4 === 3 && p ? 1 : 0), 0),
      liquidPixels: mask.reduce((n, p) => n + (p ? 1 : 0), 0),
      invalid: mask.some(p => p !== 0 && p !== 255),
      encodedBytes: encodeLiquidMask(block ? [block] : []).length });
  }
  const { x, y, w, h } = regions[0], mask = new Uint8Array(w * h);
  // Alternate order after warmup to reduce cache and JIT ordering bias.
  for (let n = 0; n < 8; n++) for (const enabled of n % 2 ? [true, false] : [false, true]) {
    const start = performance.now();
    cpu.render(x, y, w, h, enabled ? mask : undefined);
    const ms = performance.now() - start;
    if (enabled) maskedMs += ms; else baselineMs += ms;
  }
  return { seed, results, timing: { repeats: 8, pixelsPerRepeat: w * h, baselineMs, maskedMs } };
}
