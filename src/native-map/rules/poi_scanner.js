// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { tileToWorldCoordinates, getBiomeAtWorldCoordinates, getResolvedBiome, getWorldCenter, getWorldSize } from "./utils.js";
import { CHUNK_SIZE, TILE_SIZE, WORLD_CHUNK_CENTER_X, WORLD_CHUNK_CENTER_Y } from "./constants.js";
import { GENERATOR_CONFIG } from "./generator_config.js";
import { BIOME_SPAWN_FUNCTION_MAP } from "./spawn_function_config.js";
import { getSpawnFunctionIndex, spawnSwitch } from "./spawn_functions.js";
import { isDuplicateObject } from "./utils.js";
import { generateHolyMountainShops } from "./temple_generation.js";
import { 
	generateHourglassShop, 
	generateEyeRoom, 
	generateMeditationCube, 
	generateSnowyRoom, 
	generatePortal, 
	generateTriangleBossDrops, 
	generateAlchemistBossDrops, 
	generatePyramidBossDrops, 
    generateEndShop,
    generateRobotEgg,
    generateDragonBossDrops
} from './misc_generation.js';
import { appSettings } from "./settings.js";
import { PIXEL_SCENE_SPAWN_DATA } from "./pixel_scene_generation.js";

// Prevent infinite loops with nested pixel scenes (which hopefully shouldn't happen...)
const MAX_SCAN_CYCLES = 10;

// Spawn functions which keep their original biome, even if edge noise would place them in a different biome
// TODO: Check if this applies to any others
const ORIGINAL_BIOME_SPAWNS = new Set([
    'spawn_heart',
    'spawn_chest',
    //'spawn_items', // This was a mistake. Understandable, honestly, since this has a very misleading name, but it's actually for the wand altar pixel scene
    // Instead, these two needed to be included
    'spawn_wands',
    'spawn_potions',
]);

// Convert a world position to the wang tile pixel's scan point (increments of 10 pixels).
// Checks for edge noise biome flips are done at this base scan point
function getTileScanPoint(worldX, worldY) {
    const axis = (w) => {
        const phase = ((((Math.floor(w / 512) * 512) % 10) + 10) % 10);
        const base = (((phase - w) % 10) + 10) % 10;
        return w + (base >= 5 ? base : base + 10);
    };
    return { x: axis(worldX), y: axis(worldY) };
}

export function prescanPixelScene(imgData, sourceBiome) {
    //const clearSpawnPixels = document.getElementById('clear-spawn-pixels').checked;
    const clearSpawnPixels = appSettings.clearSpawnPixels;
    const detectedSpawns = [];
    if (!imgData) return detectedSpawns;

    const sWidth = imgData.width;
    const sHeight = imgData.height;
    // Per-pixel getSpawnFunctionIndex was a linear scan of the biome's list for
    // every opaque pixel; first match wins, same as that scan.
    const indexByColor = new Map();
    BIOME_SPAWN_FUNCTION_MAP[sourceBiome]?.forEach((fn, i) => {
        if (!indexByColor.has(fn.color)) indexByColor.set(fn.color, i);
    });

    for (let y = 0; y < sHeight; y++) {
        for (let x = 0; x < sWidth; x++) {
            const idx = (y * sWidth + x) * 4;
            const r = imgData.data[idx];
            const g = imgData.data[idx + 1];
            const b = imgData.data[idx + 2];
            const a = imgData.data[idx + 3];

            // Skip transparent or standard background pixels
            if (a === 0) continue;
            const colorInt = (r << 16) | (g << 8) | b;
            if (colorInt === 0x000000 || colorInt === 0xffffff) continue;

            const index = indexByColor.get(colorInt) ?? null;
            if (index !== null) {
                // Pixel scenes are drawn at 1:1 scale in world units
                // Note the positions are relative
                detectedSpawns.push({
                    sourceBiome,
                    x: x,
                    y: y,
                    spawnFunctionIndex: index
                });
            }
            if (clearSpawnPixels && index !== null) {
                imgData.data[idx] = 0;
                imgData.data[idx + 1] = 0;
                imgData.data[idx + 2] = 0;
                imgData.data[idx + 3] = 0;
            }
        }
    }
    return detectedSpawns;
}

function getPixelSceneSpawnFunctionIndices(biomeData, biomeName, pixelScene, worldSeed, ngPlusCount, skipCosmeticScenes = true, perks={}, gameMode='normal') {
    let detectedSpawns = [];
    let newPixelScenes = [];
    let generatedSpawns = [];

    //if (!pixelScene.imgElement) return { detectedSpawns, newPixelScenes, generatedSpawns };
    const spawnFunctions = BIOME_SPAWN_FUNCTION_MAP[biomeName] || [];
    if (spawnFunctions.length === 0) return { detectedSpawns, newPixelScenes, generatedSpawns };
    
    //console.log(`Scanning pixel scene ${pixelScene.name} for biome ${biomeName}`);

    // Pixel scenes were already prescanned for spawn function pixels, so we can skip straight to generating spawn indices
    // However they need to be modified to take into account the position of the pixel scene in the world
    // Also handle shop here by detecting spell spawns and grouping them together based on proximity
    let spellList = [];
    let potionList = [];

    const spawnPoints = PIXEL_SCENE_SPAWN_DATA[pixelScene.key];

    for (const spawnPoint of spawnPoints) {
        const spawnX = pixelScene.x + spawnPoint.x;
        const spawnY = pixelScene.y + spawnPoint.y;
        const index = spawnPoint.spawnFunctionIndex;

        if (index === null || (index >= 0 && !spawnFunctions[index])) continue; // Shouldn't happen but just in case
        // Check for nested pixel scenes
        //console.log(`Processing spawn point with index ${index} at (${spawnX}, ${spawnY}) in pixel scene ${pixelScene.name} for biome ${biomeName}`);
        //console.log(`Spawn function details: `, spawnFunctions[index]);
        // Since this pixel scene is considered entirely inside one biome, it should be safe to add the spawns from it inside the same biome, saving a scan cycle
        // However, it doesn't seem like this actually improves the speed at all, and it might affect accuracy
        
        if (index >= 0 && spawnFunctions[index].isPixelScene) {
            // Nested pixel scene handling (this is literally only needed for the vault, why did Nolla do this)
            const nestedSpawnData = spawnSwitch(biomeData, biomeName, index, worldSeed, ngPlusCount, spawnX, spawnY, skipCosmeticScenes, perks, gameMode);
            if (nestedSpawnData && nestedSpawnData.type === 'pixel_scene') {
                //console.log(`Generated nested pixel scene at (${spawnX}, ${spawnY}) for biome ${biomeName}: ${nestedSpawnData.name}`);
                // Adjust nested pixel scene position (why? no idea, but it fixes the misaligned pipe nested pixel scenes in the vault)
                //nestedSpawnData.x -= 6;
                newPixelScenes.push(nestedSpawnData);
                //console.log(`Added nested pixel scene ${nestedSpawnData.name} to layer ${biomeName} PW ${pwIndex} at (${nestedSpawnData.x}, ${nestedSpawnData.y})`);
                // Appending to the same list we're iterating over? Is this okay?
            }
        }
        else {
            
            // TODO: Add bar..? Actually maybe it's fine, it just makes a handful of potions close together but not as many as the lab
            if (pixelScene.name.includes("laboratory")) {
                const spawnData = spawnSwitch(biomeData, biomeName, index, worldSeed, ngPlusCount, spawnX, spawnY, skipCosmeticScenes, perks, gameMode);
                //console.log(`Lab spawn data at (${spawnX}, ${spawnY}) in pixel scene ${pixelScene.name} for biome ${biomeName}: `, spawnData);
                if (spawnData && spawnData.item === 'potion') {
                    potionList.push(spawnData);
                }
            }
            else if (pixelScene.name.includes("shop")) {
                const spawnData = spawnSwitch(biomeData, biomeName, index, worldSeed, ngPlusCount, spawnX, spawnY, skipCosmeticScenes, perks, gameMode);
                if (spawnData && spawnData.item === 'spell') {
                    spellList.push(spawnData);
                }
            }
            else {
                // For non-shop pixel scenes, we can directly add the spawns without worrying about grouping
                detectedSpawns.push({
                    sourceBiome: biomeName,
                    x: spawnX,
                    y: spawnY,
                    spawnFunctionIndex: index,
                    fromPixelScene: true,
                    // The game resolves the spawn biome for the whole scene at its center
                    sceneCenterX: pixelScene.x + Math.floor(pixelScene.width / 2),
                    sceneCenterY: pixelScene.y + Math.floor(pixelScene.height / 2)
                });
            }
        }
    }

    // If we detected spells in a shop pixel scene, add the shop PoI directly
    if (spellList.length > 0) {
        const worldX = pixelScene.x + pixelScene.width / 2;
        const worldY = pixelScene.y + pixelScene.height / 2;
        const shopData = {type: 'shop', items: spellList, x: worldX, y: worldY, biome: biomeName};
        generatedSpawns.push(shopData);
    }

    if (potionList.length > 0) {
        // Dedupe
        let dedupedItems = [];
        for (let item of potionList) {
            let found = false;
            for (let deduped of dedupedItems) {
                if (isDuplicateObject(deduped, item)) {
                    if (deduped.amount && item.amount) deduped.amount += item.amount;
                    deduped.count = (deduped.count || 1) + 1;
                    found = true;
                    break;
                }
            }
            if (!found) {
                dedupedItems.push(item);
            }
        }

        const worldX = pixelScene.x + pixelScene.width / 2;
        const worldY = pixelScene.y + pixelScene.height / 2;
        // TODO: Add bar
        const labData = {type: 'laboratory', items: dedupedItems, x: worldX, y: worldY, biome: biomeName};
        generatedSpawns.push(labData);
    }

    // Special pixel scenes which add their own PoI despite not actually spawning a separate item
    if (pixelScene.name === "trailer_altar") {
        generatedSpawns.push({
            type: 'item',
            item: 'trailer_altar',
            x: pixelScene.x + pixelScene.width / 2,
            y: pixelScene.y + pixelScene.height / 2,
            biome: biomeName
        });
    }
    if (pixelScene.name === "meditation_cube_visual") {
        generatedSpawns.push({
            type: 'item',
            item: 'meditation_cube',
            x: pixelScene.x + 20,
            y: pixelScene.y + 29 - 70, // Match teleporter position
            biome: biomeName
        });
    }

    return { detectedSpawns, newPixelScenes, generatedSpawns };
}

// Return axis chunk bases that align with a wang tile pixel index on the spawn function scan grid.
function getChunkBasesForTileIndexAxis(tileIndex, off) {
    const out = [];
    const lo = tileIndex * TILE_SIZE - off - 1;
    const hi = tileIndex * TILE_SIZE - off + TILE_SIZE + 1;
    for (let s = Math.ceil(lo); s <= hi; s++) {
        if (Math.floor((s + off + 0.5) / TILE_SIZE) !== tileIndex) continue;
        const cb = Math.floor(s / CHUNK_SIZE) * CHUNK_SIZE;
        if ((((s - cb) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE !== 0) continue;
        if (!out.includes(cb)) out.push(cb);
    }
    return out;
}
// Conservative seam gate: keep a spawn only if its spawn pixel lands inside at least
// one chunk candidate on both axes from the wang tile index mapping.
function passesSpawnChunkGate(emitX, emitY, isNGP, gameMode) {
    const offX = getWorldCenter(isNGP, gameMode) * CHUNK_SIZE;
    const offY = WORLD_CHUNK_CENTER_Y * CHUNK_SIZE;
    const half = TILE_SIZE / 2;
    const cellX = Math.round((emitX + half + offX) / TILE_SIZE);
    const cellY = Math.round((emitY + half + offY) / TILE_SIZE);
    const rx = getChunkBasesForTileIndexAxis(cellX, offX);
    const ry = getChunkBasesForTileIndexAxis(cellY, offY);
    for (const cX of rx) {
        if (!(cX <= emitX && emitX < cX + (CHUNK_SIZE - 1))) continue;
        for (const cY of ry) {
            if (cY <= emitY && emitY < cY + (CHUNK_SIZE - 1)) return true;
        }
    }
    return false;
}

// Surprisingly this depends on NG0 vs NG+ but not on seed
export function prescanSpawnFunctions(tileLayers, isNGP, gameMode='normal') {
    // TODO: Don't use clearSpawnPixels here, do it earlier
    //const clearSpawnPixels = document.getElementById('clear-spawn-pixels').checked;
    const t0 = performance.now();
    let detectedSpawns = [];
    for (const layer of tileLayers) {
        const sourceBiome = layer.biomeName;
        const width = layer.width;
        const height = layer.mapH;
        const sourceSpawnFunctions = BIOME_SPAWN_FUNCTION_MAP[sourceBiome] || [];

        // Probably no longer needed
        if (!layer.buffer) {
            // Fill layers are buffer-less by construction (tile_generator.js
            // generateFillLayer) and there are ~1300 of them, so skip them
            // silently; a buffer-less wang layer is still worth a shout.
            if (!layer.isFill) console.log("Skipping layer:", layer);
            continue;
        }

        if (sourceSpawnFunctions.length === 0) continue;
        const indexByColor = new Map();
        for (let i=0;i<sourceSpawnFunctions.length;i++) if(!indexByColor.has(sourceSpawnFunctions[i].color)) indexByColor.set(sourceSpawnFunctions[i].color,i);

        // Accidentally used the height before the offset by 4...? Eh it's fine
        for (let y = 4; y < height + 4; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = (y * width + x) * 3;
                const r = layer.buffer[srcIdx];
                const g = layer.buffer[srcIdx + 1];
                const b = layer.buffer[srcIdx + 2];
                const colorInt = (r << 16) | (g << 8) | b;

                if (colorInt === 0x000000 || colorInt === 0xffffff) continue;

                const index = indexByColor.get(colorInt) ?? null;

                if (index !== null) {
                    const coords = tileToWorldCoordinates(layer.minX, layer.minY, x, y - 4, 0, 0, isNGP, gameMode);

                    // Don't gate here: this prescan is PW0-only, but the NG+ stride
                    // gives each parallel world a different sub-chunk phase, so a PW0
                    // seam artifact can be a real spawn elsewhere. scanSpawnFunctions
                    // re-gates every spawn in its own PW frame (== PW0 for NG0).
                    detectedSpawns.push({
                        sourceBiome,
                        x: coords.x, // Note: PW0
                        y: coords.y,
                        spawnFunctionIndex: index
                    });
                }
                // Not sure why this magenta one wasn't cleared
                /*
                if (clearSpawnPixels && (index !== null || colorInt === 0xff00ff)) {
                    // Correct stride
                    const targetIdx = ((y - 4) * width + x) * 4;
                    data[targetIdx] = 0;
                    data[targetIdx + 1] = 0;
                    data[targetIdx + 2] = 0;
                    data[targetIdx + 3] = 0;
                }
                */
            }
        }
        /*
        if (clearSpawnPixels) {
            ctx.putImageData(imgData, 0, 0);
        }
        */
    }
    
    const t1 = performance.now();
    console.log(`[Generator] Spawn function prescan completed in ${(t1 - t0).toFixed(2)} ms with ${detectedSpawns.length} detected spawn points.`);
    
    return detectedSpawns;
}

export function scanSpawnFunctions(biomeData, tileSpawns, worldSeed, ngPlusCount, pwIndex, pwIndexVertical, skipCosmeticScenes = true, perks={}, gameMode='normal') {
    const t0 = performance.now();
    let detectedSpawns = tileSpawns.map(spawn => ({...spawn, fromPixelScene: false,
        x: spawn.x + pwIndex*getWorldSize(ngPlusCount > 0, gameMode) * 512 - ((ngPlusCount > 0 || gameMode === 'nightmare') ? 8 * pwIndex : 0),
        y: spawn.y + pwIndexVertical*24570
    }))
    // The prescan gate ran in main-world coordinates, but the NG+ parallel world
    // stride is 8px short of a whole chunk, so the offset above shifts spawns
    // relative to the chunk grid. A spawn sitting just inside a chunk in the main
    // world can end up outside one several parallel worlds over, so re-check it.
    .filter(spawn => passesSpawnChunkGate(spawn.x, spawn.y, ngPlusCount > 0, gameMode));
    let generatedSpawns = [];

    let finalPixelScenes = [];
    let newPixelScenes = [];
    const shopsPerChunk = {};
    let scanCycles = 0;
    do {
        // Loop until we don't have any new pixel scenes or detected spawns
        // Process new pixel scenes

        let numberOfNewPixelScenes = newPixelScenes.length;
        for (let i = 0; i < numberOfNewPixelScenes; i++) {
            const pixelScene = newPixelScenes[i];
            finalPixelScenes.push(pixelScene);
            // Always use edge noise offset here
            const target = getBiomeAtWorldCoordinates(biomeData, pixelScene.x, pixelScene.y, ngPlusCount > 0, gameMode, true);
            // Prefer the original biome of the pixel scene
            const targetBiome = pixelScene.biome || (target ? target.biome : null);
            //const targetChunkPos = target ? target.pos : null;

            const pixelSceneResults = getPixelSceneSpawnFunctionIndices(biomeData, targetBiome, pixelScene, worldSeed, ngPlusCount, skipCosmeticScenes, perks, gameMode);
            detectedSpawns.push(...pixelSceneResults.detectedSpawns.map(s => ({...s, fromPixelScene: true})));
            newPixelScenes.push(...pixelSceneResults.newPixelScenes); // This could be a problem
            numberOfNewPixelScenes += pixelSceneResults.newPixelScenes.length; // This is a hack to allow processing newly added pixel scenes in the same cycle
            // TODO: Might cause infinite loop if overlap can cause infinitely nested pixel scenes, but surely that can't happen...? Right?
            generatedSpawns.push(...pixelSceneResults.generatedSpawns);
        }

        // Clear processed pixel scenes
        newPixelScenes = [];

        detectedSpawns.forEach(spawn => {
            let targetBiome;
            const srcFn = (BIOME_SPAWN_FUNCTION_MAP[spawn.sourceBiome] || [])[spawn.spawnFunctionIndex];
            const srcFnName = srcFn ? srcFn.funcName : null;
            if (spawn.fromPixelScene) {
                // The game resolves one biome for the entire pixel scene at its center (with
                // edge noise applied) and runs all of the scene's spawn functions in that
                // biome. If that biome has no handler for the function (e.g. solid_wall),
                // nothing spawns even though the scene itself is placed.
                const ccx = spawn.sceneCenterX ?? spawn.x, ccy = spawn.sceneCenterY ?? spawn.y;
                const target = getBiomeAtWorldCoordinates(biomeData, ccx, ccy, ngPlusCount > 0, gameMode, true);
                const centerBiome = target ? target.biome : null;
                if (centerBiome && centerBiome !== spawn.sourceBiome) {
                    // Function indices differ per biome, so re-look up by color
                    const color = srcFn ? srcFn.color : null;
                    const newIdx = color != null ? getSpawnFunctionIndex(centerBiome, color) : null;
                    if (newIdx === null || newIdx === undefined) return;
                    spawn.spawnFunctionIndex = newIdx;
                }
                targetBiome = centerBiome;
            } else if (ORIGINAL_BIOME_SPAWNS.has(srcFnName)) {
                // Exception spawn functions that use their original biome, but the
                // biome edge drop at the scan point still applies
                const sp = getTileScanPoint(spawn.x, spawn.y);
                const spResolved = getResolvedBiome(biomeData, sp.x, sp.y, ngPlusCount > 0, gameMode);
                if (spResolved.biome !== spResolved.origBiome) return;
                const resolved = getResolvedBiome(biomeData, spawn.x, spawn.y, ngPlusCount > 0, gameMode);
                targetBiome = resolved.origBiome;
            } else {
                // Normal spawn functions resolve their biome through the wobbled chunk lookup at the wang tile pixel scan point rather than the original spawn point
                const sp = getTileScanPoint(spawn.x, spawn.y);
                const resolved = getResolvedBiome(biomeData, sp.x, sp.y, ngPlusCount > 0, gameMode);
                // Drop spawns if they cross a biome edge
                if (resolved.biome !== resolved.origBiome) return;
                targetBiome = resolved.origBiome;
            }
            if (targetBiome) {
                // TODO: Setting the biome in here might be redundant now
                const spawnData = spawnSwitch(biomeData, targetBiome, spawn.spawnFunctionIndex, worldSeed, ngPlusCount, spawn.x, spawn.y, skipCosmeticScenes, perks, gameMode, spawn.fromPixelScene);
                if (spawnData) {
                    spawnData.biome = targetBiome;
                    if (spawn.sourceBiome != targetBiome) {
                        spawnData.originalBiome = spawn.sourceBiome;
                        spawnData.originalX = spawn.x;
                        spawnData.originalY = spawn.y;
                    }

                    if (spawnData.type === 'pixel_scene') {
                        if (scanCycles <= MAX_SCAN_CYCLES-1) {
                            newPixelScenes.push(spawnData);
                            // rescan next cycle to get spawns from the nested pixel scene
                        }
                        else {
                            // Add placeholder
                            generatedSpawns.push(spawnData);
                        }
                    }
                    // On second thought, knowing the exact position of the shop item does seem useful if it's not a shop pixel scene
                    /*
                    else if (spawnData.item && spawnData.item === 'spell') {
                        //console.log(`Secret shop spell spawn detected at (${spawn.x}, ${spawn.y}) in biome ${targetBiome} from spawn function index ${spawn.spawnFunctionIndex}: `, spawnData);
                        // Special consideration for secret shop spells because we want to group them together into shops based on proximity
                        const chunkKey = `${targetBiome}/${targetChunkPos.x}/${targetChunkPos.y}`;
                        if (!shopsPerChunk[chunkKey]) {
                            shopsPerChunk[chunkKey] = [];
                        }
                        shopsPerChunk[chunkKey].push(spawnData);
                    }
                    */
                    else {
                        generatedSpawns.push(spawnData);
                    }
                }
            }
        });

        // Clear processed spawns
        detectedSpawns = [];
        scanCycles++;
    } while (newPixelScenes.length > 0 && scanCycles <= MAX_SCAN_CYCLES);

    // Add secret shops
    for (const chunkKey in shopsPerChunk) {
        const spells = shopsPerChunk[chunkKey];
        const [biomeName, chunkX, chunkY] = chunkKey.split('/').map((v, i) => i === 0 ? v : Number(v));
        const worldX = chunkX * 512 + 256 - getWorldCenter(ngPlusCount > 0, gameMode) * 512 + getWorldSize(ngPlusCount > 0, gameMode) * 512 * pwIndex;
        const worldY = chunkY * 512 + 256 - 14 * 512 + 24570 * pwIndexVertical;
        const shopData = {type: 'shop', items: spells, x: worldX, y: worldY, biome: biomeName, originalBiome: biomeName};
        generatedSpawns.push(shopData);
    }

    // Add final pixel scenes to render
    //tileLayers[0].pixelScenesByPW[pwIndex] = (tileLayers[0].pixelScenesByPW[pwIndex] || []).concat(finalPixelScenes);

    const t1 = performance.now();
    console.log(`[Generator] Spawn function scanning completed in ${(t1 - t0).toFixed(2)} ms with ${generatedSpawns.length} generated spawns and ${finalPixelScenes.length} pixel scenes from ${scanCycles} scan cycles.`);

    // Debug help with edge cases (slow but temporary)
    // So far it seems like if hearts have an offset of -3, -2, or -1, they fail to spawn
    /*
    for (let spawn of generatedSpawns) {
        let xoff = ((spawn.x % 512) + 512) % 512;
        let yoff = ((spawn.y % 512) + 512) % 512;
        if (spawn.item === 'heart' && (xoff > 506 || yoff > 506)) {
            console.log(`Edge case spawn detected at (${spawn.x}, ${spawn.y}) in biome ${spawn.biome}:`, spawn);
            if (xoff > 256) xoff -= 512;
            if (yoff > 256) yoff -= 512;
            console.log(`Offsets: (${xoff}, ${yoff})`);
        }
    }
    */

    return {
        generatedSpawns,
        finalPixelScenes
    };
}

export function getSpecialPoIs(biomeData, worldSeed, ngPlusCount, pwIndex, pwIndexVertical, perks={}, gameMode='normal') {
    const biomeMap = biomeData.pixels;
    //const t0 = performance.now();
    // Extra generation things
    let pois = [];
    // Concat multiple times might be slow? But this is only a few things anyway, usually like 1 ms

    if (pwIndexVertical === 0) {
        // Add HM PoIs to main layer
        if (GENERATOR_CONFIG['temple_altar'].enabled) {
            let hmPoIs = generateHolyMountainShops(worldSeed, ngPlusCount, pwIndex, perks, gameMode);
            pois = pois.concat(hmPoIs);
        }
        // Add Eye Room PoIs
        //console.log("Generating Eye Room for PW", pwIndex);
        // Check whether it exists first, for NGP
        if (GENERATOR_CONFIG['snowcastle_hourglass_chamber'].enabled) {
            let roomExists = true;
            if (ngPlusCount > 0) {
                // Check colors of biome map
                const color = GENERATOR_CONFIG['snowcastle_hourglass_chamber'].color & 0xFFFFFF;
                roomExists = biomeMap.some(p => (p & 0xFFFFFF) === color);
            }
            if (roomExists) {
                let eyeRoom = generateEyeRoom(worldSeed, ngPlusCount, pwIndex, gameMode);
                pois = pois.concat([eyeRoom]);
            }
        }

        
        if (pwIndex === 0 && ngPlusCount === 0 && gameMode === 'normal') {
            if (GENERATOR_CONFIG['snowcastle_cavern'].enabled) {
                // Generate hourglass shop
                // TODO: Also check existence? Depends on the side though (side param is available)
                let hourglassShop = generateHourglassShop(worldSeed);
                pois = pois.concat([hourglassShop]);
            }

            let portal = generatePortal(worldSeed);
            if (portal) {
                pois = pois.concat([portal]);
            }
        }

        if (GENERATOR_CONFIG['excavationsite_cube_chamber'].enabled) {
            let roomExists = true;
            if (ngPlusCount > 0) {
                // Check colors of biome map
                const color = GENERATOR_CONFIG['excavationsite_cube_chamber'].color & 0xFFFFFF;
                roomExists = biomeMap.some(p => (p & 0xFFFFFF) === color);
            }
            if (roomExists) {
                let meditationCubeWand = generateMeditationCube(worldSeed, ngPlusCount, pwIndex, perks, gameMode);
                if (meditationCubeWand) {
                    pois = pois.concat([meditationCubeWand]);
                }
            }
        }

        if (GENERATOR_CONFIG['robot_egg'].enabled) {
            let roomExists = true;
            if (ngPlusCount > 0) {
                // Check colors of biome map
                const color = GENERATOR_CONFIG['robot_egg'].color & 0xFFFFFF;
                roomExists = biomeMap.some(p => (p & 0xFFFFFF) === color);
            }
            if (roomExists) {
                let robotEgg = generateRobotEgg(worldSeed, ngPlusCount, pwIndex, perks, gameMode);
                if (robotEgg) {
                    pois = pois.concat([robotEgg]);
                }
            }
        }

        if (ngPlusCount === 0 && gameMode === 'normal') {
            if (GENERATOR_CONFIG['snowcave_secret_chamber'].enabled) {
                let snowyRoomWands = generateSnowyRoom(worldSeed, pwIndex, perks);
                if (snowyRoomWands) {
                    pois = pois.concat(snowyRoomWands);
                }
            }

            if (GENERATOR_CONFIG['wizardcave_entrance'].enabled) {
                let triangleBossDrops = generateTriangleBossDrops(worldSeed, pwIndex);
                if (triangleBossDrops) {
                    pois = pois.concat([triangleBossDrops]);
                }
            }

            if (GENERATOR_CONFIG['secret_lab'].enabled) {
                let alchemistBossDrops = generateAlchemistBossDrops(worldSeed, pwIndex);
                if (alchemistBossDrops) {
                    pois = pois.concat([alchemistBossDrops]);
                }
            }
            if (GENERATOR_CONFIG['dragoncave'].enabled) {
                let dragonBossDrops = generateDragonBossDrops(worldSeed, pwIndex);
                if (dragonBossDrops) {
                    pois = pois.concat([dragonBossDrops]);
                }
            }
        }
    }
    if (ngPlusCount === 0 && pwIndex === 0) {
        // The pyramid is main-world surface content, like the triangle, alchemist and
        // dragon bosses, which the pwIndexVertical === 0 block above already gates.
        // This block can't be gated the same way -- the heaven/hell shops below want
        // pwIndexVertical +/-1 -- so the boss carries its own vertical guard.
        // generatePyramidBossDrops() has no vertical term, so without it the same drop
        // is emitted at identical coordinates in all three vertical worlds.
        if (pwIndexVertical === 0 && GENERATOR_CONFIG['pyramid_top'].enabled) {
            let pyramidBossDrops = generatePyramidBossDrops(worldSeed, pwIndex);
            if (pyramidBossDrops) {
                pois = pois.concat([pyramidBossDrops]);
            }
        }
        if (gameMode === 'normal') {
            if (pwIndexVertical === 1) {
                let hellShop = generateEndShop(worldSeed, ngPlusCount, pwIndexVertical);
                if (hellShop) {
                    pois = pois.concat([hellShop]);
                }
            }
            else if (pwIndexVertical === -1) {
                let heavenShop = generateEndShop(worldSeed, ngPlusCount, pwIndexVertical);
                if (heavenShop) {
                    pois = pois.concat([heavenShop]);
                }
            }
        }
    }

    //const t1 = performance.now();
    //console.log(`[Generator] Special PoI generation completed in ${(t1 - t0).toFixed(2)} ms with ${pois.length} PoIs generated.`);
    // This takes like 2 ms, it's not worth printing

    return pois;
}