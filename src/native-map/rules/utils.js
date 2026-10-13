// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import {CHUNK_SIZE, TILE_SIZE, WORLD_CHUNK_CENTER_X, WORLD_CHUNK_CENTER_Y, WORLD_CHUNK_CENTER_X_NGP, TILE_OFFSET_X, TILE_OFFSET_Y, VISUAL_TILE_OFFSET_X, VISUAL_TILE_OFFSET_Y} from './constants.js';
import { BIOME_COLOR_TO_NAME, BIOME_COLORS_WITH_TILES } from './generator_config.js';
import { GetBiomeOffset, ComputeMagicValueFromDoubles } from './edge_noise.js';
import { biomeEdgeNoiseFlag } from './wobble_flags.js';
import { MATERIAL_COLOR_LOOKUP } from './potion_config.js';
import { PIXEL_SCENE_DATA, requestScenePixels, sceneDensityClassAt } from './pixel_scene_generation.js';
import { appSettings } from './settings.js';

export const CONTAINER_TYPES = [
    'utility_box',
    'chest',
    'great_chest',
    'holy_mountain_shop',
    'pacifist_chest',
    'eye_room',
    'shop',
    'triangle_boss',
    'alchemist_boss',
    'pyramid_boss',
    'pit_boss',
    'dragon',
    'tiny',
    'laboratory',
    'vault_puzzle',
    'puzzle',
    'starting_loadout',
    'enemies',
    'props',
];

export const MATERIAL_CONTAINER_TYPES = [
    'potion',
    'pouch',
    'jar',
];

// This function is pretty messed up even though it's currently in a working state
export function tileToWorldCoordinates(chunkBaseX, chunkBaseY, tileX, tileY, pw = 0, pwVertical = 0, isNGP = false, gameMode = 'normal') {
    const world_chunk_center_x = (isNGP || gameMode === 'nightmare') ? WORLD_CHUNK_CENTER_X_NGP : WORLD_CHUNK_CENTER_X;
    const worldSize = getWorldStride(isNGP, gameMode);

    let smallChunkSize = Math.floor(CHUNK_SIZE / TILE_SIZE); // 51
    let div5offX = 5 * CHUNK_SIZE * Math.floor((chunkBaseX - world_chunk_center_x)/5);
    let mod5offX = (((chunkBaseX - world_chunk_center_x) % 5 + 5) % 5);
    let worldBaseX = div5offX + mod5offX * smallChunkSize * TILE_SIZE;
    // Not sure why it's still 10 off but it's consistent
    let worldX_alt = -TILE_SIZE + worldBaseX + tileX * TILE_SIZE + TILE_OFFSET_X;
    let div5offY = 5 * CHUNK_SIZE * Math.floor((chunkBaseY - WORLD_CHUNK_CENTER_Y)/5);
    let mod5offY = (((chunkBaseY - WORLD_CHUNK_CENTER_Y) % 5 + 5) % 5);
    let worldBaseY = div5offY + mod5offY * smallChunkSize * TILE_SIZE;
    if (mod5offY > 0) worldBaseY += TILE_SIZE;
    let worldY_alt = -TILE_SIZE + worldBaseY + tileY * TILE_SIZE + TILE_OFFSET_Y;

    // Dumb NG+
    if (isNGP || gameMode === 'nightmare') {
        if (mod5offX >= 3) worldX_alt += TILE_SIZE; // Seems to work?
    }

    // Checking tile offset Y = -13, removes the extra -10 part above
    worldY_alt += TILE_SIZE;

    // Debug: Trying to align tile offsets! Works without this
    // TODO: Remove this if I can't get it to work
    //worldX_alt += TILE_SIZE;
    //worldY_alt += TILE_SIZE;
    
    //let worldX = Math.floor((((chunkBaseX - world_chunk_center_x) * CHUNK_SIZE) - 9 * ((chunkBaseX < world_chunk_center_x) ? 1 : 0)) / 10) * 10 + 10 * tileX + TILE_OFFSET_X;
    //let worldY = Math.floor((((chunkBaseY - WORLD_CHUNK_CENTER_Y) * CHUNK_SIZE) - 9 * ((chunkBaseY < WORLD_CHUNK_CENTER_Y) ? 1 : 0)) / 10) * 10 + 10 * tileY + TILE_OFFSET_Y;
    
    //if (chunkBaseX >= world_chunk_center_x) worldX -= 10;

    //if (worldX != worldX_alt || worldY !== worldY_alt)
    //console.log(chunkBaseX, chunkBaseY, worldX, worldY, worldX_alt, worldY_alt);

    // Apply Parallel World Shift (already done)
    //worldX += (pw * PW_SHIFT);
    //worldX_alt += (pw * PW_SHIFT);

    if (isNGP || gameMode === 'nightmare') {
        worldX_alt -= 4;
    }

    worldX_alt += pw * worldSize;
    worldY_alt += pwVertical * 24570; // Note, 6 pixels off from 512 * 48. Again, vertical chunks aren't divisible by 5...
    // World-shattering change
    return { x: worldX_alt, y: worldY_alt };
}

export function roundRNGPos(num) {
    if (-1000000 < num && num < 1000000)
        return num;
    else if (-10000000 < num && num < 10000000)
        //return Math.round(num / 10.0) * 10;
        return roundHalfOfEven(num / 10.0) * 10;
    else if (-100000000 < num && num < 100000000)
        return roundHalfOfEven(num / 100.0) * 100;
    return num;
}

const WAND_KEYS = [
    'always_casts',
    'wand_type',
    'actions_per_round',
    'fire_rate_wait',
    'reload_time',
    'mana_max',
    'mana_charge_speed',
    'deck_capacity',
    'spread_degrees',
    'speed_multiplier',
    'shuffle_deck_when_empty',
    'sprite'
]

export function isDuplicateObject(currentObj, newObj) {
    if (currentObj.type !== newObj.type) return false;
    if (currentObj.type === 'wand') {
        if (currentObj.cards.length !== newObj.cards.length) return false;
        for (let i = 0; i < currentObj.cards.length; i++) {
            if (currentObj.cards[i] !== newObj.cards[i]) return false;
        }
        for (let key of WAND_KEYS) {
            if (Math.abs(currentObj[key] - newObj[key]) > 0.01) return false;
        }
        return true;
    }
    else {
        if (currentObj.item) {
            if (currentObj.item === 'spell' && newObj.item === 'spell') return currentObj.spell === newObj.spell;
            if (MATERIAL_CONTAINER_TYPES.includes(currentObj.item)) {
                return currentObj.material === newObj.material && currentObj.item === newObj.item;
            }
            else {
                return currentObj.item === newObj.item;
            }
        }
        return false; // Others?
    }
}

export function shuffleTable(arr, prng) {
    for (let i = arr.length - 1; i >= 1; i--) {
        let j = prng.Random(0, i);
        let temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
    }
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// The PW stride: parallel worlds translate world content (scenes, wang
// regions) by this, which in NG+/nightmare is 8px SHORT of the 64-chunk map
// pitch. Biome-map lookups do NOT fold on it: the chunk index is
// (shifted_x >> 9) % mapWidth, so NG+ biome columns drift 8px per world
// against the content. Game-proven on seed 786433191 ng2 vs live MAPDUMPs (NG_PLUS_INIT
// run): pw1/pw2/pw8/pw64 content = main + k*32760 (94-96% air-mask), far
// east at x 16.77M = main + 512*32760 (87%); 35840 and 32768 score noise.
export function getWorldStride(isNGP, gameMode='normal') {
    return (isNGP || gameMode === 'nightmare') ? 64 * 512 - 8 : 70 * 512;
}

export function getWorldSize(isNGP, gameMode='normal') {
    if (gameMode === 'nightmare') return 64;
    return isNGP ? 64 : 70;
}

export function getWorldCenter(isNGP, gameMode='normal') {
    if (gameMode === 'nightmare') return 32;
    return isNGP ? 32 : 35;
}

export function getPWLimit(isNGP, gameMode='normal') {
    if (gameMode === 'nightmare') return 512;
    return isNGP ? 512 : 468;
}

// Scratch buffers for the wobble probes. Not reentrant, but this function never
// recurses, and each worker gets its own module instance.
const PROBE_X = new Int32Array(8);
const PROBE_Y = new Int32Array(8);

const colorIneligible = (color) => biomeEdgeNoiseFlag(color, 'noise_biome_edges') === 0;

// Picks the biome map for a world Y: the map itself, or one of the two row
// broadcasts standing in for the engine's vertical clamp.
//
// BiomeGrid_GetChunkAt clamps the chunk row to [0, 47], so everything above the
// map resolves to row 0 and everything below it to row 47 -- which is exactly what
// biome_generator.js bakes into heavenPixels / hellPixels. Map row y covers world
// Y (y - 14) * 512 ... + 511, so the map owns world Y -7168 ... 17407 and 17408 is
// the *first* row of the hell band. The old `> 34 * 512` test left that one pixel
// row on the main map, where the modulo wrap sent it back to map row 0.
export function bandBiomeMap(biomeData, worldY) {
    if (worldY < -WORLD_CHUNK_CENTER_Y * CHUNK_SIZE) return biomeData.heavenPixels;
    if (worldY >= (48 - WORLD_CHUNK_CENTER_Y) * CHUNK_SIZE) return biomeData.hellPixels;
    return biomeData.pixels;
}

export function getBiomeAtWorldCoordinates(biomeData, worldX, worldY, isNGP = false, gameMode = 'normal', useEdgeNoise = false) {
    const biomeMap = bandBiomeMap(biomeData, worldY);
    const mapWidth = getWorldSize(isNGP, gameMode);
    // Convert to positions mod world size
    const worldSize = mapWidth * 512;
    const worldCenter = worldSize / 2;
    // Fold on the map pitch, as the engine's chunk index does, so the column
    // and the sub-chunk position below come from the same grid.
    const modX = ((worldX + worldCenter) % worldSize + worldSize) % worldSize;
    const modY = ((worldY + 14*512) % 24576 + 24576) % 24576;

    // Account for biome edge noise
    let highDetail = true; // Seems to be required to avoid false negatives...

    // How far into its 512px chunk this pixel sits. Both the edge offset and the
    // wobble probes below only do anything within 42px of a chunk edge.
    const subWX = ((worldX % 512) + 512) % 512;
    const subWY = ((worldY % 512) + 512) % 512;
    const nearEdgeX = subWX < 42 || subWX > 470;
    const nearEdgeY = subWY < 42 || subWY > 470;

    // GetBiomeOffset multiplies its chunk-id difference by signX/signY, which are
    // zero unless the pixel is near a chunk edge - so away from an edge the result
    // is provably {0,0} and the chunk-id work (GetTrueChunkPosIdAt) is wasted.
    // With edge noise off the original code computed it and then threw it away.
    let edgeOffsetX = 0;
    let edgeOffsetY = 0;
    if (useEdgeNoise && (nearEdgeX || nearEdgeY)) {
        const edgeOffset = GetBiomeOffset(worldX, worldY, isNGP, highDetail, gameMode);
        edgeOffsetX = edgeOffset.x;
        edgeOffsetY = edgeOffset.y;
    }

    const originalX = Math.floor(modX / 512);
    const originalY = Math.floor(modY / 512);

    let biomePixelX = originalX + edgeOffsetX;
    let biomePixelY = originalY + edgeOffsetY;

    biomePixelX = ((biomePixelX % mapWidth) + mapWidth) % mapWidth;
    biomePixelY = Math.max(0, Math.min(47, biomePixelY));

    const idx = biomePixelY * mapWidth + biomePixelX;

    const colorInt = biomeMap[idx] & 0xffffff;
    let biomeName = BIOME_COLOR_TO_NAME[colorInt];

    // I wonder what happens if I disable this now. Seems fine?
    // Disabling this should allow the mouseover to show the names of biomes that don't have tiles, at least.
    //if (!BIOME_COLORS_WITH_TILES.has(colorInt)) biomeName = null; // Only return biomes with tiles, otherwise it's just noise that causes false positives

    // Apply edge noise wobble
    const origIdx = originalY * mapWidth + originalX;
    const origColorInt = biomeMap[origIdx] & 0xffffff;
    const origBiomeName = BIOME_COLOR_TO_NAME[origColorInt];
    // Skip the wobble when the source, the wobbled-into chunk, or the first differing-color neighbor has edge noise disabled
    let skipWobble = colorIneligible(origColorInt) || colorIneligible(colorInt);

    if (!skipWobble) {
        // Probe directions in the exact order the engine uses.
        // The first probed neighbor whose biome-map color differs from the original determines the wobble decision
        // If THAT neighbor has edge noise disabled, skip.
        // If NO probed neighbor differs at all, also skip.
        // Probes are written into a reused scratch buffer instead of an array of
        // [x, y] pairs; this runs per pixel of every tile overlay.
        let probeCount = 0;
        if (subWX < 42) { PROBE_X[probeCount] = originalX - 1; PROBE_Y[probeCount] = originalY; probeCount++; }
        if (subWY < 42) { PROBE_X[probeCount] = originalX; PROBE_Y[probeCount] = originalY - 1; probeCount++; }
        if (subWX > 470) { PROBE_X[probeCount] = originalX + 1; PROBE_Y[probeCount] = originalY; probeCount++; }
        if (subWY > 470) { PROBE_X[probeCount] = originalX; PROBE_Y[probeCount] = originalY + 1; probeCount++; }
        if (subWX < 42) {
            if (subWY < 42) { PROBE_X[probeCount] = originalX - 1; PROBE_Y[probeCount] = originalY - 1; probeCount++; }
            if (subWY > 470) { PROBE_X[probeCount] = originalX - 1; PROBE_Y[probeCount] = originalY + 1; probeCount++; }
        }
        if (subWX > 470) {
            if (subWY < 42) { PROBE_X[probeCount] = originalX + 1; PROBE_Y[probeCount] = originalY - 1; probeCount++; }
            if (subWY > 470) { PROBE_X[probeCount] = originalX + 1; PROBE_Y[probeCount] = originalY + 1; probeCount++; }
        }
        let foundDifferingNeighbor = false;
        for (let p = 0; p < probeCount; p++) {
            const pcx = PROBE_X[p], pcy = PROBE_Y[p];
            const ncx = ((pcx % mapWidth) + mapWidth) % mapWidth;
            const ncy = Math.max(0, Math.min(47, pcy));
            const nIdx = ncy * mapWidth + ncx;
            if (nIdx < 0 || nIdx >= biomeMap.length) continue;
            const ncolor = biomeMap[nIdx] & 0xffffff;
            if (ncolor === origColorInt) continue;
            foundDifferingNeighbor = true;
            if (colorIneligible(ncolor)) skipWobble = true;
            break; // only the FIRST differing neighbor counts
        }
        if (probeCount > 0 && !foundDifferingNeighbor) {
            skipWobble = true;
        }
    }

    if (skipWobble) {
        biomePixelX = originalX;
        biomePixelY = originalY;
        biomeName = origBiomeName;
    }
    
    // Store the final color to avoid having to recompute it elsewhere
    const finalColorInt = biomeMap[biomePixelY * mapWidth + biomePixelX] & 0xffffff;

    return {
        biome: biomeName || null,
        origBiome: origBiomeName || null,
        colorInt: finalColorInt,
        pos: {x: biomePixelX, y: biomePixelY},
        originalPos: {x: originalX, y: originalY},
        mightBeEdgeCase: edgeOffsetX !== 0 || edgeOffsetY !== 0
    };
}

// TODO: big_noise_biome_edges missing might still be an issue in some biomes?
export function getResolvedBiome(biomeData, worldX, worldY, isNGP = false, gameMode = 'normal') {
    // Resolve biome at a world position using the same edge gates + wobble branch
    // used by spawn gating code. Returns both raw (origBiome/originalPos) and
    // resolved (biome/pos) chunk info so callers can do a direct gate check:
    // keep only when biome === origBiome.
    //
    // This differs from getBiomeAtWorldCoordinates, which uses GetBiomeOffset()
    // and a simplified +/- chunk-offset path aimed at general biome lookup.
    // getResolvedBiome computes the wobble target chunk directly from the noise
    // branch after eligibility checks.
    const biomeMap = bandBiomeMap(biomeData, worldY);

    const mapWidth = getWorldSize(isNGP, gameMode);
    const mapHeight = 48;
    const shifted_x = worldX + 512 * getWorldCenter(isNGP, gameMode);
    const shifted_y = worldY + 512 * 14;
    const fx = Math.floor(shifted_x);
    const fy = Math.floor(shifted_y);

    const wrapX = (cx) => ((cx % mapWidth) + mapWidth) % mapWidth;
    const clampY = (cy) => (cy < 0 ? 0 : (cy > mapHeight - 1 ? mapHeight - 1 : cy));
    const colorAt = (cx, cy) => biomeMap[clampY(cy) * mapWidth + wrapX(cx)] & 0xffffff;
    const nameOf = (color) => BIOME_COLOR_TO_NAME[color] || null;

    const origCx = wrapX(fx >> 9);
    const origCy = clampY(fy >> 9);
    const origColor = colorAt(origCx, origCy);
    const origName = nameOf(origColor);
    const make = (cx, cy, color) => ({
        biome: nameOf(color),
        origBiome: origName,
        colorInt: color,
        pos: { x: cx, y: cy },
        originalPos: { x: origCx, y: origCy },
    });
    const orig = () => make(origCx, origCy, origColor);

    // Step 4: short-circuit gates on the home biome's edge flags.
    if (biomeEdgeNoiseFlag(origColor, 'noise_biome_edges') === 0) return orig();
    if (biomeEdgeNoiseFlag(origColor, 'fat_biome_edges')) return orig();

    const sub_x = fx & 0x1ff;
    const sub_y = fy & 0x1ff;

    // Step 5: first neighbour (engine probe order) whose biome differs from home.
    let nCx = null, nCy = null;
    const consider = (cx, cy) => {
        if (nCx !== null) return;
        if (colorAt(cx, cy) !== origColor) { nCx = cx; nCy = cy; }
    };
    if (sub_x < 42 && colorAt(origCx - 1, origCy) !== origColor) {
        // engine: when sub_x<42 the LEFT neighbour is probed first; if it differs it is used
        // immediately, otherwise control falls through to the remaining probes below.
        nCx = origCx - 1; nCy = origCy;
    }
    if (nCx === null) {
        if (sub_y < 42) consider(origCx, origCy - 1);   // top
        if (sub_x > 470) consider(origCx + 1, origCy);  // right
        if (sub_y > 470) consider(origCx, origCy + 1);  // bottom
        if (sub_x < 42) {
            if (sub_y < 42) consider(origCx - 1, origCy - 1);
            if (sub_y > 470) consider(origCx - 1, origCy + 1);
        }
        if (sub_x > 470) {
            if (sub_y < 42) consider(origCx + 1, origCy - 1);
            if (sub_y > 470) consider(origCx + 1, origCy + 1);
        }
    }
    if (nCx === null) return orig();
    if (biomeEdgeNoiseFlag(colorAt(nCx, nCy), 'noise_biome_edges') === 0) return orig();

    // Steps 7-8: simplex + sin/cos wobble, with the engine's cross-wired axis swap.
    const simplex = ComputeMagicValueFromDoubles(shifted_x * 0.05, shifted_y * 0.05);
    const dxBranch = Math.cos(shifted_x * 0.005) * 30.0 + simplex * 11.0; // cos on X
    const dyBranch = Math.sin(shifted_y * 0.005) * 30.0 + simplex * 11.0; // sin on Y
    const wCx = wrapX(((dyBranch + shifted_x) | 0) >> 9); // sin/Y branch added to X
    const wCy = clampY(((dxBranch + shifted_y) | 0) >> 9); // cos/X branch added to Y
    const wColor = colorAt(wCx, wCy);
    if (biomeEdgeNoiseFlag(wColor, 'noise_biome_edges') !== 0) return make(wCx, wCy, wColor);
    return orig();
}

export function getMaterialAtWorldCoordinates(tileLayers, pixelScenes, worldX, worldY, pwIndex, pwIndexVertical, isNGP = false, gameMode='normal') {
    return getMaterialProvenanceAtWorldCoordinates(tileLayers, pixelScenes, worldX, worldY, pwIndex, pwIndexVertical, isNGP, gameMode).material;
}

/**
 * Same walk as getMaterialAtWorldCoordinates(), but it reports WHICH stage
 * answered and where in that stage's source image the pixel sits -- what the
 * hover tooltip needs to name the pixel's origin.
 *
 * Returns { material, source, layer, scene, fillLayer, colorHex }:
 *   source     'layer' (wang/static tile buffer) | 'scene' (pixel scene) | null
 *   layer      { biomeName, localX, localY, kind } in wang-buffer cells, or null
 *   scene      { key, name, localX, localY, variantKey } or null
 *   coveringScene  first scene whose footprint covers the pixel, painted or not
 *   fillLayer  the constant-material fill layer covering the pixel, or null
 *   colorHex   the source image's 'rrggbb' at the pixel, or null
 *   densityClass  { biomeName, via } when the answer came from a scene's
 *                 white/gray "fill with the biome's own material" class
 *
 * `fillLayer` is informational ONLY: a fill layer carries no buffer to sample,
 * so it never sets `material`. That keeps getMaterialAtWorldCoordinates()'s
 * "null means no layer/scene content here" contract byte-for-byte unchanged --
 * callers answer fill biomes from the biome map (FILL_LAYER_MATERIALS) instead.
 *
 * A scene's density class is answered by the SAME band lookup the renderer runs
 * to build the instance (pixel_scene_generation.js sceneDensityClassAt), so a
 * solid density pixel names its resolved material instead of falling through to
 * "nothing here" -- which is what it used to do, because the class' colour is a
 * gray no material table knows. That blind spot is what made the orb rooms read
 * as air while the renderer was painting their floors correctly. The band table
 * answering AIR is a real answer and still leaves `material` null, but
 * `densityClass` is set either way so a caller can tell the two apart.
 */
export function getMaterialProvenanceAtWorldCoordinates(tileLayers, pixelScenes, worldX, worldY, pwIndex, pwIndexVertical, isNGP = false, gameMode='normal') {
    const result = { material: null, source: null, layer: null, scene: null, coveringScene: null, fillLayer: null, colorHex: null, densityClass: null };
    // Adjust for PW
    const adjustedWorldX = getWorldCenter(isNGP, gameMode) * 512 + worldX - pwIndex * getWorldSize(isNGP, gameMode) * 512 + (isNGP || gameMode === 'nightmare' ? -8 * pwIndex : 0) - VISUAL_TILE_OFFSET_X;
    const adjustedWorldY = 14 * 512 + worldY - pwIndexVertical * 24570 - VISUAL_TILE_OFFSET_Y;
    for (const layer of tileLayers) {
        // Check if the world coordinate falls within this layer's bounds
        // (Assuming layer.x/y are in world units)
        //console.log(`Checking layer with bounds (${layer.correctedX}, ${layer.correctedY}) to (${layer.correctedX + layer.w}, ${layer.correctedY + layer.h}) against world coordinates (${adjustedWorldX}, ${adjustedWorldY})`);
        if (adjustedWorldX >= layer.correctedX && adjustedWorldX < layer.correctedX + layer.w &&
            adjustedWorldY >= layer.correctedY && adjustedWorldY < layer.correctedY + layer.h) {
            
            // 2. Calculate local pixel coordinates (0 to width/mapH)
            const localX = Math.floor((adjustedWorldX - layer.correctedX) / 10);
            const localY = Math.floor((adjustedWorldY - layer.correctedY) / 10);

            // 3. Access the raw buffer (skipping the 4-pixel header). Fill layers
            // have none: their material is answered from the biome map instead
            // (app.js), and they must not shadow a pixel scene carved into them.
            const buffer = layer.buffer;
            if (!buffer) {
                if (!result.fillLayer && layer.isFill) result.fillLayer = layer;
                continue;
            }

            // Index: (y + offset) * width + x, then * 3 for RGB
            const idx = ((localY + 4) * layer.width + localX) * 3;

            if (idx + 2 >= buffer.length) return result;

            const r = buffer[idx];
            const g = buffer[idx + 1];
            const b = buffer[idx + 2];
            const hex = (r << 16) | (g << 8) | b;
            const hexStr = `${hex.toString(16).padStart(6, '0')}`;

            // 4. Return the material name from your existing table
            //console.log(`Material color at (${worldX}, ${worldY}) [local: (${localX}, ${localY})]: #${hexStr}`);
            if (MATERIAL_COLOR_LOOKUP[hexStr]) {
                result.material = MATERIAL_COLOR_LOOKUP[hexStr];
                result.source = 'layer';
                // Generated wang layers carry tileIndices; the hand-authored ones
                // (generateStaticTile) are a straight image blit.
                result.layer = { biomeName: layer.biomeName, localX, localY, kind: layer.tileIndices ? 'wang' : 'static' };
                result.colorHex = hexStr;
                return result;
            }
            //break; // No need to check other layers if we've found the correct one, hopefully
            // Actually nevermind, forgot about the single chunk fungal caverns inside the range of other biomes
            // If it didn't find a material it's probably in a pixel scene
        }
    }
    // Check pixel scenes as a fallback (this is kind of expensive...)
    // These ones don't use the adjusted coordinates
    for (const scene of pixelScenes) {
        const localX = worldX - scene.x;
        const localY = worldY - scene.y;
        if (localX >= 0 && localX < scene.width && localY >= 0 && localY < scene.height) {
            // Remembered even when the scene paints nothing here, so the tooltip can
            // still say which scene's footprint the pixel falls inside.
            if (!result.coveringScene) {
                result.coveringScene = { key: scene.key, name: scene.name, localX, localY };
            }
            // Use original scene data via key to avoid recoloring issues
            // Need to use a variant though if there were random materials
            let imgData;
            let shortenedVariantKey = scene.variantKey ? scene.variantKey.replace(/&?biome=[^&]+/, '') : '';
            if (shortenedVariantKey !== '') {
                //console.log(`Using variant key ${shortenedVariantKey} for pixel scene ${scene.name} when looking up material at (${worldX}, ${worldY})`);
                imgData = PIXEL_SCENE_DATA[scene.key].variants[shortenedVariantKey];
            } else {
                imgData = PIXEL_SCENE_DATA[scene.key].imgElement;
                if (!imgData) requestScenePixels(PIXEL_SCENE_DATA[scene.key]);
            }
            if (!imgData) continue; // Hasn't been generated yet?
            const pixelIdx = (localY * scene.width + localX) * 4; // RGBA in one array
            const r = imgData[pixelIdx];
            const g = imgData[pixelIdx + 1];
            const b = imgData[pixelIdx + 2];
            const hex = (r << 16) | (g << 8) | b;
            const hexStr = `${hex.toString(16).padStart(6, '0')}`;
            //console.log(`Pixel scene color at (${worldX}, ${worldY}) [local: (${localX}, ${localY})]: #${hexStr}`);
            // The density class first, exactly as the instance build classifies
            // its pixels: gray/white (never black -- makeBlackTransparent already
            // zeroed those) is "fill with the biome's own material", and it wins
            // over the wang-colour lookup. No material colour in the table is
            // gray, so the order costs nothing and keeps the two in step.
            if (r === g && g === b && r > 0) {
                const density = sceneDensityClassAt(scene.variantKey, worldX, worldY);
                if (density) {
                    result.densityClass = { biomeName: density.biomeName, via: density.via };
                    // A band table accepting nothing at density 1.0 is a real AIR
                    // answer, so leave `material`, `source` and `scene` alone there
                    // and let the walk fall through to whatever else covers the
                    // pixel -- `densityClass` beside `coveringScene` still says
                    // which class produced the hole.
                    if (density.material) {
                        result.material = density.material;
                        result.source = 'scene';
                        result.scene = { key: scene.key, name: scene.name, localX, localY, variantKey: shortenedVariantKey };
                        result.colorHex = hexStr;
                        return result;
                    }
                }
            }
            else if (MATERIAL_COLOR_LOOKUP[hexStr]) {
                result.material = MATERIAL_COLOR_LOOKUP[hexStr];
                result.source = 'scene';
                result.scene = { key: scene.key, name: scene.name, localX, localY, variantKey: shortenedVariantKey };
                result.colorHex = hexStr;
                return result;
            }
            else {
                //console.log(`No material found for pixel scene color #${hexStr} at (${worldX}, ${worldY}) in scene ${scene.name}.`);
            }
            // Might be in a different pixel scene that is nested or something, but seems unlikely.
        }
    }
    return result;
}

export function getPWIndices(worldX, worldY, pw = 0, pwVertical = 0, isNGP = false, gameMode='normal') {
    const worldSize = getWorldSize(isNGP, gameMode) * 512;
    const pwX = Math.floor((worldX + pw * worldSize) / worldSize);
    const pwY = Math.floor((worldY + pwVertical * 24576) / 24576);
    return [pwX, pwY];
}


export function roundHalfOfEven(n) {
    if (n % 1 === 0.5) {
        const floor = Math.floor(n);
        return (floor % 2 === 0) ? floor : floor + 1;
    }
    return Math.round(n);
}

export function* generateSpiral(startX, startY) {
    yield { x: startX, y: startY };
    let x = startX, y = startY, step = 1;

    while (true) {
        for (let i = 0; i < step; i++) yield { x: ++x, y }; // Right
        for (let i = 0; i < step; i++) yield { x, y: ++y }; // Down
        step++;
        for (let i = 0; i < step; i++) yield { x: --x, y }; // Left
        for (let i = 0; i < step; i++) yield { x, y: --y }; // Up
        step++;
    }
}

export function getPayloadSize(obj) {
    let bufferBytes = 0;

    // We use a custom replacer to catch binary buffers before they get stringified
    const jsonStr = JSON.stringify(obj, (key, value) => {
        // Intercept Uint8ClampedArray, Uint8Array, or any ArrayBuffer view
        if (value && value.buffer instanceof ArrayBuffer) {
            bufferBytes += value.byteLength;
            return '[Binary Buffer]'; // Swap it out so JSON doesn't bloat
        }
        return value;
    });

    // Get the exact byte size of the standard JSON text
    const jsonBytes = new Blob([jsonStr]).size; 
    
    // Add the binary buffer sizes back in
    const totalBytes = jsonBytes + bufferBytes;
    
    return (totalBytes / 1024 / 1024).toFixed(3) + ' MB';
}

export function getDateAndTime() {
    const date = new Date();
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds()
    };
}

export { readJson as fetchSafeJson } from '../asset-host';
