/** Shared authored inputs retained by one native generation worker. */
import { createNativeWorldGenerator } from "../../world";
import type { NativeAssets } from "../../asset-host";
import { decodePngToRgba } from "../../png";
import { GENERATOR_CONFIG } from "../../rules/generator_config.js";
import { MATERIAL_NAMES_BY_ID } from "../../complete-materials/engine-data.mjs";
import { createCompleteMaterialResolver } from "../../complete-materials";
import { loadMaterialAtlas } from "../../cook-inputs";
import { createSceneSourceLoader, loadSceneBiomeColors, createStrictEdgeStamper } from "../../composition";
import { BIOME_BACKGROUND_MAP } from "../../composition/world-policy";
import { liquidMaterialIds } from "../../composition/liquid-inputs";
import { buildEdgeTablesAsync, EDGE_ATLAS_WIDTH } from "../../composition/edge-tables";
import { loadLegacyColorPolicy } from "../../cook-inputs/legacy";

export interface SharedInputOptions {assets:NativeAssets;materialModule:WebAssembly.Module;edgeModule:WebAssembly.Module;memorySample?:()=>Record<string,number>;yieldControl?:()=>Promise<void>;}
const cfg:any=GENERATOR_CONFIG;
function bytes(value: unknown): number {
  const seen = new Set<unknown>(), buffers = new Set<ArrayBufferLike>();
  const visit = (v: any) => {
    if (!v || typeof v !== "object" || seen.has(v)) return; seen.add(v);
    if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
    else if (v instanceof ArrayBuffer) buffers.add(v);
    else if (v instanceof Map) for (const child of v.values()) visit(child);
    else if (Array.isArray(v)) for (const child of v) visit(child);
    else for (const child of Object.values(v)) visit(child);
  };
  visit(value); return [...buffers].reduce((sum, b) => sum + b.byteLength, 0);
}
export async function createSharedInputs(options:SharedInputOptions){
  const t0 = performance.now(), timings: Record<string, number> = {};
  const generator = await createNativeWorldGenerator(options.assets, options.yieldControl);
  timings.generatorInitializationMs = performance.now() - t0;
  const t1 = performance.now();
  const [atlas, loader, edgeTables, edgeAtlas, sceneColors, materialXML, legacyPolicy] = await Promise.all([
    loadMaterialAtlas(options.assets), createSceneSourceLoader(options.assets, { cacheBytes: 128 * 1024 * 1024 }),
    buildEdgeTablesAsync(), options.assets.read("data/edge_atlas.bin"), loadSceneBiomeColors(options.assets, cfg), options.assets.read("data/materials.xml"),
    loadLegacyColorPolicy(options.assets),
  ]);
  const bands = await createCompleteMaterialResolver({ seed: 0, mapWidth: 70, plane: { offsetY: 0 },
    lattice: { GW: 1, GH: 1, cov: new Float32Array([1]), mat: new Uint16Array([1]), chunkCovered: new Uint8Array(3360) },
    biomePixels: new Uint32Array(3360), hostChunks: new Uint32Array(3360), parameters: [] }, options.materialModule, { maxWidth: 1, maxHeight: 1 });
  const backgroundTextures: Array<{ path: string; width: number; height: number; data: Uint8Array | Uint8ClampedArray }> = [];
  const backgroundByName = new Map<string, number>(), backgroundByPath = new Map<string, number>();
  for (const [name, path] of Object.entries(BIOME_BACKGROUND_MAP)) {
    let id = backgroundByPath.get(path);
    if (id === undefined) {
      const image = decodePngToRgba(Uint8Array.from(await options.assets.read(path)).buffer);
      id = backgroundTextures.length + 1; backgroundTextures.push({ path, ...image }); backgroundByPath.set(path, id);
    }
    backgroundByName.set(name, id);
  }
  timings.sharedAssetPreparationMs = performance.now() - t1;
  const edgeResources = { tables: edgeTables, atlas: edgeAtlas, atlasWidth: EDGE_ATLAS_WIDTH };
  const edgeStamper = await createStrictEdgeStamper(options.edgeModule, edgeResources);
  const liquidIDs = liquidMaterialIds(new TextDecoder().decode(materialXML), MATERIAL_NAMES_BY_ID);
  const textureColor = (index: number, x: number, y: number) => {
    if (!index) return 0; const image = backgroundTextures[index - 1];
    const px = ((x % image.width) + image.width) % image.width, py = ((y % image.height) + image.height) % image.height;
    const at = (py * image.width + px) * 4, d = image.data;
    return ((d[at + 3] << 24) | (d[at] << 16) | (d[at + 1] << 8) | d[at + 2]) >>> 0;
  };
  const backgroundShapes = new Map<string, Promise<{ width: number; height: number }>>();
  function backgroundShape(path: string | null | undefined) {
    if (!path) return Promise.resolve({ width: 0, height: 0 });
    let value = backgroundShapes.get(path);
    if (!value) {
      value = options.assets.read(path).then(bytes => {
        if (bytes.byteLength < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 ||
            String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new Error(`Invalid scene-background PNG header: ${path}`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
        if (!width || !height || width * height > 2 ** 28) throw new Error("Unbounded scene-background geometry");
        return { width, height };
      });
      backgroundShapes.set(path, value);
    }
    return value;
  }
  const sharedRetainedBytes = bytes({ atlas, edgeResources, backgroundTextures }) + bands.memoryBytes + edgeStamper.memoryBytes;
  return { initialization:Object.freeze({...timings,sharedRetainedBytes,process:options.memorySample?.()}),
    generator,atlas,loader,bands,edgeResources,edgeStamper,backgroundTextures,backgroundByName,backgroundShape,
    textureColor,sceneColors,liquidIDs,sharedRetainedBytes,legacyPolicy };
}
