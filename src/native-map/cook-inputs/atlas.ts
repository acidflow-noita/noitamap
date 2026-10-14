import {
  MATERIAL_NAMES_BY_ID, MATERIAL_FLAT_RGB_BY_ID, MATERIAL_FLAT_ALPHA_BY_ID,
} from "../complete-materials/engine-data.mjs";
import type { NativeAssets } from "../asset-host.ts";

export interface MaterialRecord {
  name: string;
  color?: string;
  wang: string;
  texture?: string;
  texture_color: string;
  [key: string]: unknown;
}
export interface NativeMaterialAtlas {
  revision: string;
  width: number;
  height: number;
  data: Uint8Array;
  meta: Uint16Array;
  entryCount: number;
  entryByMaterial: ReadonlyMap<string, number>;
  materialByName: ReadonlyMap<string, MaterialRecord>;
  materialColorConversion: Readonly<Record<number, number>>;
  materialColorLookup: Readonly<Record<string, string>>;
  materialWangColors: Readonly<Record<string, string>>;
  materialColors: Readonly<Record<string, number>>;
  materialIdByName: ReadonlyMap<string, number>;
  /** Same [entry | flatAlpha<<8, r,g,b] ID layout as the source CPU renderer. */
  materialTable: Uint16Array;
  meanAlphaByEntry: Uint8Array;
  meanRGBByEntry: Uint32Array;
}
const mod = (n: number, size: number) => ((n % size) + size) % size;
const rgba = (rgb: number, alpha: number) => ((alpha << 24) | (rgb & 0xffffff)) >>> 0;
const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

/** No global loader/cache. These three immutable source assets are explicit. */
export async function loadMaterialAtlas(assets: NativeAssets): Promise<NativeMaterialAtlas> {
  const [metaBytes, binBytes, materialBytes] = await Promise.all([
    assets.read("data/material_atlas.json"), assets.read("data/material_atlas.bin"), assets.read("data/material_data.json"),
  ]);
  return createMaterialAtlas(json(metaBytes), binBytes, json(materialBytes), assets.revision);
}
export function createMaterialAtlas(
  layout: { width: number; height: number; textures: Record<string, readonly number[]> },
  bytes: Uint8Array, records: readonly MaterialRecord[], revision: string,
): NativeMaterialAtlas {
  if (!revision || !Number.isSafeInteger(layout.width) || !Number.isSafeInteger(layout.height) ||
      layout.width < 1 || layout.height < 1 || bytes.length !== layout.width * layout.height * 4)
    throw new Error("Invalid material atlas dimensions or revision");
  const files = Object.keys(layout.textures).sort();
  if (files.length > 255) throw new Error("Material atlas exceeds the source's 8-bit entry ABI");
  const data = Uint8Array.from(bytes), meta = new Uint16Array(files.length * 4);
  const entries = new Map<string, number>();
  files.forEach((file, i) => {
    const rect = layout.textures[file], [x, y, w, h] = rect;
    if (rect.length !== 4 || !rect.every(v => Number.isSafeInteger(v) && v >= 0 && v <= 65535) ||
        w < 1 || h < 1 || x + w > layout.width || y + h > layout.height)
      throw new Error(`Invalid material atlas rectangle: ${file}`);
    entries.set(file, i + 1); meta.set(rect, i * 4);
  });
  const entryByMaterial = new Map<string, number>(), materialByName = new Map<string, MaterialRecord>();
  const materialWangColors: Record<string, string> = {}, materialColors: Record<string, number> = {};
  for (const source of records) {
    if (!source.name || typeof source.wang !== "string" || typeof source.texture_color !== "string")
      throw new Error("Invalid material metadata");
    const record = Object.freeze({ ...source });
    materialByName.set(record.name, record);
    materialWangColors[record.name] = record.wang;
    materialColors[record.name] = parseInt(record.texture_color, 16) & 0xffffff;
    if (record.texture && entries.has(record.texture)) entryByMaterial.set(record.name, entries.get(record.texture)!);
  }
  const materialColorConversion: Record<number, number> = {}, materialColorLookup: Record<string, string> = {};
  for (const name of Object.keys(materialWangColors)) {
    materialColorConversion[parseInt(materialWangColors[name], 16) & 0xffffff] = materialColors[name];
    materialColorLookup[materialWangColors[name].toLowerCase().substring(2)] = name;
  }
  const meanAlphaByEntry = new Uint8Array(files.length + 1), meanRGBByEntry = new Uint32Array(files.length + 1);
  for (let entry = 1; entry <= files.length; entry++) {
    const [x, y, w, h] = meta.subarray((entry - 1) * 4, entry * 4);
    let alpha = 0, r = 0, g = 0, b = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const p = (row * layout.width + col) * 4, a = data[p + 3];
      alpha += a;
      if (!a) continue;
      r += data[p] * a; g += data[p + 1] * a; b += data[p + 2] * a;
    }
    meanAlphaByEntry[entry] = Math.round(alpha / (w * h));
    meanRGBByEntry[entry] = alpha ? (Math.round(r / alpha) << 16) | (Math.round(g / alpha) << 8) | Math.round(b / alpha) : 0;
  }
  const materialTable = new Uint16Array(512 * 4);
  MATERIAL_NAMES_BY_ID.forEach((name, id) => {
    const entry = entryByMaterial.get(name) ?? 0;
    const rgb = entry ? meanRGBByEntry[entry] : MATERIAL_FLAT_RGB_BY_ID[id] | 0;
    const alpha = entry ? meanAlphaByEntry[entry] : MATERIAL_FLAT_ALPHA_BY_ID[id] ?? 255;
    materialTable.set([entry | (alpha << 8), (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255], id * 4);
  });
  return {
    revision, width: layout.width, height: layout.height, data, meta, entryCount: files.length,
    entryByMaterial, materialByName, materialColorConversion, materialColorLookup, materialWangColors, materialColors,
    materialIdByName: new Map(MATERIAL_NAMES_BY_ID.map((name, id) => [name, id])),
    materialTable, meanAlphaByEntry, meanRGBByEntry,
  };
}
export function materialTexelRGBA(atlas: NativeMaterialAtlas, entry: number, x: number, y: number): number {
  if (!Number.isInteger(entry) || entry < 1 || entry > atlas.entryCount || !Number.isSafeInteger(x) || !Number.isSafeInteger(y))
    throw new RangeError("Invalid material texel query");
  const p = (entry - 1) * 4;
  const offset = ((atlas.meta[p + 1] + mod(y, atlas.meta[p + 3])) * atlas.width + atlas.meta[p] + mod(x, atlas.meta[p + 2])) * 4;
  const a = atlas.data[offset + 3];
  return a === 0 ? -1 : ((a << 24) | (atlas.data[offset] << 16) | (atlas.data[offset + 1] << 8) | atlas.data[offset + 2]) >>> 0;
}
export function materialAlpha(atlas: NativeMaterialAtlas, name: string): number {
  const color = atlas.materialByName.get(name)?.color;
  return color ? (parseInt(color, 16) >>> 24) & 255 : 255;
}
export function materialFlatAlpha(atlas: NativeMaterialAtlas, name: string): number {
  const entry = atlas.entryByMaterial.get(name) ?? 0;
  return entry ? atlas.meanAlphaByEntry[entry] : materialAlpha(atlas, name);
}
export function materialFlatRGBA(atlas: NativeMaterialAtlas, id: number): number {
  if (!Number.isInteger(id) || id < 0 || id >= MATERIAL_NAMES_BY_ID.length)
    throw new RangeError("Unknown material ID");
  const p = id * 4, t = atlas.materialTable;
  return rgba((t[p + 1] << 16) | (t[p + 2] << 8) | t[p + 3], t[p] >> 8);
}
export function materialRGBA(atlas: NativeMaterialAtlas, id: number, x: number, y: number): number {
  if (id === 0) return 0;
  if (!Number.isInteger(id) || id < 0 || id >= MATERIAL_NAMES_BY_ID.length)
    throw new RangeError("Unknown material ID");
  const entry = atlas.materialTable[id * 4] & 255;
  const color = entry ? materialTexelRGBA(atlas, entry, x, y) : materialFlatRGBA(atlas, id);
  return color === -1 ? 0 : color;
}
