import Flatbush from "flatbush";
import type { NativeAssets } from "../asset-host";
import type { NativeWorldDescription, WorldRegion } from "../world";
import {
  createCompleteMaterialResolver, MaterialClassification as M,
  type CompleteMaterialResolver,
} from "../complete-materials";
import { BIOME_ENGINE, MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from "../complete-materials/engine-data.mjs";
import {
  prepareWorldMaterialInputs, loadMaterialAtlas, loadLegacyColorPolicy,
  createLegacyColorResolver, createBaseForegroundPainter, materialRGBA,
  fillMaterialsByBiome,
  type CookGeneratorConfig, type MaterialInputPolicy, type VerticalPlane,
} from "../cook-inputs";
import {
  createPageComposer, createSceneSourceLoader, createNativeScenePreparer,
  createWorldCompositionResources, staticSceneBits,
  type PreparedNativeScene, type NativeScenePlacement, type NativeSceneSource,
  type StaticMask, type WorldCompositionResourceOptions,
} from "../composition";
import type { CompleteWorldScenePolicy, SceneLayers } from "./scene-policy";
export * from "./scene-policy";
export const COMPLETE_WORLD_VERSION = "owned-world-pages-v1";

export interface CompleteWorldRegion {
  horizontal: number;
  vertical: VerticalPlane;
  /** Absolute physical region bounds. NG+ content still uses its 32760px stride. */
  x: number; y: number; width: number; height: number;
  columns: number; rows: number;
}
export interface CompletePageAddress {
  horizontal: number;
  vertical: VerticalPlane;
  column: number;
  row: number;
}
export interface CompleteRectAddress {
  horizontal: number;
  vertical: VerticalPlane;
  /** Absolute integer world coordinates, inside the selected physical region. */
  x: number; y: number; width: number; height: number;
}
export interface CompletedWorldPage extends CompleteRectAddress {
  /** Durable completed dynamic-layer pixels. Static-capture cutouts stay transparent. */
  pixels: Uint8ClampedArray;
  sceneCount: number;
  staticMaskCount: number;
}
export interface CompleteWorldOptions {
  assets: NativeAssets;
  materialModule: WebAssembly.Module;
  edgeModule: BufferSource | WebAssembly.Module;
  generatorConfig: CookGeneratorConfig;
  hostPolicy: MaterialInputPolicy["emptyTopology0"];
  scenePolicy: CompleteWorldScenePolicy;
  pageSize?: number;
  requireAllNine?: boolean;
  /** Retained resolver/staging memory, independent from shared input geometry. */
  resolverBytes?: number;
  preparedSceneBytes?: number;
  sourceSceneBytes?: number;
  /** Active prepared scenes, masks and page material/RGBA workspace. */
  pageWorkingBytes?: number;
  composition?: Pick<WorldCompositionResourceOptions, "liquidMaterialIds" | "ownershipPolicy">;
  signal?: AbortSignal;
  yieldControl?: () => Promise<void>;
}
export interface CompleteWorldStats {
  pages: number; cancelled: number; failures: number;
  resolverCreations: number; resolverHits: number; resolverEvictions: number;
  resolverBytes: number; resolverPeakBytes: number;
  preparedSceneBytes: number; preparedScenePeakBytes: number;
  sourceSceneBytes: number;
  preparedSceneHits: number; preparedSceneMisses: number;
  latticeInputBytes: number; materialAtlasBytes: number; edgeMemoryBytes: number;
}
export interface CompleteWorldSource {
  readonly revision: string;
  readonly seed: number;
  readonly pageSize: number;
  readonly regions: readonly CompleteWorldRegion[];
  readonly scope: "terrain-scenes-layer";
  readonly stats: CompleteWorldStats;
  pageAddresses(): IterableIterator<CompletePageAddress>;
  renderPage(address: CompletePageAddress, signal?: AbortSignal): Promise<CompletedWorldPage>;
  renderRect(address: CompleteRectAddress, signal?: AbortSignal): Promise<CompletedWorldPage>;
  /** Sequential full-cook fallback. Callers own retention; no implicit dense bake. */
  pages(signal?: AbortSignal): AsyncIterableIterator<CompletedWorldPage>;
  dispose(): void;
}
export class UnresolvedWorldMaterialError extends Error {
  constructor(public readonly x: number, public readonly y: number, public readonly classification: number) {
    super(`Unresolved world material at ${x},${y} (classification ${classification})`);
    this.name = "UnresolvedWorldMaterialError";
  }
}
const MiB = 1024 * 1024;
const key = (horizontal: number, vertical: number) => `${horizontal},${vertical}`;
function bytesOfScene(scene: PreparedNativeScene): number {
  return scene.pixels.byteLength + (scene.eraseMask?.byteLength ?? 0) + scene.sourceAlpha.byteLength +
    scene.edge.grid.byteLength + (scene.edge.artMask?.byteLength ?? 0) + (scene.backgroundArt?.data.byteLength ?? 0);
}
function checkedBudget(value: number, name: string, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`Invalid ${name} budget`);
  return value;
}
interface SceneRecord {
  scene: NativeScenePlacement;
  region: WorldRegion;
  layers: SceneLayers;
  right: number;
  bottom: number;
}

/** Assemble a real world description into exact owned dynamic pages. Asset and
 * host policy choices are explicit; no legacy runtime callbacks are accepted.
 * Jobs serialize so resolver/edge borrowed memories cannot race between pages. */
export async function createCompleteWorldSource(
  world: NativeWorldDescription, options: CompleteWorldOptions,
): Promise<CompleteWorldSource> {
  const lifetime = new AbortController();
  const check = (signal?: AbortSignal) => { lifetime.signal.throwIfAborted(); options.signal?.throwIfAborted(); signal?.throwIfAborted(); };
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const checkpoint = async (signal?: AbortSignal) => { check(signal); await yieldControl(); check(signal); };
  check();
  if (world.kind !== "native-world-description" || !world.revision || world.revision !== options.assets.revision)
    throw new Error("Complete world and assets must have the same explicit revision");
  if (!options.scenePolicy || typeof options.scenePolicy.classify !== "function" || typeof options.scenePolicy.layers !== "function")
    throw new Error("Explicit scene selection/layer policy is required");
  const pageSize = options.pageSize ?? 512;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 576) throw new RangeError("Complete page edge must be 1..576");
  const resolverBudget = checkedBudget(options.resolverBytes ?? 128 * MiB, "resolver", 1);
  const sceneBudget = checkedBudget(options.preparedSceneBytes ?? 64 * MiB, "prepared scene");
  const sourceBudget = checkedBudget(options.sourceSceneBytes ?? 32 * MiB, "source scene");
  const workingBudget = checkedBudget(options.pageWorkingBytes ?? 128 * MiB, "page working", 1);
  const prepared = prepareWorldMaterialInputs(world, { generatorConfig: options.generatorConfig, emptyTopology0: options.hostPolicy });
  const regions: CompleteWorldRegion[] = [], regionMap = new Map<string, CompleteWorldRegion>();
  for (const region of world.regions) {
    const id = key(region.horizontal, region.vertical);
    if (!Number.isSafeInteger(region.horizontal) || ![-1, 0, 1].includes(region.vertical) || regionMap.has(id))
      throw new Error("Invalid or duplicate world region");
    const descriptor = { horizontal: region.horizontal, vertical: region.vertical,
      x: region.horizontal * prepared.worldWidth - prepared.centerPx, y: region.vertical * 24576 - 7168,
      width: prepared.worldWidth, height: 24576, columns: Math.ceil(prepared.worldWidth / pageSize), rows: Math.ceil(24576 / pageSize) };
    if (![descriptor.x, descriptor.y, descriptor.x + descriptor.width, descriptor.y + descriptor.height].every(v => Number.isSafeInteger(v) && Math.abs(v) <= 2 ** 26))
      throw new RangeError("World region exceeds the exact material coordinate domain");
    regionMap.set(id, descriptor); regions.push(Object.freeze(descriptor));
  }
  if (options.requireAllNine !== false)
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1])
      if (!regionMap.has(key(x, y))) throw new Error(`Complete world is missing region ${x},${y}`);
  const allScenes: Array<{ scene: NativeScenePlacement; region: WorldRegion; action: "render" | "static-mask" }> = [];
  for (const region of world.regions) for (const value of region.scenes) {
    if (!value) continue;
    const scene: NativeScenePlacement = { key: value.key, name: value.name, variantKey: value.variantKey,
      x: value.x, y: value.y, width: value.width, height: value.height };
    const action = options.scenePolicy.classify(scene, region);
    if (action === "skip") continue;
    if (action !== "render" && action !== "static-mask") throw new Error(`Unresolved scene policy: ${scene.key}`);
    if (!scene.key || !scene.name || ![scene.x, scene.y, scene.width, scene.height].every(Number.isSafeInteger) || scene.width < 1 || scene.height < 1)
      throw new Error(`Invalid selected scene placement: ${scene.key}`);
    allScenes.push({ scene, region, action });
  }
  await checkpoint();
  const [atlas, legacyPolicy, loader, composition] = await Promise.all([
    loadMaterialAtlas(options.assets), loadLegacyColorPolicy(options.assets),
    createSceneSourceLoader(options.assets, { cacheBytes: sourceBudget }),
    createWorldCompositionResources(world, prepared, options.assets, {
      edgeModule: options.edgeModule, scenes: allScenes.filter(s => s.action === "render").map(s => s.scene),
      generatorConfig: options.generatorConfig, ...options.composition,
    }),
  ]);
  check();
  const sceneRecords: SceneRecord[] = [], masks: StaticMask[] = [];
  const maskBits = new Map<string, { bits: Uint8Array; airBits: Uint8Array }>(), maskPlacements = new Set<string>();
  const sourceGeometry = new Map<string, { width: number; height: number; backgroundWidth: number; backgroundHeight: number }>();
  let processedScenes = 0;
  for (const item of allScenes) {
    const { scene, region } = item;
    let geometry = sourceGeometry.get(scene.key);
    if (!geometry || (item.action === "static-mask" && !maskBits.has(scene.key))) {
      const source = await loader.load(scene); check();
      geometry = { width: source.width, height: source.height, backgroundWidth: source.backgroundArt?.width ?? 0, backgroundHeight: source.backgroundArt?.height ?? 0 };
      sourceGeometry.set(scene.key, geometry);
      if (item.action === "static-mask") maskBits.set(scene.key, { bits: staticSceneBits(source.data), airBits: staticSceneBits(source.data, true) });
    }
    if (item.action === "static-mask") {
      const id = `${scene.key}/${scene.x}/${scene.y}`;
      if (geometry.width >= 2 && geometry.height >= 2 && !maskPlacements.has(id)) {
        maskPlacements.add(id);
        masks.push({ x: scene.x, y: scene.y, width: geometry.width, height: geometry.height, ...maskBits.get(scene.key)! });
      }
    } else {
      if (scene.width !== geometry.width || scene.height !== geometry.height) throw new Error(`Scene dimensions changed: ${scene.key}`);
      const layers = options.scenePolicy.layers(scene);
      if (![layers.background, layers.mid, layers.visual].every(v => typeof v === "boolean")) throw new Error(`Unresolved scene layers: ${scene.key}`);
      sceneRecords.push({ scene, region, layers,
        right: scene.x + Math.max(scene.width, layers.background ? geometry.backgroundWidth : 0),
        bottom: scene.y + Math.max(scene.height, layers.background ? geometry.backgroundHeight : 0) });
    }
    check();
    if (++processedScenes % 64 === 0) await checkpoint();
  }
  const sceneIndex = sceneRecords.length ? new Flatbush(sceneRecords.length) : null;
  for (const record of sceneRecords) sceneIndex!.add(record.scene.x, record.scene.y, record.right, record.bottom);
  sceneIndex?.finish();
  const maskIndex = masks.length ? new Flatbush(masks.length) : null;
  for (const mask of masks) maskIndex!.add(mask.x, mask.y, mask.x + mask.width, mask.y + mask.height);
  maskIndex?.finish();
  const fillBiomeMaterials: Record<number, string> = {};
  for (const conf of Object.values(options.generatorConfig)) if (conf.fillMaterial) fillBiomeMaterials[conf.color & 0xffffff] = conf.fillMaterial;
  const fillLayerMaterials = Object.fromEntries(fillMaterialsByBiome(options.generatorConfig));
  const stats: CompleteWorldStats = { pages: 0, cancelled: 0, failures: 0, resolverCreations: 0, resolverHits: 0, resolverEvictions: 0,
    resolverBytes: 0, resolverPeakBytes: 0, preparedSceneBytes: 0, preparedScenePeakBytes: 0, sourceSceneBytes: loader.cacheBytes,
    preparedSceneHits: 0, preparedSceneMisses: 0,
    latticeInputBytes: prepared.lattice.cov.byteLength + prepared.lattice.mat.byteLength + prepared.lattice.chunkCovered.byteLength,
    materialAtlasBytes: atlas.data.byteLength + atlas.meta.byteLength + atlas.materialTable.byteLength,
    edgeMemoryBytes: composition.edgeStamper.memoryBytes };
  type Context = { resolver: CompleteMaterialResolver; painter: ReturnType<typeof createBaseForegroundPainter>; prepareScene: ReturnType<typeof createNativeScenePreparer> };
  const contexts = new Map<VerticalPlane, Context>(), sceneCache = new Map<number, PreparedNativeScene>();
  function evictContext() {
    const oldest = contexts.keys().next().value;
    if (oldest === undefined) return false;
    stats.resolverBytes -= contexts.get(oldest)!.resolver.memoryBytes;
    contexts.delete(oldest); stats.resolverEvictions++; return true;
  }
  async function context(plane: VerticalPlane, signal?: AbortSignal) {
    const existing = contexts.get(plane);
    if (existing) { contexts.delete(plane); contexts.set(plane, existing); stats.resolverHits++; return existing; }
    // Reserve the constructor's explicit worst-case cap before allocating it.
    const reservation = Math.min(128 * MiB, resolverBudget);
    while (stats.resolverBytes + reservation > resolverBudget && evictContext()) {}
    const resolver = await createCompleteMaterialResolver(prepared.forPlane(plane), options.materialModule, { maxBytes: reservation });
    check(signal);
    const legacy = createLegacyColorResolver(world, prepared, plane, options.generatorConfig, atlas, legacyPolicy);
    const painter = createBaseForegroundPainter({ materials: resolver, atlas, ownsTerrain: composition.forPlane(plane).ownsTerrain, legacy });
    const prepareScene = createNativeScenePreparer({ atlas, generatorConfig: options.generatorConfig, engineBiomes: BIOME_ENGINE,
      materialNames: MATERIAL_NAMES_BY_ID, wangMaterialIds: WANG_COLOR_TO_ID as [number, number][],
      fillBiomeMaterials, fillLayerMaterials, biomeBackgroundColors: composition.biomeBackgroundColors,
      biomeForegroundColors: composition.biomeForegroundColors, bands: resolver });
    const value = { resolver, painter, prepareScene };
    contexts.set(plane, value); stats.resolverCreations++;
    stats.resolverBytes += resolver.memoryBytes; stats.resolverPeakBytes = Math.max(stats.resolverPeakBytes, stats.resolverBytes);
    return value;
  }
  async function sceneAt(id: number, ctx: Context, signal?: AbortSignal) {
    const hit = sceneCache.get(id);
    if (hit) { sceneCache.delete(id); sceneCache.set(id, hit); stats.preparedSceneHits++; return hit; }
    stats.preparedSceneMisses++;
    const { scene, layers } = sceneRecords[id], source = await loader.load(scene); check(signal);
    const selected: NativeSceneSource = { ...source, data: layers.mid ? source.data : new Uint8Array(source.data.length),
      visualArt: layers.visual ? source.visualArt : null, backgroundArt: layers.background ? source.backgroundArt : null };
    const result = ctx.prepareScene(scene, selected), bytes = bytesOfScene(result);
    if (bytes > workingBudget) throw new RangeError(`Complete scene exceeds page working budget: ${scene.key}`);
    if (bytes <= sceneBudget) {
      while (stats.preparedSceneBytes + bytes > sceneBudget && sceneCache.size) {
        const oldest = sceneCache.keys().next().value!;
        stats.preparedSceneBytes -= bytesOfScene(sceneCache.get(oldest)!); sceneCache.delete(oldest);
      }
      sceneCache.set(id, result); stats.preparedSceneBytes += bytes;
      stats.preparedScenePeakBytes = Math.max(stats.preparedScenePeakBytes, stats.preparedSceneBytes);
    }
    return result;
  }
  function validateRect(address: CompleteRectAddress) {
    const region = regionMap.get(key(address.horizontal, address.vertical));
    const { x, y, width, height } = address;
    if (!region || ![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 576 || height > 576 ||
        x < region.x || y < region.y || x + width > region.x + region.width || y + height > region.y + region.height)
      throw new RangeError("Invalid complete world page rectangle");
  }
  async function render(address: CompleteRectAddress, signal?: AbortSignal): Promise<CompletedWorldPage> {
    validateRect(address); await checkpoint(signal);
    const { x, y, width, height, vertical } = address, ctx = await context(vertical, signal), plane = composition.forPlane(vertical);
    const selected: PreparedNativeScene[] = [];
    let activeBytes = (width + 64) * (height + 64) * 18 + width * height * 16;
    for (const id of (sceneIndex?.search(x - 32, y - 32, x + width + 32, y + height + 32) ?? []).sort((a, b) => a - b)) {
      const scene = await sceneAt(id, ctx, signal); selected.push(scene); activeBytes += bytesOfScene(scene);
      if (activeBytes > workingBudget) throw new RangeError("Complete page working budget exceeded");
      await checkpoint(signal);
    }
    const selectedMasks = (maskIndex?.search(x, y, x + width, y + height) ?? []).map(id => masks[id]);
    for (const mask of selectedMasks) activeBytes += mask.bits.byteLength + (mask.airBits?.byteLength ?? 0);
    if (activeBytes > workingBudget) throw new RangeError("Complete page working budget exceeded");
    const foreground = ctx.painter.paintRect(x, y, width, height);
    if (foreground.unresolvedCount) {
      const i = foreground.classifications.findIndex(c => c === 255);
      throw new UnresolvedWorldMaterialError(x + i % width, y + Math.floor(i / width), foreground.materialClassifications[i]);
    }
    await checkpoint(signal);
    const checkedMaterial = (wx: number, wy: number) => {
      check(signal);
      const result = ctx.resolver.resolve(wx, wy, 1, 1), classification = result.classifications[0];
      if (classification >= M.unsupportedConfiguration) throw new UnresolvedWorldMaterialError(wx, wy, classification);
      return result.materials[0];
    };
    const compose = createPageComposer({ seed: world.seed, worldWidth: prepared.worldWidth, scenes: selected, staticMasks: selectedMasks,
      liquidSurfaces: plane.liquidSurfaces, materialAt: checkedMaterial,
      readMaterials(wx, wy, w, h, target) {
        check(signal);
        const result = ctx.resolver.resolve(wx, wy, w, h);
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const i = row * w + col;
          if (result.classifications[i] >= M.unsupportedConfiguration) throw new UnresolvedWorldMaterialError(wx + col, wy + row, result.classifications[i]);
          target.data[(target.offset ?? 0) + row * target.stride + col] = result.materials[i];
        }
      },
      ownsTerrain: plane.ownsTerrain, backgroundAt: plane.backgroundAt,
      liquidColor: (id, wx, wy) => materialRGBA(atlas, id, wx, wy),
      sceneAirBackground: plane.sceneAirBackground, edgeStamper: composition.edgeStamper,
      chunkShiftX: plane.chunkShiftX, chunkShiftY: plane.chunkShiftY, skipSeamAt: plane.skipSeamAt,
    });
    const pixels = compose({ x, y, width, height, foreground: foreground.pixels });
    check(signal); stats.pages++; stats.sourceSceneBytes = loader.cacheBytes;
    return { ...address, pixels, sceneCount: selected.length, staticMaskCount: selectedMasks.length };
  }
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue(address: CompleteRectAddress, signal?: AbortSignal) {
    const task = queue.then(() => render(address, signal)).catch(error => {
      if (signal?.aborted || options.signal?.aborted || lifetime.signal.aborted) stats.cancelled++;
      else stats.failures++;
      throw error;
    });
    // Serialize completion only; do not retain the last final RGBA page here.
    queue = task.then(() => undefined, () => undefined); return task;
  }
  function pageRect(address: CompletePageAddress): CompleteRectAddress {
    const region = regionMap.get(key(address.horizontal, address.vertical));
    if (!region || !Number.isSafeInteger(address.column) || !Number.isSafeInteger(address.row) ||
        address.column < 0 || address.row < 0 || address.column >= region.columns || address.row >= region.rows)
      throw new RangeError("Invalid complete world page address");
    return { horizontal: address.horizontal, vertical: address.vertical,
      x: region.x + address.column * pageSize, y: region.y + address.row * pageSize,
      width: Math.min(pageSize, region.width - address.column * pageSize), height: Math.min(pageSize, region.height - address.row * pageSize) };
  }
  const source: CompleteWorldSource = {
    revision: world.revision, seed: world.seed, pageSize, regions: Object.freeze(regions), scope: "terrain-scenes-layer",
    get stats() { return { ...stats, sourceSceneBytes: loader.cacheBytes }; },
    *pageAddresses() {
      check();
      for (const region of [...regions].sort((a, b) => a.vertical - b.vertical || a.horizontal - b.horizontal))
        for (let row = 0; row < region.rows; row++) for (let column = 0; column < region.columns; column++) {
          check();
          yield { horizontal: region.horizontal, vertical: region.vertical, column, row };
        }
    },
    renderPage(address, signal) { return enqueue(pageRect(address), signal); },
    renderRect(address, signal) { return enqueue({ ...address }, signal); },
    async *pages(signal) { for (const address of source.pageAddresses()) { check(signal); yield await source.renderPage(address, signal); } },
    dispose() {
      lifetime.abort(new Error("Complete world source disposed")); contexts.clear(); sceneCache.clear(); loader.clear();
      stats.resolverBytes = 0; stats.preparedSceneBytes = 0;
    },
  };
  return source;
}
