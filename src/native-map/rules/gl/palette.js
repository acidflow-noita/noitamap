// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// GL terrain renderer — global color palette (PERF_PLAN.md Step 2.1).
//
// The GPU samples telescope's assembled `layer.buffer`s as R8 palette indices.
// This module builds the color -> index mapping shared by every layer, plus the
// 256x1 RGBA8 lookup texture data that turns an index back into a drawn color.
//
// Layout (see scripts/gl_scoping_report.md §1a):
//   index 0            AIR       - buffer color #000000, never painted
//   index 1            GRAY_FILL - every r==g==b color except black and white.
//                                  createTileOverlays (image_processing.js:378)
//                                  paints all of them with the *chunk's*
//                                  TILE_FOREGROUND_COLORS entry, so the gray
//                                  level carries no information today and all
//                                  185+ of them share one index.
//   index 2            WHITE     - #ffffff. Kept separate from GRAY_FILL only so
//                                  the engine-vs-telescope "white is air"
//                                  disagreement (report §2) stays a LUT decision
//                                  instead of an atlas rebuild.
//   index 3..          one entry per distinct non-gray buffer color, ascending.
//
// Seed 1 / NG+0 / normal uses 186 of the 256 entries.

import { MATERIAL_COLOR_CONVERSION } from '../potion_config.js';

export const PALETTE_SIZE = 256;
export const AIR_INDEX = 0;
export const GRAY_INDEX = 1;
export const WHITE_INDEX = 2;
export const FIRST_COLOR_INDEX = 3;

// Buffer rows 0..3 are the generator's ignored header (tile_generator.js:86,
// image_processing.js:353). Only rows 4 .. mapH+3 are displayed/uploaded.
export const BUFFER_HEADER_ROWS = 4;

// Alpha channel of the 256x1 LUT doubles as the fragment's paint mode.
export const PALETTE_ALPHA_SKIP = 0;      // air / cleared spawn pixel: discard
export const PALETTE_ALPHA_CHUNK_FG = 1;  // resolve TILE_FOREGROUND_COLORS for the chunk
export const PALETTE_ALPHA_DIRECT = 255;  // paint the LUT color as-is

export const isGrayColor = (c) =>
    ((c >> 16) & 0xff) === ((c >> 8) & 0xff) && ((c >> 8) & 0xff) === (c & 0xff);

/**
 * Collects the distinct RGB values of every layer buffer's displayed rows.
 * @param {Array<object>} layers output of generateBiomeTiles
 * @returns {Set<number>} distinct 0xRRGGBB values
 */
export function collectBufferColors(layers) {
    // 16 MiB scratch stamp: much faster than a Set for ~3.2M pixel probes, and
    // it is released as soon as this function returns.
    const seen = new Uint8Array(1 << 24);
    const colors = new Set();
    for (const layer of layers) {
        const { buffer, width, mapH } = layer;
        if (!buffer) continue;
        for (let y = BUFFER_HEADER_ROWS; y < mapH + BUFFER_HEADER_ROWS; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const s = (row + x) * 3;
                const c = (buffer[s] << 16) | (buffer[s + 1] << 8) | buffer[s + 2];
                if (seen[c]) continue;
                seen[c] = 1;
                colors.add(c);
            }
        }
    }
    return colors;
}

/**
 * Builds the global palette from a set (or array) of buffer colors.
 * @param {Iterable<number>} colors distinct 0xRRGGBB values
 * @returns {{colors: Uint32Array, size: number, index: Map<number, number>,
 *            grayLevels: number[], indexOf: (color:number)=>number}}
 */
export function buildPaletteFromColors(colors) {
    const grayLevels = [];
    const direct = [];
    for (const c of colors) {
        if (c === 0x000000 || c === 0xffffff) continue;
        if (isGrayColor(c)) grayLevels.push(c);
        else direct.push(c);
    }
    grayLevels.sort((a, b) => a - b);
    direct.sort((a, b) => a - b);

    const size = FIRST_COLOR_INDEX + direct.length;
    if (size > PALETTE_SIZE) {
        throw new Error(`GL palette overflow: ${size} entries needed, ${PALETTE_SIZE} available ` +
            `(${direct.length} non-gray colors + ${grayLevels.length} collapsed grays)`);
    }

    const table = new Uint32Array(PALETTE_SIZE);
    const index = new Map();
    table[AIR_INDEX] = 0x000000;
    index.set(0x000000, AIR_INDEX);
    // Representative color only; the real one is resolved per chunk.
    table[GRAY_INDEX] = 0x808080;
    table[WHITE_INDEX] = 0xffffff;
    index.set(0xffffff, WHITE_INDEX);
    for (const c of grayLevels) index.set(c, GRAY_INDEX);
    direct.forEach((c, i) => {
        table[FIRST_COLOR_INDEX + i] = c;
        index.set(c, FIRST_COLOR_INDEX + i);
    });

    return {
        colors: table,
        size,
        index,
        grayLevels,
        indexOf: (color) => index.get(color),
    };
}

/** Convenience: census the layers and build the palette in one call. */
export function buildPalette(layers) {
    return buildPaletteFromColors(collectBufferColors(layers));
}

/**
 * Dense 0xRRGGBB -> index lookup for the atlas conversion pass. Stores
 * `index + 1`, so 0 means "color not in the palette".
 * @returns {Uint8Array} 1<<24 entries
 */
export function buildIndexLookup(palette) {
    const lut = new Uint8Array(1 << 24);
    for (const [color, idx] of palette.index) lut[color] = idx + 1;
    return lut;
}

/**
 * Builds the 256x1 RGBA8 LUT texture data (index -> painted color).
 *
 * Mirrors createTileOverlays (image_processing.js:378-404): a material color
 * wins when recolorMaterials is on, otherwise the raw buffer color is painted
 * unless clearSpawnPixels is set. Grays resolve per chunk instead.
 *
 * @param {object} palette from buildPalette
 * @param {object} [opts]
 * @param {boolean} [opts.recolorMaterials=true]
 * @param {boolean} [opts.clearSpawnPixels=false]
 * @param {'gray'|'air'|'direct'} [opts.whiteMode='gray'] how #ffffff is painted.
 *        'gray'   - telescope's current behavior (chunk foreground color)
 *        'air'    - the engine's rule (ARCHITECTURE_GAME.md: black AND white are air)
 *        'direct' - paint it white
 * @returns {Uint8Array} 256*4 bytes
 */
export function buildPaletteLUT(palette, opts = {}) {
    const recolorMaterials = opts.recolorMaterials ?? true;
    const clearSpawnPixels = opts.clearSpawnPixels ?? false;
    const whiteMode = opts.whiteMode ?? 'gray';

    const lut = new Uint8Array(PALETTE_SIZE * 4);
    const write = (idx, color, alpha) => {
        lut[idx * 4] = (color >> 16) & 0xff;
        lut[idx * 4 + 1] = (color >> 8) & 0xff;
        lut[idx * 4 + 2] = color & 0xff;
        lut[idx * 4 + 3] = alpha;
    };

    write(AIR_INDEX, 0x000000, PALETTE_ALPHA_SKIP);
    write(GRAY_INDEX, palette.colors[GRAY_INDEX], PALETTE_ALPHA_CHUNK_FG);
    write(WHITE_INDEX, 0xffffff,
        whiteMode === 'air' ? PALETTE_ALPHA_SKIP
            : whiteMode === 'direct' ? PALETTE_ALPHA_DIRECT
                : PALETTE_ALPHA_CHUNK_FG);

    for (let i = FIRST_COLOR_INDEX; i < palette.size; i++) {
        const raw = palette.colors[i];
        const material = MATERIAL_COLOR_CONVERSION[raw];
        if (recolorMaterials && material !== undefined) write(i, material, PALETTE_ALPHA_DIRECT);
        else if (clearSpawnPixels) write(i, raw, PALETTE_ALPHA_SKIP);
        else write(i, raw, PALETTE_ALPHA_DIRECT);
    }
    return lut;
}
