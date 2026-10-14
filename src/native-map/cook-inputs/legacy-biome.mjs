// Owned pure legacy ownership policy, adapted from utils/image_processing.
import { GetBiomeOffset } from './legacy-edge-noise.mjs';
export const DEFAULT_LEGACY_EDGE_EXCEPTIONS = new Set([
    'secret_lab', 'wizardcave_entrance', 'roboroom', 'meatroom', 'ghost_secret', 'mestari_secret',
    'boss_arena_top', 'boss_arena',
    'temple_altar', 'temple_altar_left', 'temple_altar_right', 'temple_altar_right_snowcave', 'temple_altar_right_snowcastle', 'temple_wall_ending', 'temple_wall', 'solid_wall_temple', 
    'friend_1', 'friend_2', 'friend_3', 'friend_4', 'friend_5', 'friend_6',
    'rock_room', 'snowcave_tunnel',
    'mountain_left_stub', 'mountain_right_stub', 'mountain_tree',
    'pyramid_hallway', 'pyramid_right', 'pyramid_entrance', 'pyramid_left', 'pyramid_top',
    'robot_egg', 'moon_room', 'gun_room', 'null_room', 'song_room', 'ocarina', 'gourd_room', 'alchemist_secret', 
    'snowcastle_cavern',
    'essenceroom_air', 'essenceroom', 'essenceroom_hell', 'essenceroom_alc', 
    'mystery_teleport', 'roadblock', 'sky_light_injector', 
    'lava', 'lake', 'lavalake', 'watercave', 'empty', 'lava_90percent',
    'solid_wall_tower_10', 'greed_room', 'boss_victoryroom',
    //'biome_watchtower', 'biome_potion_mimics', 'biome_darkness', 'biome_boss_sky', 'biome_barren',
    //'clouds', 'the_sky'
    // Really wish I didn't have to add these, but they end up looking weird
    'hills', 'hills_tower', 'hills2', 'desert', 'winter',
]);


export function createLegacyBiomeSampler({ biomeNamesByColor, noiseFlagsByColor, edgeNoiseExceptions }) {
 const BIOME_COLOR_TO_NAME = Object.fromEntries(biomeNamesByColor);
 const CHUNK_SIZE = 512, WORLD_CHUNK_CENTER_Y = 14, BIOME_EDGE_NOISE_EXTENT = 42;
 const PROBE_X = new Int32Array(8), PROBE_Y = new Int32Array(8);
 const getWorldSize = (isNGP, gameMode = 'normal') => isNGP || gameMode === 'nightmare' ? 64 : 70;
 const colorIneligible = color => noiseFlagsByColor.get(color & 0xffffff) === 0;
 const isEdgeNoiseOverlayException = biome => edgeNoiseExceptions.has(biome);
function bandBiomeMap(biomeData, worldY) {
    if (worldY < -WORLD_CHUNK_CENTER_Y * CHUNK_SIZE) return biomeData.heavenPixels;
    if (worldY >= (48 - WORLD_CHUNK_CENTER_Y) * CHUNK_SIZE) return biomeData.hellPixels;
    return biomeData.pixels;
}

function getBiomeAtWorldCoordinates(biomeData, worldX, worldY, isNGP = false, gameMode = 'normal', useEdgeNoise = false) {
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

function getUnwobbledTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode) {
    const biomeMap = bandBiomeMap(biomeData, worldY);

    const mapWidth = getWorldSize(isNGP, gameMode);
    const worldWidth = mapWidth * CHUNK_SIZE;
    // Fold on the map pitch, as the engine's chunk index does (not the NG+ PW
    // stride, see utils.getWorldStride).
    const mapX = ((worldX + worldWidth / 2) % worldWidth + worldWidth) % worldWidth;
    const mapY = ((worldY + 14 * CHUNK_SIZE) % (48 * CHUNK_SIZE) + 48 * CHUNK_SIZE) % (48 * CHUNK_SIZE);
    const x = Math.floor(mapX / CHUNK_SIZE);
    const y = Math.floor(mapY / CHUNK_SIZE);
    const colorInt = biomeMap[y * mapWidth + x] & 0xffffff;
    const biome = BIOME_COLOR_TO_NAME[colorInt] || null;

    return {
        biome,
        origBiome: biome,
        colorInt,
        pos: { x, y },
        originalPos: { x, y },
        mightBeEdgeCase: false,
        edgeNoiseIgnored: false
    };
}

function getTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode, useEdgeNoise) {
    const subChunkX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const subChunkY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const isInterior = subChunkX >= BIOME_EDGE_NOISE_EXTENT && subChunkX <= CHUNK_SIZE - BIOME_EDGE_NOISE_EXTENT &&
        subChunkY >= BIOME_EDGE_NOISE_EXTENT && subChunkY <= CHUNK_SIZE - BIOME_EDGE_NOISE_EXTENT;

    // Edge noise cannot affect cells outside the 42px chunk-border band. Avoid
    // GetBiomeOffset(), neighbor probes, and wobble resolution for the large
    // interior area; this mirrors getBiomeAtWorldCoordinates' original lookup.
    if (!useEdgeNoise || isInterior) {
        return getUnwobbledTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode);
    }

    // The wobbled result alone does not always reveal an exception on the
    // opposite side of an edge: it can resolve back to this non-exception
    // chunk. Inspect the actual neighboring chunk before applying noise, so an
    // exception blocks overlay changes symmetrically on left/top/right/bottom.
    const adjacentBiomeIsException = (adjacentX, adjacentY) =>
        isEdgeNoiseOverlayException(getUnwobbledTileOverlayBiome(biomeData, adjacentX, adjacentY, isNGP, gameMode).biome);
    if ((subChunkX < BIOME_EDGE_NOISE_EXTENT && adjacentBiomeIsException(worldX - subChunkX - 1, worldY)) ||
        (subChunkY < BIOME_EDGE_NOISE_EXTENT && adjacentBiomeIsException(worldX, worldY - subChunkY - 1)) ||
        (subChunkX > CHUNK_SIZE - BIOME_EDGE_NOISE_EXTENT && adjacentBiomeIsException(worldX + CHUNK_SIZE - subChunkX, worldY)) ||
        (subChunkY > CHUNK_SIZE - BIOME_EDGE_NOISE_EXTENT && adjacentBiomeIsException(worldX, worldY + CHUNK_SIZE - subChunkY))) {
        return {
            ...getUnwobbledTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode),
            edgeNoiseIgnored: true
        };
    }

    const noisyResult = getBiomeAtWorldCoordinates(biomeData, worldX, worldY, isNGP, gameMode, useEdgeNoise);
    if (!useEdgeNoise || (!isEdgeNoiseOverlayException(noisyResult.biome) && !isEdgeNoiseOverlayException(noisyResult.origBiome))) {
        return { ...noisyResult, edgeNoiseIgnored: false };
    }

    // Either side of this edge is exceptional: use the unwobbled chunk so the
    // source overlay stays unchanged and expanded buffers do not synthesize it.
    return {
        ...getUnwobbledTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode),
        edgeNoiseIgnored: true
    };
}


return { getTileOverlayBiome, getUnwobbledTileOverlayBiome };
}
