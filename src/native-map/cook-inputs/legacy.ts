import type { NativeAssets } from "../asset-host.ts";
import type { NativeTerrainDescription } from "../world.ts";
import { decodePngToRgba } from "../png.ts";
import { claimedChunks } from "./lattice.mjs";
import { createLegacyBiomeSampler, DEFAULT_LEGACY_EDGE_EXCEPTIONS } from "./legacy-biome.mjs";
import { fillMaterialsByBiome, type CookGeneratorConfig, type PreparedMaterialInputs, type VerticalPlane } from "./materials.ts";
import { materialAlpha, materialFlatAlpha, materialTexelRGBA, type NativeMaterialAtlas } from "./atlas.ts";

export interface LegacyColorPolicy {
  /** Exact image_processing foreground map, including the pinned overrides. */
  foregroundColors: ReadonlyMap<number, number>;
  noiseFlags: ReadonlyMap<number, number>;
  edgeNoiseExceptions: ReadonlySet<string>;
  enableEdgeNoise: boolean;
}
export interface LegacyColorResolver {
  /** Raw source color path. Air here is an explicit legacy result. */
  colorAt(x: number, worldY: number): number;
}
const mod = (n: number, size: number) => ((n % size) + size) % size;
const rgba = (rgb: number, alpha = 255) => ((alpha << 24) | (rgb & 0xffffff)) >>> 0;
const chunkAtRasterTile = (tile: number) => tile >= 0 ? Math.ceil((tile + 1) * 10 / 512) - 1 : Math.floor(tile * 10 / 512);

/** Reads the same reference map images and edge flags without module globals. */
export async function loadLegacyColorPolicy(assets: NativeAssets): Promise<LegacyColorPolicy> {
  const [baseBytes, foregroundBytes, flagBytes] = await Promise.all([
    assets.read("data/biome_impl/biome_map.png"), assets.read("data/biome_impl/biome_map_foreground.png"),
    assets.read("data/biome_flags.json"),
  ]);
  const base = decodePngToRgba(Uint8Array.from(baseBytes).buffer);
  const foreground = decodePngToRgba(Uint8Array.from(foregroundBytes).buffer);
  if (base.width !== foreground.width || base.height !== foreground.height)
    throw new Error("Foreground lookup images have different dimensions");
  const foregroundColors = new Map<number, number>();
  for (let i = 0; i < base.data.length; i += 4) {
    const rgb = (data: Uint8ClampedArray) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    foregroundColors.set(rgb(base.data), rgb(foreground.data));
  }
  // createBiomeColorLookup applies these to both foreground and background maps.
  for (const [color, rgb] of [
    [0x93cb4f, 0x4e4132], [0x93cb5a, 0x4e4133], [0x42244d, 0x2b1914],
    [0x5f8fab, 0x2b1914], [0x24888a, 0x454341], [0x18d6d6, 0x454341],
    [0xd6d8e3, 0x0f121c], [0xcc9944, 0x201a14], [0x157cb5, 0x1d1714],
    [0x57dace, 0x1d1714], [0x3d3e41, 0x1d1714],
  ]) foregroundColors.set(color, rgb);
  const flags = JSON.parse(new TextDecoder().decode(flagBytes));
  if (!Array.isArray(flags.biomes)) throw new Error("Invalid biome noise flags");
  const noiseFlags = new Map<number, number>();
  for (const biome of flags.biomes) noiseFlags.set(parseInt(biome.color, 16) & 0xffffff, biome.noise_biome_edges ?? 1);
  return { foregroundColors, noiseFlags, edgeNoiseExceptions: new Set(DEFAULT_LEGACY_EDGE_EXCEPTIONS), enableEdgeNoise: true };
}

/** Pure cpu-terrain-core rawColorAt port. Reading the source RGB layer directly
 * preserves its palette result without constructing a graphics index atlas. */
export function createLegacyColorResolver(
  world: NativeTerrainDescription, prepared: PreparedMaterialInputs, plane: VerticalPlane,
  generatorConfig: CookGeneratorConfig, atlas: NativeMaterialAtlas, policy: LegacyColorPolicy,
): LegacyColorResolver {
  const width = prepared.mapWidth, offsetY = plane * 24576;
  const pixels = Uint32Array.from(prepared.forPlane(plane).biomePixels);
  const biomeData = {
    pixels, heavenPixels: plane === 0 ? Uint32Array.from(prepared.forPlane(-1).biomePixels) : pixels,
    hellPixels: plane === 0 ? Uint32Array.from(prepared.forPlane(1).biomePixels) : pixels,
  };
  const biomeNamesByColor = new Map<number, string>();
  const tileColors = new Set<number>();
  for (const [name, conf] of Object.entries(generatorConfig)) {
    biomeNamesByColor.set(conf.color & 0xffffff, name);
    if (conf.wangFile != null) tileColors.add(conf.color & 0xffffff);
  }
  const fillNames = fillMaterialsByBiome(generatorConfig);
  const sampler = createLegacyBiomeSampler({ biomeNamesByColor, noiseFlagsByColor: new Map(policy.noiseFlags), edgeNoiseExceptions: new Set(policy.edgeNoiseExceptions) });
  const fillEntries = new Uint8Array(width * 48), foreground = new Uint32Array(width * 48);
  const foregroundDefined = new Uint8Array(width * 48), fill = new Uint8Array(width * 48), hasTiles = new Uint8Array(width * 48);
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i] & 0xffffff, name = fillNames.get(color);
    let rgb = policy.foregroundColors.get(color);
    if (name !== undefined) {
      const wang = parseInt(atlas.materialWangColors[name], 16) & 0xffffff;
      rgb = atlas.materialColorConversion[wang] ?? wang;
      fillEntries[i] = atlas.entryByMaterial.get(name) ?? 0;
    }
    foregroundDefined[i] = Number(rgb !== undefined);
    fill[i] = Number(rgb !== undefined && name !== undefined);
    foreground[i] = rgb === undefined ? 0 : rgba(rgb, fill[i] ? materialAlpha(atlas, name!) : 255);
    hasTiles[i] = Number(tileColors.has(color));
  }
  const regions = world.tileLayers.filter(layer => layer.buffer).map(layer => {
    if (!Number.isSafeInteger(layer.correctedX) || !Number.isSafeInteger(layer.correctedY))
      throw new Error("Raw layer is missing its exact raster origin");
    return { layer, worldOriginX: layer.correctedX - prepared.centerPx - 5, worldOriginY: layer.correctedY - 7168 - 5 };
  });
  const slots = new Int32Array(width * 48).fill(-1);
  // Source indirection uses the MAIN map even for Heaven/Hell and chooses the
  // first matching region. Lattice population independently uses last writes.
  for (let slot = 0; slot < regions.length; slot++)
    for (const [cx, cy] of claimedChunks(regions[slot].layer, width, 48)) {
      const index = cy * width + cx;
      if (slots[index] < 0 && biomeNamesByColor.get(prepared.sourceBiomePixels[index] & 0xffffff) === regions[slot].layer.biomeName)
        slots[index] = slot;
    }
  const texture = (entry: number, x: number, y: number) => {
    const value = materialTexelRGBA(atlas, entry, x, y);
    return value < 0 ? 0 : value;
  };
  const isNGP = world.ngPlus > 0, gameMode = world.gameMode, enableEdgeNoise = policy.enableEdgeNoise;
  return {
    colorAt(x, worldY) {
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(worldY)) throw new RangeError("Invalid raw color coordinate");
      const y = worldY - offsetY;
      if (y < -7168 || y >= 17408) return 0;
      const biome = sampler.getTileOverlayBiome(biomeData, x, y, isNGP, gameMode, enableEdgeNoise);
      const chunk = Math.min(47, Math.max(0, biome.pos.y)) * width + mod(biome.pos.x, width);
      if (fill[chunk]) return fillEntries[chunk] ? texture(fillEntries[chunk], x, worldY) : foreground[chunk];
      if (biome.edgeNoiseIgnored || !hasTiles[chunk]) return 0;
      const pw = Math.floor((x + prepared.centerPx) / prepared.worldWidth), sx = x - pw * prepared.worldStride;
      const rx = mod(chunkAtRasterTile(Math.floor((sx + prepared.centerPx + 5) / 10)), width);
      const ry = Math.min(47, Math.max(0, chunkAtRasterTile(Math.floor((y + 7168 + 5) / 10))));
      const slot = slots[ry * width + rx];
      if (slot < 0) return 0;
      const { layer, worldOriginX, worldOriginY } = regions[slot];
      const lx = mod(Math.floor((sx - worldOriginX) / 10), layer.width);
      const ly = mod(Math.floor((y - worldOriginY) / 10), layer.mapH);
      const source = ((ly + 4) * layer.width + lx) * 3;
      const r = layer.buffer[source], g = layer.buffer[source + 1], b = layer.buffer[source + 2];
      const raw = (r << 16) | (g << 8) | b;
      if (raw === 0) return 0;
      if (r === g && g === b) return foregroundDefined[chunk] ? foreground[chunk] : 0;
      const converted = atlas.materialColorConversion[raw];
      if (converted === undefined) return 0; // Current CPU clearSpawnPixels=true.
      const name = atlas.materialColorLookup[raw.toString(16).padStart(6, "0")];
      const entry = name ? atlas.entryByMaterial.get(name) ?? 0 : 0;
      return entry ? texture(entry, x, worldY) : rgba(converted, name ? materialFlatAlpha(atlas, name) : 255);
    },
  };
}
