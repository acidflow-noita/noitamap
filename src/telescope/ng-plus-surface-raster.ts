import { cacheMaterialAt } from './material-cache';
import type { NGPlusSurfaceLandmarkMask } from './ng-plus-surface-landmarks';
import { NG_PLUS_SURFACE_TOP } from './ng-plus-surface-layout';
import type { StaticTerrainMask } from './static-terrain-mask';
import { compositeTerrain } from './terrain-backgrounds';
import { createTerrainEdges } from './terrain-edges';
import { WORLD_TOP } from './terrain-policy';
import { writeRGBA } from './terrain-scenes';
import { createMaterialField } from 'noita-telescope-full-pixels/engine_resolve/material_field.js';
import { computeMaterialNoiseDensity, engineBiomeForColor, selectComponentForCell } from 'noita-telescope-full-pixels/engine_resolve/band_select.js';
import { buildMatColorTable } from 'noita-telescope-full-pixels/gl/engine_resources.js';
import { initMaterialAtlas, materialTexelRGBA } from 'noita-telescope-full-pixels/gl/material_atlas.js';

const CAPTURE_SKY = 0xff000000;

/** Preserve the captured art at the world pixel chosen for each output sample. */
function preserveLandmarks(data: Uint8ClampedArray, masks: StaticTerrainMask[], x: number, y: number,
  width: number, height: number, step: number) {
  for (const mask of masks) {
    const left = Math.max(0, Math.ceil((mask.x - x) / step));
    const top = Math.max(0, Math.ceil((mask.y - y) / step));
    const right = Math.min(width, Math.ceil((mask.x + mask.width - x) / step));
    const bottom = Math.min(height, Math.ceil((mask.y + mask.height - y) / step));
    for (let row = top; row < bottom; row++) {
      const start = (y + row * step - mask.y) * mask.width + x - mask.x;
      for (let col = left; col < right; col++) {
        const bit = start + col * step, index = bit >> 3;
        if (((mask.bits[index] | (mask.airBits?.[index] ?? 0)) & (1 << (bit & 7))) !== 0) {
          const offset = (row * width + col) * 4;
          data.fill(0, offset, offset + 4);
        }
      }
    }
  }
}

/** Render only the Hills cells that the NG+ Lua map assigned another surface. */
export async function createNGPlusSurfaceRaster(seed: number, pixels: Uint32Array, cells: Uint16Array,
  landmarks: NGPlusSurfaceLandmarkMask[]) {
  const mapWidth = pixels.length / 48;
  const changed = new Uint8Array(pixels.length);
  for (const index of cells) changed[index] = 1;
  const cellAt = (x: number, y: number) => {
    const col = Math.floor(x / 512) + mapWidth / 2;
    const row = Math.floor((y - WORLD_TOP) / 512);
    return row * mapWidth + ((col % mapWidth) + mapWidth) % mapWidth;
  };
  const owns = (x: number, y: number) => y >= NG_PLUS_SURFACE_TOP && changed[cellAt(x, y)] === 1;
  const biomeData = { pixels };
  // All three replacements use procedural surface topology. Supply an empty
  // Wang lattice so sampling a boundary never allocates a world-sized grid.
  const lattice = { GW: 0, GH: 0, cov: new Float32Array(), mat: new Uint16Array(),
    chunkCovered: new Uint8Array(pixels.length) };
  const field = createMaterialField([], biomeData, {}, mapWidth, seed, { lattice });
  const banks = landmarks.filter(mask => mask.densityBits);
  const surfaceMaterialAt = (x: number, y: number) => {
    for (const mask of banks) {
      const px = x - mask.x, py = y - mask.y;
      if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue;
      const bit = py * mask.width + px;
      if (mask.densityBits![bit >> 3] & (1 << (bit & 7))) {
        // Gray scene pixels force density 1; the chosen surface biome supplies
        // the material. This retains the authored bank even in procedural air.
        const biome = engineBiomeForColor(pixels[cellAt(x, y)] & 0xffffff);
        return Math.max(0, selectComponentForCell(biome, x, y, computeMaterialNoiseDensity(x, y, 1)));
      }
    }
    return field.materialAt(x, y);
  };
  const { materialAt } = cacheMaterialAt(surfaceMaterialAt);
  const gen = { seed, isNGP: true, gameMode: 'normal', tileLayers: [], biomeData };
  const [atlas, edges] = await Promise.all([initMaterialAtlas(), createTerrainEdges(gen, {}, mapWidth, materialAt)]);
  const colors = buildMatColorTable(atlas).data;

  return (x: number, y: number, width: number, height: number, step: number): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(width * height * 4);
    const firstX = x + Math.floor(step / 2), firstY = y + Math.floor(step / 2);
    // At coarse levels neighboring samples can be entire chunks apart.
    // Only native texels share the edge pass's spatial material cache.
    const sample = step === 1 ? materialAt : surfaceMaterialAt;
    let hasMaterial = false;
    for (let row = 0; row < height; row++) {
      const sy = firstY + row * step;
      for (let col = 0; col < width; col++) {
        const sx = firstX + col * step;
        if (!owns(sx, sy)) continue;
        // Noise, material texture coordinates and edge stamps all use absolute
        // coordinates even though the layout repeats in parallel worlds.
        const id = sample(sx, sy);
        if (id < 0) continue;
        const offset = (row * width + col) * 4;
        data[offset + 3] = 255;
        if (id === 0) continue;
        hasMaterial = true;
        const p = id * 4, entry = colors[p] & 255;
        const rgba = entry ? materialTexelRGBA(atlas, entry, sx, sy)
          : (((colors[p] >>> 8) << 24) | (colors[p + 1] << 16) | (colors[p + 2] << 8) | colors[p + 3]) >>> 0;
        if (rgba !== -1) writeRGBA(data, offset, compositeTerrain(rgba, CAPTURE_SKY));
      }
    }
    if (step === 1 && hasMaterial) edges.paint(data, x, y, width, height, owns);
    preserveLandmarks(data, landmarks, firstX, firstY, width, height, step);
    return data;
  };
}
