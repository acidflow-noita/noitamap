import type { NativeAssets } from "../asset-host";
import { decodePngToRgba } from "../png";
import type { NativeScenePlacement, NativeSceneSource } from "./prepare-scenes";
import {
  nativeSceneSourceDefinitions,
  type NativeSceneSourceDefinition,
} from "./scene-source-definitions";

interface SceneMetadata {
  width: number;
  height: number;
  hasAir: boolean;
  hasBiomeFill: boolean;
  spawns: readonly number[];
  artMask?: readonly number[];
}
export interface LoadedNativeSceneSource extends NativeSceneSource {
  definition: NativeSceneSourceDefinition;
  hasAir: boolean;
  hasBiomeFill: boolean;
  /** Flat x,y,spawn-function-index triples, from the source biome's metadata. */
  spawns: readonly number[];
  /** Full metadata art coverage, MSB-first. Unlike the edge art mask this does
   * not discard coverage over transparent source instructions. */
  metadataArtMask: Uint8Array | null;
}
export interface SceneSourceLoader {
  readonly revision: string;
  readonly definitions: ReadonlyMap<string, NativeSceneSourceDefinition>;
  readonly cacheBytes: number;
  readonly cacheBudget: number;
  load(
    scene: string | Pick<NativeScenePlacement, "key">,
  ): Promise<LoadedNativeSceneSource>;
  clear(): void;
}
export interface SceneSourceLoaderOptions {
  definitions?: ReadonlyMap<string, NativeSceneSourceDefinition>;
  /** Retained decoded sources only. An oversized source is returned uncached. */
  cacheBytes?: number;
}

function validMetadata(
  meta: SceneMetadata | undefined,
  key: string,
): asserts meta is SceneMetadata {
  if (
    !meta ||
    !Number.isSafeInteger(meta.width) ||
    !Number.isSafeInteger(meta.height) ||
    meta.width < 1 ||
    meta.height < 1 ||
    !Number.isSafeInteger(meta.width * meta.height * 4) ||
    typeof meta.hasAir !== "boolean" ||
    typeof meta.hasBiomeFill !== "boolean" ||
    !Array.isArray(meta.spawns) ||
    meta.spawns.length % 3 ||
    !meta.spawns.every(Number.isSafeInteger)
  )
    throw new Error(`Missing or invalid scene metadata: ${key}`);
  for (let i = 0; i < meta.spawns.length; i += 3)
    if (
      meta.spawns[i] < 0 ||
      meta.spawns[i] >= meta.width ||
      meta.spawns[i + 1] < 0 ||
      meta.spawns[i + 1] >= meta.height
    )
      throw new Error(`Scene metadata spawn lies outside its image: ${key}`);
  if (
    meta.artMask !== undefined &&
    (!Array.isArray(meta.artMask) ||
      meta.artMask.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      meta.artMask.reduce((sum, n) => sum + n, 0) !== meta.width * meta.height)
  )
    throw new Error(`Invalid scene metadata art coverage: ${key}`);
}
function artMask(meta: SceneMetadata) {
  if (!meta.artMask) return null;
  const bits = new Uint8Array(Math.ceil((meta.width * meta.height) / 8));
  let p = 0,
    covered = false;
  for (const run of meta.artMask) {
    const end = p + run;
    if (covered) for (; p < end; p++) bits[p >> 3] |= 0x80 >> (p & 7);
    p = end;
    covered = !covered;
  }
  return bits;
}

/** Explicit asset reader, pure PNG decode, no rules-global install or DOM.
 * The metadata revision must match the PNG inputs. Missing/stale inputs fail;
 * the caller applies host filtering/layer policy and budgets prepared instances. */
export async function createSceneSourceLoader(
  assets: NativeAssets,
  options: SceneSourceLoaderOptions = {},
): Promise<SceneSourceLoader> {
  if (!assets.revision || typeof assets.read !== "function")
    throw new Error("Scene sources need explicit revisioned assets");
  const cacheBudget = options.cacheBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(cacheBudget) || cacheBudget < 0)
    throw new Error("Invalid scene source cache budget");
  const document = JSON.parse(
    new TextDecoder().decode(await assets.read("data/pixel_scene_meta.json")),
  );
  if (
    document?.version !== 1 ||
    !document.scenes ||
    typeof document.scenes !== "object"
  )
    throw new Error("Unsupported scene metadata version");
  const metadata = document.scenes as Record<string, SceneMetadata>;
  const definitions = options.definitions ?? nativeSceneSourceDefinitions();
  const cache = new Map<string, LoadedNativeSceneSource>(),
    pending = new Map<string, Promise<LoadedNativeSceneSource>>();
  let bytes = 0,
    epoch = 0;
  const size = (source: LoadedNativeSceneSource) =>
    source.data.byteLength +
    (source.visualArt?.data.byteLength ?? 0) +
    (source.backgroundArt?.data.byteLength ?? 0) +
    (source.metadataArtMask?.byteLength ?? 0);
  const image = async (path: string, preserveTransparentRGB = false) => {
    if (!path.startsWith("data/") || path.includes("..") || /[?#\\]/.test(path))
      throw new Error(`Invalid scene asset path: ${path}`);
    return decodePngToRgba(Uint8Array.from(await assets.read(path)).buffer, {
      preserveTransparentRGB,
    });
  };
  const decode = async (key: string) => {
    const definition = definitions.get(key),
      meta = metadata[key];
    if (!definition) throw new Error(`Missing scene source definition: ${key}`);
    validMetadata(meta, key);
    // recordFromMeta only advertises colors-file art when its metadata mask
    // exists. Background art is independent and retains its native dimensions.
    if (meta.artMask && !definition.visualPath)
      throw new Error(`Scene metadata art has no source path: ${key}`);
    const [base, visualArt, backgroundArt] = await Promise.all([
      image(definition.materialPath, true),
      meta.artMask && definition.visualPath
        ? image(definition.visualPath, true)
        : null,
      definition.backgroundPath ? image(definition.backgroundPath) : null,
    ]);
    if (base.width !== meta.width || base.height !== meta.height)
      throw new Error(`Scene image dimensions disagree with metadata: ${key}`);
    // Same native instruction cleanup as makeBlackTransparent + prescan with
    // clearSpawnPixels=true. Do not clear colored transparent pixels further.
    for (let i = 0; i < base.data.length; i += 4)
      if (!(base.data[i] || base.data[i + 1] || base.data[i + 2]))
        base.data[i + 3] = 0;
    for (let i = 0; i < meta.spawns.length; i += 3) {
      const p = (meta.spawns[i + 1] * base.width + meta.spawns[i]) * 4;
      base.data.fill(0, p, p + 4);
    }
    return {
      ...base,
      definition,
      visualArt,
      backgroundArt,
      skipEdgeTextures: definition.skipEdgeTextures,
      hasAir: meta.hasAir,
      hasBiomeFill: meta.hasBiomeFill,
      spawns: meta.spawns,
      metadataArtMask: artMask(meta),
    };
  };
  return {
    revision: assets.revision,
    definitions,
    cacheBudget,
    get cacheBytes() {
      return bytes;
    },
    load(scene) {
      const key = typeof scene === "string" ? scene : scene.key;
      const ready = cache.get(key);
      if (ready) {
        cache.delete(key);
        cache.set(key, ready);
        return Promise.resolve(ready);
      }
      let work = pending.get(key);
      if (!work) {
        const generation = epoch;
        work = decode(key)
          .then((source) => {
            const length = size(source);
            if (generation === epoch && length <= cacheBudget) {
              while (cache.size && bytes + length > cacheBudget) {
                const oldest = cache.keys().next().value!;
                bytes -= size(cache.get(oldest)!);
                cache.delete(oldest);
              }
              cache.set(key, source);
              bytes += length;
            }
            return source;
          })
          .finally(() => {
            if (pending.get(key) === work) pending.delete(key);
          });
        pending.set(key, work);
      }
      return work;
    },
    clear() {
      epoch++;
      cache.clear();
      bytes = 0;
      pending.clear();
    },
  };
}
