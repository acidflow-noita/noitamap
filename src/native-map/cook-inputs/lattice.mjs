// Owned data-input preparation; see NOTICE.txt for source identity.
// Builds Noita's global 1/10-scale coverage + material lattices from
// telescope's own assembled wang layers — the same planes the engine's
// topology-2 per-pixel resolver samples (BiomeChunk+0x1d4).
//
// Port of the engine model in WangTile_ApplyMaterialsToGrid @0x008704c0,
// validated bit-exact against a live COVDUMP (99.9856% of every populated cell
// world-wide; 100.0000% on the validation window — the residual classes are
// region-edge wrap and mask-hidden neighbours, see
// reverse/noita docs/worldgen/covergrid_population.md "Corrections"):
//   per region (= one telescope layer buffer, display rows only):
//     RGB 0x000000                 -> skipped (cov 0, mat 0); black is NOT air
//     RGB in the material table    -> mat = id+1, cov = +1.0 (-1.0 iff id == 0)
//     RGB in the biome's spawn set -> magic pixel; cov 0, mat 0
//     otherwise                    -> density ramp ((g + b) + b)/3 on
//                                     1/255-prenormalised float32 channels
//     then the neighbour-majority post-pass (toroidal, strict-> running max)
//   per chunk: rect copy region -> global at dst = trunc(c*512/10),
//              src = dst - trunc(regionMin*512/10)  (51/52 column alternation)
import {
    BIOME_ENGINE, SPAWN_COLORS_BY_BIOME, WANG_COLOR_TO_ID,
} from '../complete-materials/engine-data.mjs';

const F = Math.fround;
const INV255 = F(1 / 255);
const BUFFER_HEADER_ROWS = 4;
const td = (n) => Math.trunc(n / 10);

const COLOR_TO_ID = new Map(WANG_COLOR_TO_ID);
const SPAWN_BY_BIOME = new Map(SPAWN_COLORS_BY_BIOME.map(([c, list]) => [c, new Set(list)]));
const ALL_SPAWN = new Set();
for (const [, list] of SPAWN_COLORS_BY_BIOME) for (const c of list) ALL_SPAWN.add(c);
const ENGINE_BY_COLOR = new Map(BIOME_ENGINE.map(b => [b.color, b]));

function regionPlanes(layer, spawn) {
    const { buffer, width, mapH } = layer;
    const n = width * mapH;
    const cov = new Float32Array(n), mat = new Uint16Array(n);
    for (let y = 0; y < mapH; y++) {
        const srow = (y + BUFFER_HEADER_ROWS) * width;
        const drow = y * width;
        for (let x = 0; x < width; x++) {
            const s = (srow + x) * 3;
            const g = buffer[s + 1], bl = buffer[s + 2];
            const rgb = (buffer[s] << 16) | (g << 8) | bl;
            if (rgb === 0) continue;
            const id = COLOR_TO_ID.get(rgb);
            if (id !== undefined) { mat[drow + x] = id + 1; cov[drow + x] = id === 0 ? -1 : 1; }
            else if (spawn && spawn.has(rgb)) { /* magic pixel: cov 0, mat 0 */ }
            else {
                const fb = F(bl * INV255), fg = F(g * INV255);
                cov[drow + x] = F(F(F(fg + fb) + fb) / 3);
            }
        }
    }
    neighbourMajority(cov, mat, width, mapH);
    return { cov, mat, width, mapH };
}

// The skipSmoothing post-pass: mat==0 && cov==0 cells take the 4-neighbour
// majority material against a snapshot; neighbour reads wrap toroidally and a
// 2-2 tie goes to the value that REACHED 2 first (strict > running max).
function neighbourMajority(cov, mat, w, h) {
    const out = mat.slice();
    const at = (x, y) => {
        let px = x, py = y;
        if (px < 0) px += (1 - Math.trunc(px / w)) * w;
        if (py < 0) py += (1 - Math.trunc(py / h)) * h;
        if (px >= w) px %= w;
        if (py >= h) py %= h;
        return mat[py * w + px];
    };
    const counts = new Map();
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (mat[i] !== 0 || cov[i] !== 0) continue;
            counts.clear();
            let best = 0, bestN = -1;
            for (const v of [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)]) {
                if (v === 0) continue;
                const c = (counts.get(v) || 0) + 1;
                counts.set(v, c);
                if (c > bestN) { bestN = c; best = v; }
            }
            if (best) out[i] = best;
        }
    }
    mat.set(out);
}

// Mirrors gl/indirection.js claimedChunks.
export function claimedChunks(layer, mapWidth, mapHeight) {
    const out = [];
    if (layer.validChunks) {
        for (const key of layer.validChunks) {
            const comma = key.indexOf(',');
            const cx = parseInt(key.slice(0, comma), 10), cy = parseInt(key.slice(comma + 1), 10);
            if (cx < 0 || cy < 0 || cx >= mapWidth || cy >= mapHeight) continue;
            out.push([cx, cy]);
        }
        return out;
    }
    const cx0 = layer.chunkBasePos ? layer.chunkBasePos.x : layer.minX;
    const cy0 = layer.chunkBasePos ? layer.chunkBasePos.y : layer.minY;
    const cw = Math.max(1, Math.ceil(layer.w / 512)), ch = Math.max(1, Math.ceil(layer.h / 512));
    for (let cy = Math.max(0, cy0); cy < Math.min(mapHeight, cy0 + ch); cy++)
        for (let cx = Math.max(0, cx0); cx < Math.min(mapWidth, cx0 + cw); cx++) out.push([cx, cy]);
    return out;
}

/**
 * @param {Array<object>} layers output of generateBiomeTiles (read-only)
 * @param {object} generatorConfig GENERATOR_CONFIG (for the per-biome spawn set)
 * @param {number} mapWidth biome-map width in chunks
 * @param {number} mapHeight biome-map height (48)
 * @returns {{GW:number, GH:number, cov:Float32Array, mat:Uint16Array,
 *            chunkCovered:Uint8Array}} chunkCovered is mapWidth*mapHeight.
 */
export function buildEngineLattice(layers, generatorConfig, mapWidth, mapHeight) {
    const GW = td(mapWidth * 512), GH = td(mapHeight * 512);
    const cov = new Float32Array(GW * GH);
    const mat = new Uint16Array(GW * GH);
    const chunkCovered = new Uint8Array(mapWidth * mapHeight);
    for (const layer of layers) {
        if (!layer.buffer) continue;
        const conf = generatorConfig[layer.biomeName];
        const spawn = SPAWN_BY_BIOME.get((conf?.color ?? 0) & 0xffffff) || ALL_SPAWN;
        const rp = regionPlanes(layer, spawn);
        const rox = td(layer.minX * 512), roy = td(layer.minY * 512);
        for (const [cx, cy] of claimedChunks(layer, mapWidth, mapHeight)) {
            const dx0 = td(cx * 512), dx1 = td((cx + 1) * 512);
            const dy0 = td(cy * 512), dy1 = td((cy + 1) * 512);
            let wrote = false;
            for (let dy = dy0; dy < dy1; dy++) {
                const sy = dy - roy;
                if (sy < 0 || sy >= rp.mapH) continue;
                for (let dx = dx0; dx < dx1; dx++) {
                    const sx = dx - rox;
                    if (sx < 0 || sx >= rp.width) continue;
                    if (dx >= GW || dy >= GH) continue;
                    const di = dy * GW + dx;
                    cov[di] = rp.cov[sy * rp.width + sx];
                    mat[di] = rp.mat[sy * rp.width + sx];
                    wrote = true;
                }
            }
            if (wrote) chunkCovered[cy * mapWidth + cx] = 1;
        }
    }
    return { GW, GH, cov, mat, chunkCovered };
}

export { ENGINE_BY_COLOR };
