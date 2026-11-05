import { generateDynamicMap, releaseParallelWorlds } from "../../src/telescope/telescope-adapter";
import { SharedInstantTerrainResources } from "../../src/telescope/shared-instant-terrain";
import { createLiquidSurfacePainter, findLiquidSurfaces, loadLiquidMaterialIds } from "../../src/telescope/liquid-surfaces";
import { createPlaneOwnership } from "../../src/telescope/terrain-policy";
import { GLTerrainRenderer } from "noita-telescope-full-pixels/gl/terrain_renderer.js";
import { GENERATOR_CONFIG } from "noita-telescope-full-pixels/generator_config.js";
import { buildEngineResources } from "noita-telescope-full-pixels/gl/engine_resources.js";

export async function run() {
  window.location.search = "?terrain=gpu";
  const gen = await generateDynamicMap({ seed: 195331, parallelWorlds: [0], unlocks: null });
  const renderer = new GLTerrainRenderer(), resources = new SharedInstantTerrainResources(renderer);
  await resources.ensureResources(gen.tileLayers, gen.biomeData, { seed: gen.seed, generatorConfig: GENERATOR_CONFIG,
    lut: { recolorMaterials: true, clearSpawnPixels: true } });
  const engine = buildEngineResources(gen.tileLayers, gen.biomeData, GENERATOR_CONFIG, 70);
  const ids = await loadLiquidMaterialIds(), surfaces = findLiquidSurfaces(engine.lattice, ids, 70);
  const { gl } = renderer, maskUniform = gl.getUniformLocation(renderer.program, "u_liquidMaskOut");
  if (maskUniform === null || maskUniform === -1) throw new Error("Missing native liquid mask query uniform");
  const read = (x: number, y: number, width: number, height: number, plane: -1 | 0 | 1, mask: boolean,
    level = true, material = true) => {
    resources.setPlane(plane);
    if (!level) gl.uniform1i(renderer.uniforms.u_liquidRow, 0);
    const canvas = renderer.render({ width, height, camX: x + width / 2 + 17920,
      camY: y + height / 2 + 7168, camZ: 1, pw: 0, pwVertical: 0,
      edgeNoise: true, materialTextures: true, engineTerrain: true });
    if (material) {
      gl.uniform1i(renderer.uniforms.u_materialIdOut, 1);
      gl.uniform1i(maskUniform, mask ? 1 : 0);
      try { gl.drawArrays(gl.TRIANGLES, 0, 3); }
      finally { gl.uniform1i(maskUniform, 0); gl.uniform1i(renderer.uniforms.u_materialIdOut, 0); }
    }
    if (gl.getError()) throw new Error("Native liquid query shader error");
    return new Uint8ClampedArray(canvas.__nativeGlesPixels);
  };
  const decode = (bytes: Uint8ClampedArray) => Int16Array.from({ length: bytes.length / 4 },
    (_, p) => bytes[p * 4] + (bytes[p * 4 + 1] << 8) - 1);
  const samples = [];
  try {
    for (const [plane, pw] of [[0, -1], [0, 0], [0, 1], [-1, 0], [1, 0]] as const) {
      const x = -3230 + pw * 35840, y = 810 + plane * 24576, width = 200, height = 120, pad = 16;
      const oldIds = read(x, y, width, height, plane, false, false);
      const ordinary = read(x, y, width, height, plane, false);
      const actual = decode(read(x, y, width, height, plane, true));
      const reset = read(x, y, width, height, plane, false);
      const raw = decode(read(x, y - pad, width, height + pad * 2, plane, false));
      const expected = decode(ordinary);
      const paintPixels = plane < 0 ? gen.biomeData.heavenPixels : plane > 0 ? gen.biomeData.hellPixels : gen.biomeData.pixels;
      const owner = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels, paintPixels, GENERATOR_CONFIG, 70);
      const sample = (wx: number, wy: number) => wx < x || wx >= x + width || wy < y - pad || wy >= y + height + pad ||
        owner.at(wx, wy - plane * 24576) < 0 ? -1 : raw[(wy - y + pad) * width + wx - x];
      const shifted = surfaces.map(surface => ({ ...surface, y: surface.y + plane * 24576,
        sourceY: surface.sourceY === undefined ? undefined : surface.sourceY + plane * 24576 }));
      createLiquidSurfacePainter(shifted, 35840)(new Uint8ClampedArray(width * height * 4),
        x, y, width, height, sample, () => 0xff112233, (pixel, id) => expected[pixel] = id);
      let changes = 0, mismatches = 0, ordinaryDifferences = 0, resetDifferences = 0;
      for (let i = 0; i < oldIds.length; i++) {
        if (ordinary[i] !== oldIds[i]) ordinaryDifferences++;
        if (reset[i] !== ordinary[i]) resetDifferences++;
      }
      const before = decode(ordinary);
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== before[i]) changes++;
        if (actual[i] !== expected[i]) mismatches++;
      }
      const boundary = plane === 0 ? [-3160, -3130].map(wx => {
        const col = wx + pw * 35840 - x;
        return { x: wx, above: actual[(851 - y) * width + col], belowLiquid: ids.has(actual[(852 - y) * width + col]) };
      }) : [];
      samples.push({ plane, pw, changes, mismatches, ordinaryDifferences, resetDifferences, boundary });
    }
    const i = gen.biomeData.pixels.findIndex((color: number) => (color & 0xffffff) === (GENERATOR_CONFIG.lava_90percent.color & 0xffffff));
    if (i < 0) throw new Error("Missing native fallback-fluid fixture biome");
    const x = (i % 70) * 512 - 17920 + 256, y = Math.floor(i / 70) * 512 - 7168 + 256;
    const color = read(x, y, 1, 1, 0, false, true, false);
    const owner = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels, gen.biomeData.pixels, GENERATOR_CONFIG, 70);
    const chunkLeft = Math.floor(x / 512) * 512;
    const points = [chunkLeft, chunkLeft + 1, x, x + 1].map(px => ({
      x: px, y, localX: ((px % 512) + 512) % 512, owner: owner.at(px, y),
      ordinaryMaterial: decode(read(px, y, 1, 1, 0, false))[0],
      maskMaterial: decode(read(px, y, 1, 1, 0, true))[0],
    }));
    const fallback = { biome: "lava_90percent", x, y, mode: (engine.chunk[i] >> 8) & 3,
      ordinaryMaterial: decode(read(x, y, 1, 1, 0, false))[0],
      maskMaterial: decode(read(x, y, 1, 1, 0, true))[0], displayedAlpha: color[3], points };
    return { samples, fallback };
  } finally { resources.invalidate(); releaseParallelWorlds(); }
}
