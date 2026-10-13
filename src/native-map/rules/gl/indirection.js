// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// GL terrain renderer — region metadata + chunk indirection (PERF_PLAN.md Step 2.1).
//
// Region metadata pairs each atlas rect with the world coordinate of its buffer
// pixel (0,0), so the shader can do the engine's whole-image mod-wrap:
//
//   localX = pmod(floor((worldX - region.worldOriginX) / 10), region.width)
//   localY = pmod(floor((worldY - region.worldOriginY) / 10), region.mapH)
//   index  = texelFetch(atlas, ivec2(region.atlasX + localX, region.atlasY + localY), 0).r
//
// The anchor is `correctedX - CHUNK_SIZE*getWorldCenter + VISUAL_TILE_OFFSET_X`
// / `correctedY - 14*CHUNK_SIZE + VISUAL_TILE_OFFSET_Y`, verified exhaustively
// against tileToWorldCoordinates for all 70x48 chunk bases x {normal,nightmare}
// x {NG0, NG+} (scripts/gl_scoping_report.md §1b).
//
// The chunk indirection is a mapWidth x 48 table of region slots. Heaven and
// hell need no variants: biome_generator.js:309-315 builds heavenPixels as row 0
// of the normal map broadcast to all rows and hellPixels as row 47, so the
// shader clamps the chunk row instead of switching maps (report §5/§6).

import { CHUNK_SIZE, TILE_SIZE, VISUAL_TILE_OFFSET_X, VISUAL_TILE_OFFSET_Y, WORLD_CHUNK_CENTER_Y } from '../constants.js';
import { BIOME_COLOR_TO_NAME, BIOME_COLORS_WITH_TILES, GENERATOR_CONFIG } from '../generator_config.js';
import { edgeNoiseOverlayExceptions, transparentBackgroundExceptions } from '../image_processing.js';
import { getWorldCenter, getWorldSize } from '../utils.js';

/** The biome map is always 48 chunks tall; only its width changes with NG+/nightmare. */
export const BIOME_MAP_HEIGHT = 48;
// Inlined at image_processing.js:104 / :107, utils.js:178-181 and :307-308.
export const HEAVEN_WORLD_Y = -14 * CHUNK_SIZE;
export const HELL_WORLD_Y = 34 * CHUNK_SIZE;

/** Slot value meaning "no wang layer covers this chunk" -> draw the biome background. */
export const NO_REGION = 0xffff;

export const CHUNK_FLAG_HAS_TILES = 1 << 0;          // BIOME_COLORS_WITH_TILES
export const CHUNK_FLAG_EDGE_NOISE_EXCEPTION = 1 << 1; // edgeNoiseOverlayExceptions

export const REGION_FLAG_STATIC = 1 << 0;             // generateStaticTile layer (no validChunks)
export const REGION_FLAG_EDGE_NOISE_EXCEPTION = 1 << 1;
export const REGION_FLAG_TRANSPARENT_BACKGROUND = 1 << 2;

const pmod = (a, b) => ((a % b) + b) % b;

/**
 * Builds the per-region metadata table, one entry per layer that has an atlas rect.
 *
 * @param {Array<object>} layers output of generateBiomeTiles
 * @param {Array<object|null>} rects atlas rects, aligned to `layers`
 * @param {object} [opts] { isNGP, gameMode }
 * @returns {Array<object>} regions; `layerIndex` maps back to `layers`
 */
export function buildRegionTable(layers, rects, opts = {}) {
    const isNGP = opts.isNGP ?? false;
    const gameMode = opts.gameMode ?? 'normal';
    const centerPx = CHUNK_SIZE * getWorldCenter(isNGP, gameMode);

    const regions = [];
    for (let i = 0; i < layers.length; i++) {
        const rect = rects[i];
        if (!rect) continue;
        const layer = layers[i];
        const isStatic = !layer.validChunks;
        let flags = 0;
        if (isStatic) flags |= REGION_FLAG_STATIC;
        if (edgeNoiseOverlayExceptions.has(layer.biomeName)) flags |= REGION_FLAG_EDGE_NOISE_EXCEPTION;
        if (transparentBackgroundExceptions.has(layer.biomeName)) flags |= REGION_FLAG_TRANSPARENT_BACKGROUND;
        regions.push({
            slot: regions.length,
            layerIndex: i,
            biomeName: layer.biomeName,
            biomeColor: (GENERATOR_CONFIG[layer.biomeName]?.color ?? 0) & 0xffffff,
            atlasX: rect.x,
            atlasY: rect.y,
            width: layer.width,
            mapH: layer.mapH,
            worldOriginX: layer.correctedX - centerPx + VISUAL_TILE_OFFSET_X,
            worldOriginY: layer.correctedY - WORLD_CHUNK_CENTER_Y * CHUNK_SIZE + VISUAL_TILE_OFFSET_Y,
            flags,
        });
    }
    return regions;
}

/**
 * Chunk cell for a world position, with the heaven/hell row clamp folded in.
 * Equivalent to getUnwobbledTileOverlayBiome's map selection + cell math
 * (image_processing.js:102-129).
 */
export function chunkCellAtWorld(worldX, worldY, mapWidth) {
    const worldWidth = mapWidth * CHUNK_SIZE;
    const x = Math.floor(pmod(worldX + worldWidth / 2, worldWidth) / CHUNK_SIZE);
    if (worldY < HEAVEN_WORLD_Y) return { x, y: 0 };
    if (worldY > HELL_WORLD_Y) return { x, y: BIOME_MAP_HEIGHT - 1 };
    const mapY = pmod(worldY + WORLD_CHUNK_CENTER_Y * CHUNK_SIZE, BIOME_MAP_HEIGHT * CHUNK_SIZE);
    return { x, y: Math.floor(mapY / CHUNK_SIZE) };
}

/** Chunks a layer claims: its region chunks, or the image span for static layers. */
function claimedChunks(layer, mapWidth) {
    const out = [];
    if (layer.validChunks) {
        for (const key of layer.validChunks) {
            const comma = key.indexOf(',');
            const cx = parseInt(key.substring(0, comma), 10);
            const cy = parseInt(key.substring(comma + 1), 10);
            if (cx < 0 || cy < 0 || cx >= mapWidth || cy >= BIOME_MAP_HEIGHT) continue;
            out.push([cx, cy]);
        }
        return out;
    }
    // Static layers are never masked; they span whatever the raw image covers
    // (same rule as app.js buildUnpaintedMask).
    const cx0 = layer.chunkBasePos ? layer.chunkBasePos.x : layer.minX;
    const cy0 = layer.chunkBasePos ? layer.chunkBasePos.y : layer.minY;
    const chunksW = Math.max(1, Math.ceil(layer.w / CHUNK_SIZE));
    const chunksH = Math.max(1, Math.ceil(layer.h / CHUNK_SIZE));
    for (let cy = Math.max(0, cy0); cy < Math.min(BIOME_MAP_HEIGHT, cy0 + chunksH); cy++) {
        for (let cx = Math.max(0, cx0); cx < Math.min(mapWidth, cx0 + chunksW); cx++) out.push([cx, cy]);
    }
    return out;
}

/**
 * Builds the mapWidth x 48 chunk indirection table.
 *
 * A chunk gets a region slot when some layer of *that chunk's biome* covers it;
 * everything else (fill-only biomes, tileless biomes, empty map) gets NO_REGION.
 *
 * @param {object} biomeData from generateBiomeData (uses `pixels` only — heaven
 *        and hell are row 0 / row 47 of it by construction)
 * @param {Array<object>} layers output of generateBiomeTiles
 * @param {Array<object>} regions from buildRegionTable
 * @param {object} [opts] { isNGP, gameMode }
 * @returns {{width:number, height:number, slots:Uint16Array, flags:Uint8Array,
 *            covered:number, conflicts:number}}
 */
export function buildChunkIndirection(biomeData, layers, regions, opts = {}) {
    const isNGP = opts.isNGP ?? false;
    const gameMode = opts.gameMode ?? 'normal';
    const width = getWorldSize(isNGP, gameMode);
    const height = BIOME_MAP_HEIGHT;

    const claims = new Map(); // chunkIndex -> slot[]
    for (const region of regions) {
        for (const [cx, cy] of claimedChunks(layers[region.layerIndex], width)) {
            const key = cy * width + cx;
            const list = claims.get(key);
            if (list) list.push(region.slot);
            else claims.set(key, [region.slot]);
        }
    }

    const slots = new Uint16Array(width * height).fill(NO_REGION);
    const flags = new Uint8Array(width * height);
    let covered = 0, conflicts = 0;

    for (let i = 0; i < width * height; i++) {
        const colorInt = (biomeData.pixels[i] ?? 0) & 0xffffff;
        const biomeName = BIOME_COLOR_TO_NAME[colorInt] || null;
        let f = 0;
        if (BIOME_COLORS_WITH_TILES.has(colorInt)) f |= CHUNK_FLAG_HAS_TILES;
        if (biomeName && edgeNoiseOverlayExceptions.has(biomeName)) f |= CHUNK_FLAG_EDGE_NOISE_EXCEPTION;
        flags[i] = f;

        const candidates = claims.get(i);
        if (!candidates || !biomeName) continue;
        const matching = candidates.filter(s => regions[s].biomeName === biomeName);
        if (matching.length === 0) continue;
        if (matching.length > 1) conflicts++;
        slots[i] = matching[0];
        covered++;
    }

    return { width, height, slots, flags, covered, conflicts };
}

/** Region slot for a world position (chunk lookup + heaven/hell row clamp). */
export function regionSlotAtWorld(indirection, worldX, worldY) {
    const cell = chunkCellAtWorld(worldX, worldY, indirection.width);
    return indirection.slots[cell.y * indirection.width + cell.x];
}

/** The mod-wrapped atlas texel a world position samples inside a region. */
export function regionLocalTexel(region, worldX, worldY) {
    return {
        x: pmod(Math.floor((worldX - region.worldOriginX) / TILE_SIZE), region.width),
        y: pmod(Math.floor((worldY - region.worldOriginY) / TILE_SIZE), region.mapH),
    };
}

/**
 * Packs region metadata for an RGBA32I texture: 2 texels per region.
 *   texel 0: atlasX, atlasY, width, mapH
 *   texel 1: worldOriginX, worldOriginY, flags, biomeColor
 * Texture size is 2 x regions.length (one region per row) so a region's texels
 * are always (0, slot) and (1, slot).
 */
export const REGION_META_TEXELS = 2;

export function packRegionMeta(regions) {
    const data = new Int32Array(regions.length * REGION_META_TEXELS * 4);
    regions.forEach((r, i) => {
        const o = i * 8;
        data[o] = r.atlasX; data[o + 1] = r.atlasY; data[o + 2] = r.width; data[o + 3] = r.mapH;
        data[o + 4] = r.worldOriginX; data[o + 5] = r.worldOriginY; data[o + 6] = r.flags; data[o + 7] = r.biomeColor;
    });
    return data;
}
