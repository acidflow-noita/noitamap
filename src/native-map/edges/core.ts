import type {
  EdgeScene,
  EdgeOptions,
  EdgeExports,
  EdgeInstantiate,
  StampEdges,
} from "./types";
import {
  buildEdgeTablesAsync,
  EDGE_ATLAS_WIDTH,
  EDGE_ATLAS_HEIGHT,
} from "./data";
import { stampEdgeDecals } from "../../../lib/noita-telescope-vm/js/edge_decals.js";
import { BIOME_ENGINE } from "../../../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { EDGE_IMAGES } from "../../../lib/noita-telescope-vm/js/engine_resolve/edge_data.js";
import { resolveCellFull } from "../../../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js";
import { SKIP_SEAM_EDGE_BIOMES } from "../../../lib/noita-telescope-vm/js/pixel_scene_edge_flags.js";
const noise = new Map(
  BIOME_ENGINE.map((b) => [b.color & 0xffffff, b.noiseBiomeEdges !== false]),
);
const seamNoise = (color: number) => noise.get(color) !== false;
const reach =
  1 +
  EDGE_IMAGES.reduce(
    (r, img) =>
      Math.max(
        r,
        img[6] & 2
          ? img[3] >> 1
          : img[6] & 4
            ? img[2] >> 1
            : Math.max(img[2] >> 1, img[3] >> 1),
      ),
    0,
  );
let tables: Awaited<ReturnType<typeof buildEdgeTablesAsync>>;
let tablePromise: ReturnType<typeof buildEdgeTablesAsync> | undefined;
const instantiateDefault: EdgeInstantiate = async (source, imports) => {
  if (source instanceof WebAssembly.Module)
    return WebAssembly.instantiate(source, imports);
  return WebAssembly.instantiate(source, imports);
};
export async function createEdgeStamper(
  bytes: BufferSource | WebAssembly.Module,
  atlas: Uint8Array,
  { instantiate = instantiateDefault }: { instantiate?: EdgeInstantiate } = {},
) {
  const stats = {
    calls: 0,
    fallbacks: 0,
    failures: 0,
    materialBytes: 0,
    sceneBytes: 0,
    lastFailure: undefined as string | undefined,
  };
  const timing = {
    tablesMs: 0,
    compileInstantiateMs: 0,
    initializeMs: 0,
    initializationError: undefined as string | undefined,
  };
  let api: EdgeExports | null = null,
    mem: WebAssembly.Memory | undefined;
  let ptr: number[] = [];
  const eligible = new WeakMap<EdgeScene, boolean>();
  const start = performance.now();
  try {
    if (
      atlas.byteLength !== EDGE_ATLAS_WIDTH * EDGE_ATLAS_HEIGHT * 4 ||
      atlas.byteLength > 1048576
    )
      throw Error("Unsupported edge atlas");
    const before = performance.now(),
      instance = await instantiate(bytes, {});
    api = (
      "instance" in instance ? instance.instance.exports : instance.exports
    ) as EdgeExports;
    if (api.abi_version() !== 1) throw Error("Unsupported native edge ABI");
    mem = api.memory;
    timing.compileInstantiateMs = performance.now() - before;
    if (mem.buffer.byteLength !== 16777216)
      throw Error("Invalid native edge memory size");
    const t = performance.now();
    tables = await (tablePromise ??= buildEdgeTablesAsync());
    timing.tablesMs = performance.now() - t;
    if (
      tables.materialCount > 1024 ||
      tables.entryCount > 256 ||
      tables.imageCount > 512 ||
      tables.imageIndices.length > 4096
    )
      throw Error("Unsupported edge tables");
    ptr = Array.from({ length: 14 }, (_, i) => api!.buffer_ptr(i));
    const fields = [
      "materialTable",
      "entryTable",
      "entryPercent",
      "imageIndices",
      "imageTable",
      "rayOx",
      "rayOy",
      "normalAngles",
    ] as const;
    for (let i = 0; i < fields.length; i++) {
      const a = tables[fields[i]];
      new Uint8Array(mem!.buffer, ptr[i], a.byteLength).set(
        new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      );
    }
    new Uint8Array(mem!.buffer, ptr[8], atlas.byteLength).set(atlas);
    if (
      !api.configure(
        tables.materialCount,
        tables.entryCount,
        tables.imageCount,
        EDGE_ATLAS_WIDTH,
        reach,
      )
    )
      throw Error("Core configure failed");
  } catch (error) {
    api = null;
    stats.failures++;
    timing.initializationError = String(error);
  }
  timing.initializeMs = performance.now() - start;
  const sceneEligible = (scene: EdgeScene) => {
    if (scene.edgeEligible !== undefined) return !!scene.edgeEligible;
    let value = eligible.get(scene);
    if (value !== undefined) return value;
    value = false;
    for (let p = 0; p < scene.width * scene.height; p++) {
      const id = scene.grid[p];
      if (id <= 0 || id >= tables.materialCount) continue;
      if (scene.artMask && scene.artMask[p >> 3] & (0x80 >> (p & 7))) continue;
      if (tables.materialTable[id * 3 + 1]) {
        value = true;
        break;
      }
    }
    eligible.set(scene, value);
    return value;
  };
  const supported = (
    mat: Int16Array,
    w: number,
    h: number,
    x: number,
    y: number,
    opts: EdgeOptions,
  ) =>
    mat instanceof Int16Array &&
    w >= 1 &&
    h >= 1 &&
    w <= 640 &&
    h <= 640 &&
    mat.length === w * h &&
    [
      w,
      h,
      x,
      y,
      opts.chunkShiftX || 0,
      opts.chunkShiftY || 0,
      opts.inset || 0,
    ].every(Number.isSafeInteger) &&
    Math.abs(x) < 0x3ffff000 &&
    Math.abs(y) < 0x3ffff000 &&
    Math.abs(opts.chunkShiftX || 0) < 512 &&
    Math.abs(opts.chunkShiftY || 0) < 512 &&
    Math.abs(opts.inset || 0) <= 640 &&
    (opts.scenes ?? []).every(
      (s) =>
        [s.x, s.y, s.width, s.height].every(Number.isSafeInteger) &&
        s.width >= 0 &&
        s.height >= 0 &&
        s.width < 0x3ffff000 &&
        s.height < 0x3ffff000 &&
        s.grid instanceof Int16Array &&
        s.grid.buffer !== mat.buffer &&
        s.artMask?.buffer !== mat.buffer &&
        s.grid.length === s.width * s.height &&
        Math.abs(s.x) < 0x3ffff000 &&
        Math.abs(s.y) < 0x3ffff000,
    );
  const referenceStamp = stampEdgeDecals as StampEdges;
  const fallback: StampEdges = (...args) => {
    stats.fallbacks++;
    return referenceStamp(...args);
  };
  return {
    stats,
    timing,
    get enabled() {
      return !!api;
    },
    memoryBytes: mem?.buffer.byteLength ?? 0,
    stamp(
      mat: Int16Array,
      w: number,
      h: number,
      x: number,
      y: number,
      seed: number,
      opts: EdgeOptions = {},
    ) {
      if (!api || !supported(mat, w, h, x, y, opts) || opts.stats)
        return fallback(mat, w, h, x, y, seed, opts);
      try {
        const material = new Int16Array(mem!.buffer, ptr[9], w * h);
        material.set(mat);
        stats.materialBytes += mat.byteLength;
        const skips = new Uint8Array(mem!.buffer, ptr[13], 16);
        skips.fill(0);
        const sx = opts.chunkShiftX || 0,
          sy = opts.chunkShiftY || 0;
        if (opts.biomeData?.pixels && opts.mapWidth) {
          const width = opts.mapWidth,
            pixels = opts.biomeData.pixels,
            bmap = {
              w: width,
              colorAt: (cx: number, cy: number) =>
                (pixels[cy * width + cx] ?? 0) & 0xffffff,
            },
            cell = { color: 0, cx: 0, cy: 0, origColor: 0 };
          const cx0 = Math.floor((x + sx) / 512),
            cy0 = Math.floor((y + sy) / 512),
            cx1 = Math.floor((x + w - 1 + sx) / 512),
            cy1 = Math.floor((y + h - 1 + sy) / 512);
          for (let cy = cy0; cy <= cy1; cy++)
            for (let cx = cx0; cx <= cx1; cx++) {
              resolveCellFull(
                bmap,
                cx * 512 - sx + 256,
                cy * 512 - sy + 256,
                seamNoise,
                cell,
              );
              skips[(cy - cy0) * 4 + cx - cx0] = SKIP_SEAM_EDGE_BIOMES.has(
                cell.color,
              )
                ? 1
                : 0;
            }
        }
        if (!api.start(w, h, x, y, seed >>> 0, sx, sy, opts.inset || 0))
          throw Error("Edge core rejected tile");
        for (const scene of opts.scenes ?? []) {
          const bx = scene.x - x,
            by = scene.y - y;
          const left = Math.max(0, bx),
            top = Math.max(0, by),
            right = Math.min(w, bx + scene.width),
            bottom = Math.min(h, by + scene.height),
            cw = right - left,
            ch = bottom - top;
          if (cw <= 0 || ch <= 0) continue;
          const sourceX = left - bx,
            sourceY = top - by,
            count = cw * ch;
          const sm = new Int16Array(mem!.buffer, ptr[11], count),
            art = new Uint8Array(mem!.buffer, ptr[12], count);
          for (let row = 0; row < ch; row++) {
            const src = (sourceY + row) * scene.width + sourceX,
              dest = row * cw;
            sm.set(scene.grid.subarray(src, src + cw), dest);
            if (scene.artMask)
              for (let col = 0; col < cw; col++) {
                const p = src + col;
                art[dest + col] =
                  scene.artMask[p >> 3] & (0x80 >> (p & 7)) ? 1 : 0;
              }
            else art.fill(0, dest, dest + cw);
          }
          stats.sceneBytes += count * 3;
          if (
            !api.scene(
              scene.x,
              scene.y,
              scene.width,
              scene.height,
              left,
              top,
              cw,
              ch,
              !scene.skipEdges && sceneEligible(scene) ? 1 : 0,
            )
          )
            throw Error("Edge core rejected scene");
        }
        const out = new Uint8ClampedArray(
          mem!.buffer,
          ptr[10],
          w * h * 4,
        ).slice();
        // Commit mutation only after all native stages succeed. Any failure can
        // run the JS path on the original caller input with no partial side effects.
        mat.set(material);
        stats.calls++;
        return out;
      } catch (error) {
        api = null;
        stats.failures++;
        stats.lastFailure = String(error);
        return fallback(mat, w, h, x, y, seed, opts);
      }
    },
  };
}

export type NativeEdgeStamper = Awaited<ReturnType<typeof createEdgeStamper>>;
