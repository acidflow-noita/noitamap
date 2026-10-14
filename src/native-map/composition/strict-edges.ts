import type { EdgeExports, EdgeInstantiate, EdgeScene } from "../edges/types";
import type { CompositionEdgeStamper, EdgePaintOptions } from "./types";

/** Same ABI layout as edges/data.ts. Tables are explicit immutable resources;
 * rayOx/rayOy/normalAngles must be prepared using the consuming runtime's Math.
 * No Telescope module, settings, implicit asset fetch or fallback is consulted. */
export interface PreparedEdgeTables {
  materialCount: number;
  entryCount: number;
  imageCount: number;
  materialTable: Int32Array;
  entryTable: Int32Array;
  entryPercent: Float64Array;
  imageIndices: Int32Array;
  imageTable: Int32Array;
  rayOx: Float64Array;
  rayOy: Float64Array;
  normalAngles: Float64Array;
}
export interface StrictEdgeResources {
  tables: PreparedEdgeTables;
  atlas: Uint8Array;
  atlasWidth: number;
}

function validateResources({
  tables: t,
  atlas,
  atlasWidth,
}: StrictEdgeResources) {
  if (
    !t ||
    ![t.materialCount, t.entryCount, t.imageCount, atlasWidth].every(
      Number.isSafeInteger,
    ) ||
    t.materialCount < 1 ||
    t.materialCount > 1024 ||
    t.entryCount < 0 ||
    t.entryCount > 256 ||
    t.imageCount < 0 ||
    t.imageCount > 512 ||
    atlasWidth < 1 ||
    !(atlas instanceof Uint8Array) ||
    atlas.byteLength < 4 ||
    atlas.byteLength > 1048576 ||
    atlas.byteLength % (atlasWidth * 4)
  )
    throw new Error("Unsupported prepared edge resources");
  for (const [data, length] of [
    [t.materialTable, t.materialCount * 3],
    [t.entryTable, t.entryCount * 7],
    [t.imageTable, t.imageCount * 7],
  ] as const)
    if (!(data instanceof Int32Array) || data.length !== length)
      throw new Error("Invalid edge integer table");
  for (const [data, length] of [
    [t.entryPercent, t.entryCount],
    [t.rayOx, 16],
    [t.rayOy, 16],
    [t.normalAngles, 65536],
  ] as const)
    if (
      !(data instanceof Float64Array) ||
      data.length !== length ||
      data.some((n) => !Number.isFinite(n))
    )
      throw new Error("Invalid edge floating-point table");
  if (
    !(t.imageIndices instanceof Int32Array) ||
    t.imageIndices.length > 4096 ||
    t.imageIndices.some((id) => id < 0 || id >= t.imageCount)
  )
    throw new Error("Invalid edge image references");
  for (let id = 0; id < t.materialCount; id++) {
    const start = t.materialTable[id * 3],
      count = t.materialTable[id * 3 + 1];
    if (start < 0 || count < 0 || start + count > t.entryCount)
      throw new Error("Invalid material edge entries");
  }
  for (let id = 0; id < t.entryCount; id++) {
    const kind = t.entryTable[id * 7],
      start = t.entryTable[id * 7 + 5],
      count = t.entryTable[id * 7 + 6];
    if (
      start < 0 ||
      count < 0 ||
      start + count > t.imageIndices.length ||
      (kind >= 1 && kind <= 3 && count === 0)
    )
      throw new Error("Invalid edge entry images");
  }
  const atlasHeight = atlas.byteLength / (atlasWidth * 4);
  let reach = 0;
  for (let id = 0; id < t.imageCount; id++) {
    const p = id * 7,
      x = t.imageTable[p],
      y = t.imageTable[p + 1];
    const width = t.imageTable[p + 2],
      height = t.imageTable[p + 3],
      flags = t.imageTable[p + 6];
    if (
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > atlasWidth ||
      y + height > atlasHeight
    )
      throw new Error("Edge image extends beyond its supplied atlas");
    reach = Math.max(
      reach,
      flags & 2
        ? height >> 1
        : flags & 4
          ? width >> 1
          : Math.max(width >> 1, height >> 1),
    );
  }
  return 1 + reach;
}

/** Strict adapter for the existing owned C core. Every failure propagates and
 * caller material mutations commit only after ALL ordered scene passes succeed. */
export async function createStrictEdgeStamper(
  bytes: BufferSource | WebAssembly.Module,
  resources: StrictEdgeResources,
  {
    instantiate = async (source, imports) =>
      source instanceof WebAssembly.Module
        ? WebAssembly.instantiate(source, imports)
        : WebAssembly.instantiate(source, imports),
  }: { instantiate?: EdgeInstantiate } = {},
): Promise<
  CompositionEdgeStamper & {
    memoryBytes: number;
    stats: { calls: number; failures: number };
  }
> {
  const stampReach = validateResources(resources),
    { tables, atlas, atlasWidth } = resources;
  const instance = await instantiate(bytes, {});
  const api = (
    "instance" in instance ? instance.instance.exports : instance.exports
  ) as EdgeExports;
  if (
    api.abi_version() !== 1 ||
    !(api.memory instanceof WebAssembly.Memory) ||
    api.memory.buffer.byteLength !== 16777216
  )
    throw new Error("Unsupported owned edge WASM ABI");
  const memory = api.memory;
  const ptr = Array.from({ length: 14 }, (_, i) => api.buffer_ptr(i));
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
    const data = tables[fields[i]];
    new Uint8Array(memory.buffer, ptr[i], data.byteLength).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  new Uint8Array(memory.buffer, ptr[8], atlas.byteLength).set(atlas);
  if (
    !api.configure(
      tables.materialCount,
      tables.entryCount,
      tables.imageCount,
      atlasWidth,
      stampReach,
    )
  )
    throw new Error("Owned edge core rejected prepared resources");
  const eligibility = new WeakMap<EdgeScene, boolean>();
  const sceneEligible = (scene: EdgeScene) => {
    if (scene.edgeEligible !== undefined) return !!scene.edgeEligible;
    const cached = eligibility.get(scene);
    if (cached !== undefined) return cached;
    let eligible = false;
    for (let p = 0; p < scene.grid.length; p++) {
      const id = scene.grid[p];
      if (
        id > 0 &&
        id < tables.materialCount &&
        tables.materialTable[id * 3 + 1] &&
        !(scene.artMask && scene.artMask[p >> 3] & (0x80 >> (p & 7)))
      ) {
        eligible = true;
        break;
      }
    }
    eligibility.set(scene, eligible);
    return eligible;
  };
  const stats = { calls: 0, failures: 0 };
  let busy = false;
  return {
    stampReach,
    memoryBytes: memory.buffer.byteLength,
    stats,
    stamp(
      mat: Int16Array,
      width: number,
      height: number,
      x: number,
      y: number,
      seed: number,
      options: EdgePaintOptions,
    ) {
      const sx = options.chunkShiftX,
        sy = options.chunkShiftY,
        inset = options.inset;
      if (busy) throw new Error("Owned edge stamper cannot be reentered");
      if (
        !(mat instanceof Int16Array) ||
        mat.length !== width * height ||
        ![width, height, x, y, seed, sx, sy, inset].every(
          Number.isSafeInteger,
        ) ||
        width < 1 ||
        height < 1 ||
        width > 640 ||
        height > 640 ||
        Math.abs(x) >= 0x3ffff000 ||
        Math.abs(y) >= 0x3ffff000 ||
        Math.abs(sx) >= 512 ||
        Math.abs(sy) >= 512 ||
        Math.abs(inset) > 640 ||
        typeof options.skipSeamAt !== "function" ||
        !Array.isArray(options.scenes)
      )
        throw new Error("Unsupported owned edge page inputs");
      for (const scene of options.scenes) {
        const count = scene.width * scene.height;
        if (
          ![scene.x, scene.y, scene.width, scene.height].every(
            Number.isSafeInteger,
          ) ||
          scene.width < 0 ||
          scene.height < 0 ||
          scene.width >= 0x3ffff000 ||
          scene.height >= 0x3ffff000 ||
          Math.abs(scene.x) >= 0x3ffff000 ||
          Math.abs(scene.y) >= 0x3ffff000 ||
          !(scene.grid instanceof Int16Array) ||
          scene.grid.length !== count ||
          scene.grid.buffer === mat.buffer ||
          (scene.artMask &&
            (!(scene.artMask instanceof Uint8Array) ||
              scene.artMask.length !== Math.ceil(count / 8) ||
              scene.artMask.buffer === mat.buffer))
        )
          throw new Error("Unsupported full-scene edge inputs");
      }
      busy = true;
      try {
        const material = new Int16Array(memory.buffer, ptr[9], width * height);
        material.set(mat);
        const skip = new Uint8Array(memory.buffer, ptr[13], 16);
        skip.fill(0);
        const cx0 = Math.floor((x + sx) / 512),
          cy0 = Math.floor((y + sy) / 512);
        const cx1 = Math.floor((x + width - 1 + sx) / 512),
          cy1 = Math.floor((y + height - 1 + sy) / 512);
        for (let cy = cy0; cy <= cy1; cy++)
          for (let cx = cx0; cx <= cx1; cx++) {
            const value = options.skipSeamAt(cx, cy);
            if (typeof value !== "boolean")
              throw new Error(`Unresolved edge seam policy at ${cx},${cy}`);
            skip[(cy - cy0) * 4 + cx - cx0] = value ? 1 : 0;
          }
        if (!api.start(width, height, x, y, seed >>> 0, sx, sy, inset))
          throw new Error("Owned edge core rejected page");
        for (const scene of options.scenes) {
          const bx = scene.x - x,
            by = scene.y - y;
          const left = Math.max(0, bx),
            top = Math.max(0, by);
          const right = Math.min(width, bx + scene.width),
            bottom = Math.min(height, by + scene.height);
          const cw = right - left,
            ch = bottom - top;
          if (cw <= 0 || ch <= 0) continue;
          const sourceX = left - bx,
            sourceY = top - by,
            count = cw * ch;
          const sceneMaterial = new Int16Array(memory.buffer, ptr[11], count);
          const art = new Uint8Array(memory.buffer, ptr[12], count);
          for (let row = 0; row < ch; row++) {
            const src = (sourceY + row) * scene.width + sourceX,
              dest = row * cw;
            sceneMaterial.set(scene.grid.subarray(src, src + cw), dest);
            if (scene.artMask)
              for (let col = 0; col < cw; col++) {
                const p = src + col;
                art[dest + col] =
                  scene.artMask[p >> 3] & (0x80 >> (p & 7)) ? 1 : 0;
              }
            else art.fill(0, dest, dest + cw);
          }
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
            throw new Error("Owned edge core rejected scene");
        }
        const output = new Uint8ClampedArray(
          memory.buffer,
          ptr[10],
          width * height * 4,
        ).slice();
        mat.set(material);
        stats.calls++;
        return output;
      } catch (error) {
        stats.failures++;
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
