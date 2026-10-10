import { generateDynamicMap, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
import { SharedInstantTerrainResources } from '../../src/telescope/shared-instant-terrain';
import { findLiquidSurfaces, loadLiquidMaterialIds, createLiquidSurfacePainter } from '../../src/telescope/liquid-surfaces';
import { createPlaneOwnership } from '../../src/telescope/terrain-policy';
import { GLTerrainRenderer } from 'noita-telescope-full-pixels/gl/terrain_renderer.js';
import { GENERATOR_CONFIG } from 'noita-telescope-full-pixels/generator_config.js';
import { buildEngineResources, buildMatColorTable } from 'noita-telescope-full-pixels/gl/engine_resources.js';
import { getMaterialAtlas, materialTexelRGBA } from 'noita-telescope-full-pixels/gl/material_atlas.js';

export async function run() {
  window.location.search = '?terrain=gpu';
  const gen = await generateDynamicMap({ seed: 100199613, parallelWorlds: [0], unlocks: null });
  const renderer = new GLTerrainRenderer(), resources = new SharedInstantTerrainResources(renderer);
  await resources.ensureResources(gen.tileLayers, gen.biomeData, { seed: gen.seed, generatorConfig: GENERATOR_CONFIG,
    lut: { recolorMaterials: true, clearSpawnPixels: true } });
  const engine = buildEngineResources(gen.tileLayers, gen.biomeData, GENERATOR_CONFIG, 70);
  const surfaces = findLiquidSurfaces(engine.lattice, await loadLiquidMaterialIds(), 70);
  const atlas = getMaterialAtlas(), colors = buildMatColorTable(atlas).data;
  const color = (id: number, x: number, y: number) => {
    const i = id * 4, entry = colors[i] & 255;
    if (entry) { const c = materialTexelRGBA(atlas, entry, x, y); return c === -1 ? 0 : c; }
    return (((colors[i] >> 8) << 24) | (colors[i + 1] << 16) | (colors[i + 2] << 8) | colors[i + 3]) >>> 0;
  };
  const read = (x: number, y: number, w: number, h: number, plane: -1|0|1, flat: boolean, ids = false) => {
    resources.setPlane(plane);
    if (!flat) renderer.gl.uniform1i(renderer.uniforms.u_liquidRow, 0);
    const canvas = renderer.render({ width: w, height: h, camX: x + w / 2 + 17920,
      camY: y + h / 2 + 7168, camZ: 1, pw: 0, pwVertical: 0,
      edgeNoise: true, materialTextures: true, engineTerrain: true });
    if (ids) {
      renderer.gl.uniform1i(renderer.uniforms.u_materialIdOut, 1);
      renderer.gl.drawArrays(renderer.gl.TRIANGLES, 0, 3);
    }
    if (renderer.gl.getError()) throw new Error('Liquid-surface native GL error');
    return new Uint8ClampedArray(canvas.__nativeGlesPixels);
  };
  const samples: any[] = [];
  try {
    for (const plane of [0, -1, 1] as const) for (const pw of [-1, 0, 1]) {
      const x = -2910 + pw * 35840, y = 2190 + plane * 24576, w = 800, h = 430;
      const before = read(x, y, w, h, plane, false), actual = read(x, y, w, h, plane, true);
      const ids = read(x, y - 6, w, h + 12, plane, false, true);
      const correctedIds = read(x, y - 6, w, h + 12, plane, true, true);
      const biomePixels = plane < 0 ? gen.biomeData.heavenPixels : plane > 0 ? gen.biomeData.hellPixels : gen.biomeData.pixels;
      const owner = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels, biomePixels, GENERATOR_CONFIG, 70);
      const sample = (wx: number, wy: number) => {
        if (owner.at(wx, wy - plane * 24576) < 0 || wx < x || wx >= x + w || wy < y - 6 || wy >= y + h + 6) return -1;
        const i = ((wy - y + 6) * w + wx - x) * 4;
        return ids[i] + (ids[i + 1] << 8) - 1;
      };
      const expected = before.slice();
      createLiquidSurfacePainter(surfaces.map(s => ({ ...s, y: s.y + plane * 24576 })), 35840)(expected, x, y, w, h, sample, color);
      let changed = 0, alphaDifferences = 0, untouchedDifferences = 0, changedColorMaxError = 0, materialIdDifferences = 0;
      const examples: any[] = [];
      for (let i = 0; i < actual.length; i += 4) {
        const change = expected.subarray(i, i + 4).some((v, k) => v !== before[i + k]);
        if (change) changed++;
        if (actual[i + 3] !== expected[i + 3]) {
          alphaDifferences++;
          if (examples.length < 8) examples.push({ x: x + i / 4 % w, y: y + Math.floor(i / 4 / w), got: [...actual.slice(i,i+4)], expected: [...expected.slice(i,i+4)] });
        }
        for (let k = 0; k < 4; k++) {
          if (!change && actual[i+k] !== before[i+k]) untouchedDifferences++;
          if (change && k < 3) changedColorMaxError = Math.max(changedColorMaxError, Math.abs(actual[i+k] - expected[i+k]));
        }
      }
      for (let i = 0; i < ids.length; i++) if (ids[i] !== correctedIds[i]) materialIdDifferences++;
      const left = read(x, y, 400, h, plane, true), right = read(x + 400, y, 400, h, plane, true);
      let seamDifferences = 0;
      for (let row = 0; row < h; row++) for (let col = 0; col < w * 4; col++)
        if (actual[(row*w*4)+col] !== (col < 1600 ? left[row*1600+col] : right[row*1600+col-1600])) seamDifferences++;
      samples.push({ plane, pw, changed, alphaDifferences, untouchedDifferences, changedColorMaxError, materialIdDifferences, seamDifferences, examples });
    }
    return { seed: gen.seed, samples, resourceStats: resources.stats, surfaces: surfaces.length };
  } finally { resources.invalidate(); releaseParallelWorlds(); }
}
