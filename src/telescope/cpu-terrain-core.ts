import { cacheMaterialAt } from "./material-cache";
import { buildEngineLattice } from "noita-telescope-full-pixels/engine_resolve/lattice_builder.js";
import { createTerrainComposition } from "./terrain-composition";
import { createPlaneMaterialField } from "./plane-material-field";
import { WORLD_HEIGHT } from "./terrain-policy";
import { compositeTerrain } from "./terrain-backgrounds";
/** CPU execution of render-perf's material resolver and legacy shader fallbacks.
 * Imported only in the terrain worker after Telescope's data shims are installed.
 * All samples are at integer world pixels; the shared pyramid handles reduction.
 */
// @ts-ignore — fork JavaScript is resolved by Vite.
import { createMaterialField } from "noita-telescope-full-pixels/engine_resolve/material_field.js";
// @ts-ignore
import { resolveCellFull } from "noita-telescope-full-pixels/engine_resolve/chunk_wobble.js";
// @ts-ignore
import { BIOME_ENGINE } from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
// @ts-ignore
import {
  buildEngineResources,
  buildMatColorTable,
} from "noita-telescope-full-pixels/gl/engine_resources.js";
// @ts-ignore
import { buildTerrainResources } from "noita-telescope-full-pixels/gl/terrain_resources.js";
// @ts-ignore
import {
  buildChunkTextures,
  CHUNK_FLAG_FILL,
  CHUNK_FLAG_FG_DEFINED,
  CHUNK_FLAG_HAS_TILES,
} from "noita-telescope-full-pixels/gl/chunk_textures.js";
// @ts-ignore
import {
  getMaterialAtlas,
  initMaterialAtlas,
  materialTexelRGBA,
  buildFillMaterialTable,
  buildPaletteMaterialTable,
} from "noita-telescope-full-pixels/gl/material_atlas.js";
// @ts-ignore
import {
  PALETTE_ALPHA_SKIP,
  PALETTE_ALPHA_CHUNK_FG,
  PALETTE_SIZE,
} from "noita-telescope-full-pixels/gl/palette.js";
// @ts-ignore
import { NO_REGION } from "noita-telescope-full-pixels/gl/indirection.js";
// @ts-ignore
import {
  chunkAtRasterTile,
  getTileOverlayBiome,
} from "noita-telescope-full-pixels/image_processing.js";
// @ts-ignore
import { GENERATOR_CONFIG } from "noita-telescope-full-pixels/generator_config.js";
// @ts-ignore
import {
  getWorldSize,
  getWorldCenter,
} from "noita-telescope-full-pixels/utils.js";
// @ts-ignore
import { updateSettings } from "noita-telescope-full-pixels/settings.js";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";

const mod = (value: number, size: number) => ((value % size) + size) % size;
const packed = (r: number, g: number, b: number, a: number) =>
  ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

export async function createCpuTerrain(gen: GLTerrainGeneration) {
  updateSettings({
    recolorMaterials: true,
    clearSpawnPixels: true,
    enableEdgeNoise: true,
  });
  await initMaterialAtlas();
  const materialAtlas = getMaterialAtlas();
  if (!materialAtlas)
    throw new Error("Material textures did not load for CPU terrain");
  const mapWidth = getWorldSize(gen.isNGP, gen.gameMode);
  const centerPx = getWorldCenter(gen.isNGP, gen.gameMode) * 512;
  const worldWidth = mapWidth * 512;
  const worldStride =
    gen.isNGP || gen.gameMode === "nightmare" ? 64 * 512 - 8 : 70 * 512;
  const plane = gen.plane ?? 0,
    offsetY = plane * WORLD_HEIGHT;
  const engine = buildEngineResources(
    gen.tileLayers,
    gen.biomeData,
    GENERATOR_CONFIG,
    mapWidth,
  );
  const field = createMaterialField(
    gen.tileLayers,
    gen.biomeData,
    GENERATOR_CONFIG,
    mapWidth,
    gen.seed,
    { lattice: engine.lattice },
  );
  const planeMaterialAt =
    plane === 0
      ? null
      : createPlaneMaterialField(
          engine.lattice,
          gen.biomeData.pixels,
          mapWidth,
          offsetY,
        );
  const shaftFields = new Map<number, (x: number, y: number) => number>();
  if (plane === 1)
    for (const shaft of gen.elevatorShafts ?? []) {
      // A small region-local lattice, not a second world-sized allocation. Rebase
      // only its storage; lookup noise/materials still use absolute world pixels.
      const local = {
        ...shaft,
        minX: 0,
        minY: 0,
        chunkBasePos: { x: 0, y: 0 },
        validChunks: undefined,
      };
      const lattice = buildEngineLattice(
        [local],
        GENERATOR_CONFIG,
        Math.ceil(shaft.w / 512),
        Math.ceil(shaft.h / 512),
      );
      shaftFields.set(
        shaft.minX,
        createPlaneMaterialField(
          lattice,
          gen.biomeData.pixels,
          mapWidth,
          Math.trunc((shaft.minY * 512) / 10) * 10,
          Math.trunc((shaft.minX * 512) / 10),
        ),
      );
    }
  const resources = buildTerrainResources(
    gen.tileLayers,
    gen.sourceBiomeData ?? gen.biomeData,
    {
      isNGP: gen.isNGP,
      gameMode: gen.gameMode,
      maxTextureSize: 16384,
      lut: { recolorMaterials: true, clearSpawnPixels: true },
    },
  );
  const chunks = buildChunkTextures(gen.biomeData, mapWidth);
  const materials = buildMatColorTable(materialAtlas).data;
  const fillMaterials = buildFillMaterialTable(
    materialAtlas,
    gen.biomeData,
    mapWidth,
  );
  const paletteMaterials = buildPaletteMaterialTable(
    materialAtlas,
    resources.palette,
  );
  const hasNoise = new Map<number, boolean>(
    BIOME_ENGINE.map((biome: any) => [
      biome.color & 0xffffff,
      !!biome.noiseBiomeEdges,
    ]),
  );
  const bmap = {
    w: mapWidth,
    colorAt: (x: number, y: number) =>
      (gen.biomeData.pixels[y * mapWidth + x] ?? 0) & 0xffffff,
  };
  const cell: any = {};
  const noiseEnabled = (color: number) => hasNoise.get(color) ?? false;
  const texture = (entry: number, x: number, y: number) => {
    const rgba = materialTexelRGBA(materialAtlas, entry, x, y);
    return rgba === -1 ? 0 : rgba;
  };
  const foreground = (index: number) => {
    const p = index * 4;
    return packed(
      chunks.fg[p],
      chunks.fg[p + 1],
      chunks.fg[p + 2],
      chunks.fg[p + 3],
    );
  };

  const materialCache = cacheMaterialAt(rawMaterialAt);
  const composition = await createTerrainComposition(
    gen,
    GENERATOR_CONFIG,
    mapWidth,
    materialCache.materialAt,
    engine.lattice,
  );
  const ownership = composition.ownership;
  function rawMaterialAt(x: number, worldY: number): number {
    const y = worldY - offsetY;
    if (y < -7168 || y >= 17408) return 0;
    const shaft = shaftFields.get(
      mod(Math.floor((x + centerPx) / 512), mapWidth),
    );
    if (shaft) return shaft(x, worldY);
    resolveCellFull(bmap, x, plane === 0 ? y : worldY, noiseEnabled, cell);
    const info = engine.chunk[cell.cy * mapWidth + cell.cx];
    if (info & 2048) return 0;
    if (((info >> 8) & 3) === 2) return -1;
    return planeMaterialAt
      ? planeMaterialAt(x, worldY)
      : field.materialAt(x, y);
  }

  function rawColorAt(x: number, y: number, worldY: number): number {
    if (y < -7168 || y >= 17408) return 0; // same supported vertical plane as GL
    const material = materialCache.materialAt(x, worldY);
    if (material === 0) return 0;
    if (material > 0) {
      const p = material * 4,
        entry = materials[p] & 255;
      return entry
        ? texture(entry, x, worldY)
        : packed(
            materials[p + 1],
            materials[p + 2],
            materials[p + 3],
            materials[p] >> 8,
          );
    }
    // Unsupported topology uses the existing legacy path, never a blank tile.
    const biome = getTileOverlayBiome(
      gen.biomeData,
      x,
      y,
      gen.isNGP,
      gen.gameMode ?? "normal",
      true,
    );
    const chunkIndex =
      Math.min(47, Math.max(0, biome.pos.y)) * mapWidth +
      mod(biome.pos.x, mapWidth);
    const flags = chunks.chunk[chunkIndex * 4 + 3];
    if (flags & CHUNK_FLAG_FILL) {
      const entry = fillMaterials[chunkIndex];
      return entry ? texture(entry, x, worldY) : foreground(chunkIndex);
    }
    if (biome.edgeNoiseIgnored || !(flags & CHUNK_FLAG_HAS_TILES)) return 0;
    const pw = Math.floor((x + centerPx) / worldWidth);
    const sx = x - pw * worldStride;
    const rx = mod(
      chunkAtRasterTile(Math.floor((sx + centerPx + 5) / 10)),
      mapWidth,
    );
    const ry = Math.min(
      47,
      Math.max(0, chunkAtRasterTile(Math.floor((y + 7168 + 5) / 10))),
    );
    const slot = resources.indirection.slots[ry * mapWidth + rx];
    if (slot === NO_REGION) return 0;
    const region = resources.regions[slot];
    const lx = mod(Math.floor((sx - region.worldOriginX) / 10), region.width);
    const ly = mod(Math.floor((y - region.worldOriginY) / 10), region.mapH);
    const index =
      resources.atlas.data[
        (region.atlasY + ly) * resources.atlas.width + region.atlasX + lx
      ];
    const p = index * 4,
      mode = resources.paletteLUT[p + 3];
    if (mode === PALETTE_ALPHA_SKIP) return 0;
    if (mode === PALETTE_ALPHA_CHUNK_FG)
      return flags & CHUNK_FLAG_FG_DEFINED ? foreground(chunkIndex) : 0;
    const entry = paletteMaterials[index];
    if (entry) return texture(entry, x, worldY);
    return packed(
      resources.paletteLUT[p],
      resources.paletteLUT[p + 1],
      resources.paletteLUT[p + 2],
      paletteMaterials[PALETTE_SIZE + index],
    );
  }

  function colorAt(x: number, worldY: number): number {
    const y = worldY - offsetY;
    const id = ownership.at(x, y);
    if (id < 0) return 0;
    const color = rawColorAt(x, y, worldY);
    return compositeTerrain(color, composition.backgroundAt(x, worldY));
  }

  return {
    mapWidth,
    centerPx,
    stats: resources.stats,
    edgeStats: composition.edgeStats,
    materialStats: materialCache.stats,
    colorAt,
    contains: composition.contains,
    finish: composition.finish,
    renderRows(
      x: number,
      y: number,
      width: number,
      fromRow: number,
      toRow: number,
      pixels: Uint8ClampedArray,
    ) {
      for (let py = fromRow; py < toRow; py++)
        for (let px = 0; px < width; px++) {
          const wy = y + py,
            ly = wy - offsetY;
          const rgba =
              ownership.at(x + px, ly) < 0 ? 0 : rawColorAt(x + px, ly, wy),
            i = (py * width + px) * 4;
          pixels[i] = (rgba >>> 16) & 255;
          pixels[i + 1] = (rgba >>> 8) & 255;
          pixels[i + 2] = rgba & 255;
          pixels[i + 3] = rgba >>> 24;
        }
    },
  };
}
