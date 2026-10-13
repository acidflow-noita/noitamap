// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { readJson, readBytes } from '../../asset-host';
// GL terrain renderer — per-material texture atlas.
//
// The engine bakes every cell's color at chunk generation:
//     color = materials_gfx/<texture>.png[(x mod w + w) mod w, (y mod h + h) mod h]
// with the cell's absolute world coordinates, or the material's flat color when
// it has no texture (CellFactory_GetCellColor @0x007044a0 — randomize_colors
// defaults to false and nothing in vanilla sets it, verified against live baked
// cell colors). The fragment shader reproduces exactly that: it already has the
// fragment's exact integer world position, so a material only needs its texel
// rect on an atlas texture.
//
// tools/gen_material_atlas.py packs the 131 texture files referenced by
// data/material_data.json into data/material_atlas.{bin,json}; this module
// loads them and derives the two GPU-side lookup tables:
//
//   palette index -> material entry   (buildPaletteMaterialTable)
//   fill chunk    -> material entry   (buildFillMaterialTable)
//
// where a "material entry" is a 1-based index into the atlas rect list (0 = no
// texture -> the shader keeps the flat palette / foreground color).
//
// The .bin is raw RGBA rows rather than a PNG so no browser image decode can
// touch the bytes — byte-exactness against the game is the point.

import { FILL_LAYER_MATERIALS } from '../generator_config.js';
import { MATERIAL_COLOR_LOOKUP, MATERIAL_DATA } from '../potion_config.js';
import { BIOME_MAP_HEIGHT } from './indirection.js';
import { PALETTE_SIZE, FIRST_COLOR_INDEX } from './palette.js';

let _atlas = null;      // {width, height, data, meta, entryCount, entryByMaterial}
let _loadPromise = null;

/** Kicks off (or returns) the one-time fetch of the atlas data. */
export function initMaterialAtlas() {
    return _loadPromise ??= (async () => {
        const [metaResp, binResp] = await Promise.all([
            readJson('data/material_atlas.json').then(value => ({ json: async () => value })),
            readBytes('data/material_atlas.bin').then(value => ({ arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) })),
        ]);
        if (!metaResp.ok || !binResp.ok) throw new Error('material atlas fetch failed');
        const layout = await metaResp.json();
        const data = new Uint8Array(await binResp.arrayBuffer());
        if (data.length !== layout.width * layout.height * 4) {
            throw new Error(`material atlas size mismatch: ${data.length} bytes for ${layout.width}x${layout.height}`);
        }

        // 1-based entry per texture file, in the json's (sorted) key order.
        const files = Object.keys(layout.textures).sort();
        const entryByFile = new Map();
        const meta = new Uint16Array(files.length * 4);
        files.forEach((file, i) => {
            entryByFile.set(file, i + 1);
            meta.set(layout.textures[file], i * 4);   // x, y, w, h
        });

        const entryByMaterial = new Map();
        for (const m of MATERIAL_DATA) {
            if (m.texture && entryByFile.has(m.texture)) {
                entryByMaterial.set(m.name, entryByFile.get(m.texture));
            }
        }

        _atlas = {
            width: layout.width,
            height: layout.height,
            data,
            meta,
            entryCount: files.length,
            entryByMaterial,
        };
        return _atlas;
    })();
}

/** The loaded atlas, or null while the fetch is in flight / failed. */
export function getMaterialAtlas() {
    return _atlas;
}

/** Material entry index (1-based, 0 = no texture) for a material name. */
export function materialAtlasEntry(atlas, name) {
    return (atlas && name && atlas.entryByMaterial.get(name)) || 0;
}

/** Negative-safe modulo, as the engine's texel wrap does it. */
const pmod = (v, m) => ((v % m) + m) % m;

/**
 * The engine's baked cell color for a textured material at absolute world
 * coordinates: materials_gfx/<texture>.png[(x mod w + w) mod w, ...], the same
 * rule the fragment shader's materialTexel() runs (CellFactory_GetCellColor
 * @0x007044a0).
 *
 * Returns 0xRRGGBB, or -1 for a transparent texel — the engine creates no cell
 * there, so the caller must paint nothing rather than paint black.
 */
export function materialTexelRGB(atlas, entry, worldX, worldY) {
    const m = (entry - 1) * 4;
    const rx = atlas.meta[m], ry = atlas.meta[m + 1], rw = atlas.meta[m + 2], rh = atlas.meta[m + 3];
    const o = ((ry + pmod(worldY, rh)) * atlas.width + (rx + pmod(worldX, rw))) * 4;
    if (atlas.data[o + 3] === 0) return -1;
    return (atlas.data[o] << 16) | (atlas.data[o + 1] << 8) | atlas.data[o + 2];
}

/**
 * Same lookup, but packed 0xAARRGGBB (unsigned) so the texel's own alpha
 * survives; still -1 for a fully transparent texel.
 */
export function materialTexelRGBA(atlas, entry, worldX, worldY) {
    const m = (entry - 1) * 4;
    const rx = atlas.meta[m], ry = atlas.meta[m + 1], rw = atlas.meta[m + 2], rh = atlas.meta[m + 3];
    const o = ((ry + pmod(worldY, rh)) * atlas.width + (rx + pmod(worldX, rw))) * 4;
    const a = atlas.data[o + 3];
    if (a === 0) return -1;
    return ((a << 24) | (atlas.data[o] << 16) | (atlas.data[o + 1] << 8) | atlas.data[o + 2]) >>> 0;
}

/**
 * The texture rect a material's cell color is sampled from, plus the texel this
 * world pixel lands on: { w, h, texelX, texelY, rgba }, rgba as materialTexelRGBA
 * (-1 when the texel is transparent). For the hover tooltip -- the shader does
 * the same arithmetic inline.
 */
export function materialTexelInfo(atlas, entry, worldX, worldY) {
    const m = (entry - 1) * 4;
    const rw = atlas.meta[m + 2], rh = atlas.meta[m + 3];
    return {
        w: rw, h: rh,
        texelX: pmod(worldX, rw), texelY: pmod(worldY, rh),
        rgba: materialTexelRGBA(atlas, entry, worldX, worldY),
    };
}

/** Compositing alpha of a material name (XML color alpha, water 0xA0). */
export function materialAlpha(name) {
    return MATERIAL_ALPHA_BY_NAME.get(name) ?? 255;
}

/** Material entry index for a raw 0xRRGGBB wang color (0 = no texture). */
function entryForWangColor(atlas, raw) {
    const name = MATERIAL_COLOR_LOOKUP[raw.toString(16).padStart(6, '0')];
    return (name && atlas.entryByMaterial.get(name)) || 0;
}

// Compositing alpha of a material name: its XML color's alpha byte (water
// 0xA0), 255 when unknown -- the straight src-over alpha the game's cell grid
// blends with over the background layer.
const MATERIAL_ALPHA_BY_NAME = new Map();
for (const m of MATERIAL_DATA) {
    if (m.color) MATERIAL_ALPHA_BY_NAME.set(m.name, (parseInt(m.color, 16) >>> 24) & 0xff);
}

/**
 * A textured material's compositing alpha when drawn flat (zoomed out, or the
 * texel detail toggle off): the mean alpha over its whole texture rect, so the
 * flat cell is as see-through on average as its texels. The XML color alpha is
 * no stand-in -- ice and glass are FF there, but their texels are 84 and 183.
 */
const meanAlphaByEntry = new Map();
export function atlasEntryMeanAlpha(atlas, entry) {
    let mean = meanAlphaByEntry.get(entry);
    if (mean !== undefined) return mean;
    const [x, y, w, h] = atlas.meta.subarray((entry - 1) * 4, entry * 4);
    let sum = 0;
    for (let py = y; py < y + h; py++) {
        for (let o = (py * atlas.width + x) * 4 + 3, px = 0; px < w; px++, o += 4) sum += atlas.data[o];
    }
    mean = w * h ? Math.round(sum / (w * h)) : 255;
    meanAlphaByEntry.set(entry, mean);
    return mean;
}

/** A material's flat compositing alpha: textured -> mean texel alpha, else its XML alpha. */
export function materialFlatAlpha(atlas, name) {
    const entry = materialAtlasEntry(atlas, name);
    return entry > 0 ? atlasEntryMeanAlpha(atlas, entry) : materialAlpha(name);
}

/**
 * 256x2 R8UI: palette index -> material entry (row 0) and flat compositing
 * alpha (row 1, materialFlatAlpha). Direct color entries resolve through their
 * wang color; air / gray / white stay entry 0 (no texture), alpha 255.
 */
export function buildPaletteMaterialTable(atlas, palette) {
    const table = new Uint8Array(PALETTE_SIZE * 2).fill(0);
    table.fill(255, PALETTE_SIZE);
    for (let i = FIRST_COLOR_INDEX; i < palette.size; i++) {
        const raw = palette.colors[i] & 0xffffff;
        table[i] = entryForWangColor(atlas, raw);
        const name = MATERIAL_COLOR_LOOKUP[raw.toString(16).padStart(6, '0')];
        if (name) table[PALETTE_SIZE + i] = materialFlatAlpha(atlas, name);
    }
    return table;
}

/**
 * mapWidth x 48 R8UI: fill chunk -> material entry of its fill material.
 * Mirrors buildChunkTextures' CHUNK_FLAG_FILL set (FILL_LAYER_MATERIALS), so a
 * fill chunk's flat foreground color and its texture entry always describe the
 * same material.
 */
export function buildFillMaterialTable(atlas, biomeData, mapWidth) {
    const table = new Uint8Array(mapWidth * BIOME_MAP_HEIGHT);
    for (let i = 0; i < table.length; i++) {
        const color = (biomeData.pixels[i] ?? 0) & 0xffffff;
        const material = FILL_LAYER_MATERIALS[color];
        if (material === undefined) continue;
        table[i] = atlas.entryByMaterial.get(material) ?? 0;
    }
    return table;
}
