import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { serializeTileLayer } from "../../src/telescope/tile-layer-cache";
import { createCpuTerrain } from "../../src/telescope/cpu-terrain-core";
import { setTerrainPlane } from "../../src/telescope/instant-terrain-plane";
import { GLTerrainRenderer } from "noita-telescope-full-pixels/gl/terrain_renderer.js";
import { GENERATOR_CONFIG } from "noita-telescope-full-pixels/generator_config.js";
import { prewarmTerrainShader } from "../../src/telescope/terrain-shader-prewarm";

let generated: ReturnType<typeof generateDynamicMap> | undefined;
function generation() {
  setFullPixelTerrainForBake(true);
  return generated ??= generateDynamicMap({ seed: 786433191, ngPlus: 0, parallelWorlds: [0], unlocks: null });
}

/** Real generation + real shader. No browser and no game executable required. */
export async function verifyGpuMaterials() {
  const gen = await generation();
  const planes: Record<string, any> = {};
  for (const plane of [0, -1, 1] as const) {
    const p = await prepareTerrainPlane(gen, plane);
    planes[String(plane)] = { ...p, seed:gen.seed,
      tileLayers:p.tileLayers.map(serializeTileLayer),
      elevatorShafts:p.elevatorShafts?.map(serializeTileLayer) };
  }
  const { openGpuBakeRenderer } = await import("../../src/telescope/gpu-bake-renderer");
  const renderer = await openGpuBakeRenderer({ seed:gen.seed, planes });
  // First four regress RarePolka. The remaining six selected the wrong
  // material with the upstream topology coordinate coefficients; these cover
  // distinct depths plus both horizontal parallel worlds.
  return [[24,526],[78,515],[52,516],[36247,1000],
    [59,518],[-984,542],[31,4098],[7248,8193],[35882,512],[-35795,512],
  ].map(([x,y])=>renderer.probeMaterial(x,y));
}

/** Compare owned repeated Wang regions, including both solid and air pixels.
 * Elevator extensions and final scene/decal composition are outside this probe. */
export async function verifyVerticalGpuMaterials() {
  const gen = await generation();
  const regions = [[-4032,-7104],[-4032,64],[-3008,576],[-3520,1600],[-2496,2112],[-2496,3136]];
  const results = [];
  for (const plane of [-1, 1] as const) {
    const data = await prepareTerrainPlane(gen, plane);
    const cpu = await createCpuTerrain(data);
    const renderer = new GLTerrainRenderer();
    await prewarmTerrainShader(renderer);
    const warmedProgram = renderer.program;
    if (!renderer.ensureResources(data.tileLayers, data.biomeData, {
      isNGP: false, gameMode: "normal", seed: gen.seed, generatorConfig: GENERATOR_CONFIG,
      engineTerrain: true, lut: { recolorMaterials: true, clearSpawnPixels: true },
    })) throw new Error(renderer.failed);
    if (renderer.program !== warmedProgram) throw new Error('Terrain shader warmup program was not reused');
    const { gl } = renderer;
    for (const [x, localY] of regions) {
      const y = localY + plane * 24576;
      const draw = (selected: -1 | 0 | 1) => {
        setTerrainPlane(renderer, selected);
        const canvas = renderer.render({ width:64, height:64, camX:x+32+17920,
          camY:y+32+7168, camZ:1, pw:0, pwVertical:0, edgeNoise:true,
          materialTextures:true, engineTerrain:true });
        gl.uniform1i(renderer.uniforms.u_materialIdOut, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return canvas.__nativeGlesPixels as Uint8ClampedArray;
      };
      const before = draw(0), after = draw(plane);
      let mismatches = 0, geometryMismatches = 0, baselineMismatches = 0, nonAir = 0;
      for (let py=0; py<64; py++) for (let px=0; px<64; px++) {
        const i=(py*64+px)*4, reference=cpu.materialAt(x+px,y+py);
        const old=before[i]+(before[i+1]<<8)-1, material=after[i]+(after[i+1]<<8)-1;
        if (reference>0) nonAir++;
        if (old!==reference) baselineMismatches++;
        if (material!==reference) mismatches++;
        if ((material>0)!==(reference>0)) geometryMismatches++;
      }
      results.push({ plane, x, y, pixels:4096, nonAir, mismatches, geometryMismatches, baselineMismatches });
    }
    renderer.invalidate();
  }
  return results;
}
