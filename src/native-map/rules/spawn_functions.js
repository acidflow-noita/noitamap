// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from './nolla_prng.js';
import { loadPixelScene, loadRandomPixelScene } from './pixel_scene_generation.js';
import { PIXEL_SCENE_BIOME_MAP, PIXEL_SCENE_LIST_OFFSETS } from './pixel_scene_config.js';
import { spawnChest } from './chest_generation.js';
import { generateWand, spawnWand, spawnSpecialWand, checkWandAltar, generateNightmareWand } from './wand_generation.js';
import { spawnJar, checkPotionAltar, createPotion, spawnItem } from './potion_generation.js';
import { generateShopItem } from './spell_generator.js';
import { spawnHeart } from './heart_generation.js';
import { BIOME_SPAWN_FUNCTION_MAP } from './spawn_function_config.js';
import { BIOMES_WITH_SMALL_ALTARS, BIOME_WAND_ALTAR_OFFSET_MAP, BIOME_POTION_ALTAR_OFFSET_MAP } from './spawn_config.js';
import { generateUtilityBox } from './utility_box_generation.js';
import { getBiomeAtWorldCoordinates, roundHalfOfEven } from './utils.js';
import { getDragonDrops } from './misc_generation.js';
import { BIOME_ENEMY_MAP, TOWER_ENEMIES } from './enemy_config.js';
// Switching to using app settings instead?
import { appSettings } from './settings.js';

// Only these spawn functions are remapped through the wobbled biome after applying edge noise.
// TODO: Are there any others missing?
//const WOBBLE_REMAP_FUNCS = new Set(['spawn_potions', 'spawn_wands', 'spawn_wand']);
// Testing without this, seems to work better.
const WOBBLE_REMAP_FUNCS = new Set([]);

const BIOME_TIERS = {
	'coalmine': 1,
	'coalmine_alt': 1,
	'excavationsite': 2,
	'snowcave': 3,
	'meat': 3, // probably not likely to be used
	//'snowcastle': 3, // No shop here
	//'rainforest': 4, // No shop here
	//'rainforest_open': 4, // No shop here
	//'vault': 4, // Uses y coordinate for this one
	//'crypt': 5, // Uses y coordinate here too
	'the_end': 10,
	'the_sky': 10,
	// Unclear what the shop level for the tower is, seems like it can just spawn any spell, I thought it was tier 10 but maybe it's just depth-dependent (null)
	// File seems to indicate 6?
	'solid_wall_tower_1': 6, // Mines
	'solid_wall_tower_2': 6, // Coal Pits
	'solid_wall_tower_3': 6, // Snowy Depths
	'solid_wall_tower_4': 6, // Hiisi Base
	'solid_wall_tower_5': 6, // Fungal Caverns
	'solid_wall_tower_6': 6, // Underground Jungle
	'solid_wall_tower_7': 6, // The Vault
	'solid_wall_tower_8': 6, // Temple of the Art
	'solid_wall_tower_9': 6, // Hell, not actually reachable in overlaps because it doesn't exist in NG+, but probably worth including for completeness
}

// TODO: Might still need to block out rooms for some of these?

/*
0x00ac6e: "load_pixel_scene4_alt",
0x70d79e: "load_gunpowderpool_01",
0x70d79f: "unknown_70d79f",
0x70d7a1: "load_gunpowderpool_04",
0x7868ff: "load_gunpowderpool_02",
0xc35700: "load_oiltank",
0xff0080: "load_pixel_scene2",
0xff00ff: "unknown_ff00ff",
0xff0aff: "load_pixel_scene",
*/

export function getSpawnFunctionIndex(biomeName, color) {
	if (!BIOME_SPAWN_FUNCTION_MAP[biomeName]) return null;
	const spawnFunctions = BIOME_SPAWN_FUNCTION_MAP[biomeName];
	for (let i = 0; i < spawnFunctions.length; i++) {
		if (spawnFunctions[i].color === color) {
			return i; // Ignore whether it's active here?
			//if (spawnFunctions[i].active) return i;
			//break;
		}
	}
	return null;
}

function hiisi_safe(x, y) {
	if (x >= 125 && x <= 249 && y >= 5118 && y <= 5259) return false;
	if (y > 6100) return false;
	return true;
}

// Kind of seems like they forgot to use this
/*
function vault_safe(x, y) {
	if (x >= 125 && x <= 249 && y >= 8594 && y <= 8860) return false;
	return true;
}
*/

// TODO: Parallel check? Also add other time based spawn checks
function spawnFromTable(ws, ng, x, y, table) {
	let total = 0;
	for (const entry of table) {
		if (entry.ngpluslevel !== undefined && ng < entry.ngpluslevel) continue;
		if (entry.spawn_check !== undefined) {
			if (entry.spawn_check === 'christmas' && (appSettings.date.month !== 12 || appSettings.date.day < 24 || appSettings.date.day > 26)) continue;
			if (entry.spawn_check === 'august24' && (appSettings.date.month !== 8 || appSettings.date.day !== 24)) continue;
			if (entry.spawn_check === 'jussi' && (appSettings.date.month !== 6 || appSettings.date.day < 19 || appSettings.date.day > 25)) continue;
		}
		total += entry.prob;
	}
	const prng = new NollaPrng(0);
	let r = prng.ProceduralRandom(ws+ng, x, y) * total;
	for (const entry of table) {
		if (entry.ngpluslevel !== undefined && ng < entry.ngpluslevel) continue;
		if (entry.spawn_check !== undefined) {
			if (entry.spawn_check === 'christmas' && (appSettings.date.month !== 12 || appSettings.date.day < 24 || appSettings.date.day > 26)) continue;
			if (entry.spawn_check === 'august24' && (appSettings.date.month !== 8 || appSettings.date.day !== 24)) continue;
			if (entry.spawn_check === 'jussi' && (appSettings.date.month !== 6 || appSettings.date.day < 19 || appSettings.date.day > 25)) continue;
		}
		if (r <= entry.prob) {
			return entry;
		}
		r -= entry.prob;
	}
	return null;
}

function spawnTowerEnemies(ws, ng, x, y) {
	if (x >= 9676 && x <= 9804 && y >= 9806 && y <= 9214) return null;
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x, y);
	let rnd = prng.Random(1, TOWER_ENEMIES.length);
	let target = TOWER_ENEMIES[rnd-1];
	return {type: 'enemies', items: [{type: 'entity', entity: target, x: x, y: y}], x: x, y: y};
}

// entity_load_camera_bound
export function spawnWithRandomOffset(ws, ng, x, y, spawnChoice, offsetX=5, offsetY=5, gameMode='normal', perks={}) {
	let spawns = [];
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x+offsetX, y+offsetY);
	const givePerk = (gameMode === 'nightmare') ? prng.Random(1, 15) === 1 : false;
	let giveWand = (gameMode === 'nightmare') ? prng.Random(1, 20) === 1 : false;
	const minCount = spawnChoice.min_count !== undefined ? spawnChoice.min_count : 1;
	const maxCount = spawnChoice.max_count !== undefined ? spawnChoice.max_count : 1;
	if (spawnChoice.entities !== undefined) {
		// Multiple entities in a group
		for (let j = 0; j < spawnChoice.entities.length; j++) {
			const entity = spawnChoice.entities[j];
			if (typeof entity === 'object') {
				const entityMinCount = entity.min_count !== undefined ? entity.min_count : 1;
				const entityMaxCount = entity.max_count !== undefined ? entity.max_count : entityMinCount;
				let count = entityMinCount + prng.ProceduralRandom(ws + ng, x+j+offsetX, y+offsetY) * (entityMaxCount - entityMinCount);
				for (let i = 1; i <= count; i++) {
					let px = x + offsetX - 4 + prng.ProceduralRandom(ws + ng, x+j+offsetX, y+i+offsetY) * 8;
					let py = y + offsetY - 4 + prng.ProceduralRandom(ws + ng, x+j+offsetX, y+i+offsetY) * 8;
					if (!appSettings.showEnemies) continue;
					const cleanEntity = entity.entity.split("/").pop().replace(".xml", "");
					spawns.push({type: 'entity', entity: cleanEntity, x: px, y: py});
				}
			}
			else {
				let px = x + offsetX - 4 + prng.ProceduralRandom(ws + ng, x+j+offsetX, y+offsetY) * 8;
				let py = y + offsetY - 4 + prng.ProceduralRandom(ws + ng, x+j+offsetX, y+offsetY) * 8;
				if (!appSettings.showEnemies) continue;
				const cleanEntity = entity.split("/").pop().replace(".xml", "");
				spawns.push({type: 'entity', entity: cleanEntity, x: px, y: py});
			}
		}
	}
	if (spawnChoice.entity !== undefined) {
		// Just one entity
		let count = minCount + prng.ProceduralRandom(ws + ng, x+offsetX, y+offsetY) * (maxCount - minCount);
		for (let i = 1; i <= count; i++) {
			let px = x + offsetX - 4 + prng.ProceduralRandom(ws + ng, x+i+offsetX, y+offsetY) * 8;
			let py = y + offsetY - 4 + prng.ProceduralRandom(ws + ng, x+i+offsetX, y+offsetY) * 8;
			//let enemyPerk = null;
			if (givePerk) {
				// TODO: Enemy perks (I don't really care that much right now)
			}
			// Instead of "giving" the enemy the wand, we'll just show it as its own thing...
			if (giveWand) {
				const wand = generateNightmareWand(ws, ng, px, py, spawnChoice.entity, perks);
				if (wand) {
					spawns.push(wand);
				}
				else {
					giveWand = false;
				}
			}
			if (spawnChoice.entity.includes('wand_ghost')) giveWand = true; // Generating the wand later
			if (!appSettings.showEnemies && !giveWand ) continue;
			const cleanEntity = spawnChoice.entity.split("/").pop().replace(".xml", "");
			spawns.push({type: 'entity', entity: cleanEntity, x: px, y: py});
		}
	}
	return spawns;
}

function spawnEntities(ws, ng, x, y, spawnList, gameMode='normal', perks={}, offsetX=5, offsetY=5) {
	let spawnChoice = spawnFromTable(ws, ng, x, y, spawnList);
	if (spawnChoice && ((spawnChoice.entity !== undefined && spawnChoice.entity !== "") || (spawnChoice.entities !== undefined && spawnChoice.entities.length > 0))) {
		let result = spawnWithRandomOffset(ws, ng, x, y, spawnChoice, offsetX, offsetY, gameMode, perks);
		return result;
	}
	return null;
}

// Might just make this cover all colors?
export function spawnSwitch(biomeData, biomeName, functionIndex, ws, ng, x, y, skipCosmeticScenes=true, perks={}, gameMode='normal', trustBiome=false) {
	// trustBiome=true: caller already resolved the biome for this spawn point
	// (used for pixel-scene-internal spawns), so skip local biome re-resolution.
	if (!trustBiome) {
		// Block spawns if near chunk boundary (only on negative side, this is what the game appears to do)
		if (appSettings.blockEdgeSpawns) {
			const offsetX = ((x % 512) + 512) % 512;
			const offsetY = ((y % 512) + 512) % 512;
			// Don't spawn anything within 5 pixels of the chunk edge, but only on the negative side.
			if (offsetX >= 507 || offsetY >= 507) return null;
		}
		// Adjust biome with edge noise
		const adjustedBiomeResults = getBiomeAtWorldCoordinates(biomeData, x, y, ng > 0, gameMode);
		// Attempt to exclude edge cases if the biome is different after edge noise
		if (appSettings.excludeEdgeCases && adjustedBiomeResults.biome !== adjustedBiomeResults.origBiome) {
			//console.log(`Excluding spawn at (${x}, ${y}) in biome ${biomeName} due to edge noise uncertainty`);
			return null; // Don't spawn anything if this is an edge case and we're excluding them
		}
		
		biomeName = adjustedBiomeResults.biome;
	}

	const spawns = BIOME_SPAWN_FUNCTION_MAP[biomeName];
	if (!spawns) {
		//console.warn(`No spawn mapping for ${biomeName}, trying to spawn at (${x}, ${y}) with function index ${functionIndex}`);
		return;
	}
	let func;
	if (functionIndex >= spawns.length) {
		//console.warn(`Function index ${functionIndex} out of bounds for biome ${biomeName}, trying to spawn at (${x}, ${y})`);
		return;
	}
	const spawn = spawns[functionIndex];
	if (spawn) {
		func = spawn.funcName;
		if (spawn.active === false) {
			return; // Inactive spawn, don't spawn anything
		}
	}
	else {
		console.warn(`No spawn function at index ${functionIndex} for biome ${biomeName}, trying to spawn at (${x}, ${y})`);
		return;
	}
	if (!func) {
		console.warn(`No spawn function at index ${functionIndex} for biome ${biomeName}, trying to spawn at (${x}, ${y})`);
		return;
	}

	// For a small subset of item/wand functions, remap through the wobbled biome.
	// If the wobbled biome has no matching color entry at this index, drop the spawn.
	if (WOBBLE_REMAP_FUNCS.has(func)) {
		const wob = getBiomeAtWorldCoordinates(biomeData, x, y, ng > 0, gameMode, true);
		if (wob && wob.biome && wob.biome !== biomeName) {
			const color = spawns[functionIndex] && spawns[functionIndex].color;
			const wobIdx = color != null ? getSpawnFunctionIndex(wob.biome, color) : null;
			if (wobIdx === null) return null;
			const wobSpawns = BIOME_SPAWN_FUNCTION_MAP[wob.biome];
			const wobSpawn = wobSpawns && wobSpawns[wobIdx];
			if (!wobSpawn || wobSpawn.active === false || !wobSpawn.funcName) return null;
			biomeName = wob.biome;
			functionIndex = wobIdx;
			func = wobSpawn.funcName;
		}
	}

	const scenes = PIXEL_SCENE_BIOME_MAP[biomeName];
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x, y);

	// Specific biome spawn functions

	// Coalmine
	if (biomeName === "coalmine") {
		if (func === "load_pixel_scene") {
			if (prng.Random(1, 100) > 50)
				return loadRandomPixelScene(biomeData, biomeName, PIXEL_SCENE_BIOME_MAP[biomeName]["g_oiltank"], ws, ng, x, y, skipCosmeticScenes, gameMode);
			else
				return loadRandomPixelScene(biomeData, biomeName, PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_01"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_oiltank") {
			if (prng.Random(1, 100) <= 50) {
				return loadRandomPixelScene(biomeData, biomeName, scenes["g_oiltank"], ws, ng, x, y, skipCosmeticScenes, gameMode);
			}
			else {
				return loadRandomPixelScene(biomeData, biomeName, scenes["g_pixel_scene_01"], ws, ng, x, y, skipCosmeticScenes, gameMode);
			}
		}
		else if (func === "load_oiltank_alt") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_oiltank_alt"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_trapwand") {
			const options = ["premade_1", "premade_2", "premade_3", "premade_4", "premade_5", "premade_6", "premade_7", "premade_8", "premade_9", "wand_level_01"];
			let rnd = prng.Random(1, options.length);
			let wandType = options[rnd-1];
			return generateWand(ws, ng, x, y, wandType, perks);
		}
		else if (func === "spawn_bbqbox") {
			//prng.SetRandomSeed(x, y);
			if (prng.Random(1, 100) <= 99) {
				//console.log('BBQ box spawning heart');
				// Doesn't actually call spawnHeart, just directly spawns a heart?
				// TODO: Doubt?
				return spawnHeart(ws, ng, x+10, y+10, biomeName, perks); // {type: 'item', item: 'heart', x: x+10, y: y+10};
			}
			else {
				return spawnJar(x, y);
			}
		}
		else if (func === "spawn_swing_puzzle_target") {
			const chest = spawnChest(ws, ng, x - 75, y - 70, false, perks, gameMode);
			return {type: 'puzzle', materials: 'electricity', items: chest.items, x: x - 75, y: y - 70};
		}
		else if (func === "spawn_oiltank_puzzle") {
			// TODO: Wand from this puzzle?
			//console.log("Spawning oiltank puzzle at", x, y);
			const materials = ["water", "blood", "alcohol", "radioactive_liquid", "water_salt", "slime", "water", "blood", "alcohol", "radioactive_liquid", "water_salt", "slime", "magic_liquid_berserk", "magic_liquid_charm", "oil"];
			const choice = prng.ProceduralRandomi(ws + ng, x, y, 1, materials.length);
			console.log(`Oiltank puzzle material choice: ${materials[choice-1]}`); // Material not actually relevant to the puzzle
			// Might be better to recolor the pixel scene with it instead, even though it technically spawns a material spawner and not a pool of the material
			const chest = spawnChest(ws, ng, x, y - 25, false, perks, gameMode);
			return {type: 'puzzle', materials: materials[choice-1], items: chest.items, x: x, y: y - 25};
		}
		else if (func === "spawn_receptacle_oil") {
			const wand = spawnSpecialWand(ws, ng, x + 72, y - 22, "ruusu");
			const potion = {type: 'item', item: 'potion_empty', x: x + 72, y: y - 17};
			return {type: 'puzzle', materials: 'oil', items: [wand, potion, {type: 'item', item: 'oil_receptacle_puzzle', x: x, y: y, ignore: true}], x: x + 72, y: y - 22}; // Include dummy item for searching
		}
		else if (func === "spawn_potion" || func === "spawn_props3") {
			let r = prng.Next() * 0.4; //prng.ProceduralRandom(ws + ng, x, y) * 0.4;
			if (r > 0.1) {
				// No idea why this offset works, it was supposed to be x, y+5 based on the Lua but this is what works...
				return createPotion(ws, ng, x+5, y, 'normal', gameMode);
			}
			else {
				return null;
			}
		}
		// TODO: Enemy spawning is just barely off from the default here
		/*
		else if (func === "spawn_small_enemies") {
			const r = prng.ProceduralRandom(ws + ng, x, y);
			// Get vertical position inside biome?
			const spawn_percent = 2.5*biomeVerticalPosition + 0.35;
			if (r > spawn_percent) return null;
			spawn(g_small_enemies,x,y)
		}
		else if (func === "spawn_big_enemies") {
			const r = prng.ProceduralRandom(ws + ng, x, y);
			// Get vertical position inside biome?
			const spawn_percent = 2.1*biomeVerticalPosition;
			if (r > spawn_percent) return null;
			spawn(g_big_enemies,x,y)
		}
		*/
	}
	else if (biomeName === "excavationsite") {
		if (func === "load_puzzleroom") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_puzzleroom"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_gunpowderpool_01") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_gunpowderpool_01"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_gunpowderpool_02") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_gunpowderpool_02"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_gunpowderpool_03") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_gunpowderpool_03"], ws, ng, x-3, y+3, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_gunpowderpool_04") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_gunpowderpool_04"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_meditation_cube") {
			let rnd = prng.Random(1, 100);
			if (rnd > 96 && gameMode !== 'nightmare') {
				return loadPixelScene(biomeData, biomeName, "meditation_cube_visual", ws, ng, x-20, y-29, skipCosmeticScenes, false, gameMode);
				//return {type: 'item', item: 'meditation_cube', x: x, y: y};
			}
		}
		else if (func === "spawn_receptacle") {
			const wand = spawnSpecialWand(ws, ng, x, y - 25, "kiekurakeppi");
			return {type: 'puzzle', materials: 'steam', items: [wand, {type: 'item', item: 'steam_receptacle_puzzle', x: x, y: y, ignore: true}], x: x, y: y - 25}; // Include dummy item for searching
		}
		// TODO: Enemy spawning is just barely off from the default here
		/*
		else if (func === "spawn_small_enemies") {
			const r = prng.ProceduralRandom(ws + ng, x, y);
			// Get vertical position inside biome?
			const spawn_percent = 2.1*biomeVerticalPosition + 0.2;
			if (r > spawn_percent) return null;
			//spawn_with_limited_random(g_small_enemies,x,y,0,0,{"longleg","fungus"})
		}
		else if (func === "spawn_big_enemies") {
			const r = prng.ProceduralRandom(ws + ng, x, y);
			// Get vertical position inside biome?
			const spawn_percent = 1.75*biomeVerticalPosition - 0.1;
			if (r > spawn_percent) return null;
			//spawn_with_limited_random(g_big_enemies,x,y,0,0,{"longleg","fungus"})
		}
		*/
	}
	else if (biomeName === "snowcave") {
		if (func === "load_puzzle_capsule") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_puzzle_capsule"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_puzzle_capsule_b") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_puzzle_capsule_b"], ws, ng, x-50, y-230, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_acidtank_right") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_acidtank_right"], ws, ng, x-12, y-12, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_acidtank_left") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_acidtank_left"], ws, ng, x-252, y-12, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_buried_eye_teleporter") {
			return {type: 'item', item: 'buried_eye_teleporter', x: x, y: y};
		}
		else if (func === "spawn_receptacle") {
			const wand = spawnSpecialWand(ws, ng, x, y - 85, "valtikka");
			return {type: 'puzzle', materials: 'water', items: [wand, {type: 'item', item: 'water_receptacle_puzzle', x: x, y: y, ignore: true}], x: x, y: y - 85}; // Include dummy item for searching
		}
	}
	else if (biomeName === "snowcastle") {
		if (func === "load_pixel_scene" || func === "load_pixel_scene2") {
			if (!hiisi_safe(x, y)) return null;
			// Handled by default otherwise
		}
		if (func === "spawn_brimstone") {
			return {type: 'item', item: 'kiuaskivi', x: x, y: y};
		}
		else if (func === "spawn_vasta_or_vihta") {
			if(x > 190) {
				return spawnSpecialWand(ws, ng, x, y, "vasta");
			}
			else {
				return spawnSpecialWand(ws, ng, x, y, "vihta");
			}
		}
		else if (func === "load_chamfer_top_r") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_top_r", ws, ng, x-10, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_top_l") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_top_l", ws, ng, x-1, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_bottom_r") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_bottom_r", ws, ng, x-10, y-20, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_bottom_l") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_bottom_l", ws, ng, x-1, y-20, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_inner_top_r") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_inner_top_r", ws, ng, x-10, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_inner_top_l") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_inner_top_l", ws, ng, x, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_inner_bottom_r") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_inner_bottom_r", ws, ng, x-10, y-20, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_chamfer_inner_bottom_l") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "chamfer_inner_bottom_l", ws, ng, x, y-20, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_pillar_filler") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "pillar_filler_01", ws, ng, x, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_pillar_filler_tall") {
			if (!hiisi_safe(x, y)) return null;
			return loadPixelScene(biomeData, biomeName, "pillar_filler_tall_01", ws, ng, x, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "load_pod_large") {
			if (!hiisi_safe(x, y)) return null;
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pods_large"], ws, ng, x, y-50, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_pod_small_l") {
			if (!hiisi_safe(x, y)) return null;
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pods_small_l"], ws, ng, x-30, y-40, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_pod_small_r") {
			if (!hiisi_safe(x, y)) return null;
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pods_small_r"], ws, ng, x-10, y-40, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_potion" || func === "spawn_props3") {
			// 0.1 nothing, 0.3 green, 0.3 red, 0.3 blue, 0.2 yellow, 0.1 alcohol, 0.025 potion
			let r = prng.Next() * 1.325;
			if (r > 1.3) {
				// No idea why this offset works, it was supposed to be x, y+5 based on the Lua but this is what works...
				return createPotion(ws, ng, x+5, y, 'normal', gameMode);
			}
			else if (r > 1.2) {
				return {type: 'item', item: 'potion', material: 'alcohol', x: x+5, y: y};
			}
			else {
				return null;
			}
		}
		else if (func === "spawn_chef") {
			return {type: 'enemies', items: [{type: 'entity', entity: 'chef', x: x, y: y}], x: x, y: y};
		}
	}
	else if (biomeName === "rainforest" || biomeName === "rainforest_open") {
		// Note this is not implemented for the vault, even though the function exists
		if (func === "spawn_dragonspot") {
			return getDragonDrops(ws, ng, biomeName, x, y, perks);
		}
	}
	else if (biomeName === "vault" || biomeName === "vault_frozen") {
		if (func === "load_pixel_scene_wide") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pixel_scene_wide"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_pixel_scene_tall") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pixel_scene_tall"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_stains") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_stains"], ws, ng, x-10, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_stains_ceiling") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_stains_ceiling"], ws, ng, x-20, y-10, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_laser_trap") {
			return loadPixelScene(biomeData, biomeName, "hole", ws, ng, x, y, skipCosmeticScenes, true, gameMode);
		}
		else if (func === "spawn_lab_puzzle") {
			//console.log("Spawning lab puzzle at", x, y);
			const type_a = ["poly", "tele", "charm", "berserk"];
			const type_b = ["protect", "worm", "invis", "speed"];
			const firstMaterial = prng.Random(1, type_a.length);
			const secondMaterial = prng.Random(1, type_b.length);

			const material_conversions = {
				"poly": "polymorphine, chaotic polymorphine",
				"tele": "teleportatium, unstable teleportatium",
				"charm": "pheromone, healthium, lively concoction",
				"berserk": "berserkium",
				"protect": "ambrosia",
				"worm": "worm blood, worm pheromone",
				"invis": "invisiblium",
				"speed": "acceleratium, levitatium, hastium",
			}
			//const materials = "Any of: " + material_conversions[type_a[firstMaterial-1]] + ", " + material_conversions[type_b[secondMaterial-1]];
			const materialL = material_conversions[type_a[firstMaterial-1]];
			const materialR = material_conversions[type_b[secondMaterial-1]];
			
			//const r = prng.ProceduralRandom(ws + ng, x, y);
			const rL = prng.ProceduralRandom(ws + ng, x-10, y);
			let wandL;
			let searchItemL;
			if (rL > 0.3) {
				wandL = spawnSpecialWand(ws, ng, x-10+70, y+10, "arpaluu");
				searchItemL = {type: 'item', item: 'vault_puzzle_arpaluu', x: x-10+70, y: y+10, ignore: true};
			}
			else {
				wandL = spawnSpecialWand(ws, ng, x-10+70, y+10, "varpuluuta");
				searchItemL = {type: 'item', item: 'vault_puzzle_varpuluuta', x: x-10+70, y: y+10, ignore: true};
			}
			const rR = prng.ProceduralRandom(ws + ng, x+11, y);
			let wandR;
			let searchItemR;
			if (rR > 0.3) {
				wandR = spawnSpecialWand(ws, ng, x+11+70, y+10, "arpaluu");
				searchItemR = {type: 'item', item: 'vault_puzzle_arpaluu', x: x+11+70, y: y+10, ignore: true};
			}
			else {
				wandR = spawnSpecialWand(ws, ng, x+11+70, y+10, "varpuluuta");
				searchItemR = {type: 'item', item: 'vault_puzzle_varpuluuta', x: x+11+70, y: y+10, ignore: true};
			}
			return {
				type: 'vault_puzzle',
				materials: [materialL, materialR],
				items: [wandL, searchItemL, wandR, searchItemR], // Include dummy items for searching
				x: x+70,
				y: y+10,
			};
		}
		else if (func === "spawn_pipes_hor") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_hor"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_ver") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_ver"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_turn_right") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_turn_right"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_turn_left") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_turn_left"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_cross") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_cross"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_big_hor") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_big_hor"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_big_ver") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_big_ver"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_big_turn_right") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_big_turn_right"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_pipes_big_turn_left") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pipes_big_turn_left"], ws, ng, x, y, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_catwalk") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_catwalks"], ws, ng, x, y-20, skipCosmeticScenes, gameMode);
		}
	}
	else if (biomeName === "crypt" || biomeName === "wizardcave") {
		if (func === "load_beam") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_beam"], ws, ng, x, y-65, skipCosmeticScenes, gameMode);
		}
		else if (func === "load_cavein") {
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_cavein"], ws, ng, x-60, y-10, skipCosmeticScenes, gameMode);
		}
	}
	else if (biomeName === "liquidcave") {
		if (func === "load_pixel_scene") {
			// Took me way too long to realize this one has a custom offset
			// TODO: Get the material for this and add as PoI maybe? idk
			return loadRandomPixelScene(biomeData, biomeName, scenes["g_pixel_scene_01"], ws, ng, x-5, y-3, skipCosmeticScenes, gameMode);
		}
		else if (func === "spawn_lasergun") {
			return {type: 'enemies', items: [{type: 'entity', entity: 'lasergun', x: x, y: y}], x: x, y: y};
		}
	}
	else if (biomeName === "the_end" || biomeName === "the_sky") {
		if (func === "spawn_heart" || func === "spawn_potions" || func === "spawn_wands" || func === "spawn_potion_altar") {
			// Hell specifically disables these function despite having spawn pixels for hearts/chests
			// Note that this does not apply to the hell version of the tower, which actually can spawn hearts (from what I have seen)
			return null;
		}
		else if (func === "spawn_shopitem") {
			if (prng.Random(1, 50) === 1) {
				return generateShopItem(ws, ng, x, y, BIOME_TIERS[biomeName], 0);
			}
			else {
				return null;
			}
		}
		else if (func === "spawn_specialshop") {
			return generateShopItem(ws, ng, x, y, BIOME_TIERS[biomeName], 0);
		}
	}
	// TODO: Generalize this better, it applies to many side biomes.
	else if (biomeName === "wandcave") {
		if (func === "spawn_potions" || func === "spawn_wands") {
			// Wandcave disables these functions despite having spawn pixels for them
			return null;
		}
	}
	else if (biomeName === "biome_watchtower" || biomeName === "biome_barren" || biomeName === "biome_potion_mimics" || biomeName === "biome_darkness" || biomeName === "biome_boss_sky") {
		// I thought these would make cool overlaps but I think they're not actually possible at all, the cloudscape doesn't have much, and the watchtower isn't in NG+, and even if it was it wouldn't overlap with any of these
		/*
		if (func === "spawn_boss") {
			if (x < 16000 && x > -16000) {
				return {type: 'item', item: 'kivi', x: x, y: y};
			}
			else {
				return null;
			}
		}
		else if (func === "spawn_boss_phase2_marker") {
			if (x < 16000 && x > -16000) {
				return {type: 'item', item: 'kummitus', x: x+7, y: y};
			}
			else {
				return null;
			}
		}
		else if (func === "spawn_potion_mimic_empty") {
			if (x < 16000 && x > -16000) {
				return {type: 'item', item: 'potion_mimic_empty', x: x, y: y};
			}
			else {
				return null;
			}
		}
		*/
		if (func === "spawn_potion_mimic") {
			if (x < 16000 && x > -16000) {
				return {type: 'item', item: 'mimic_potion', x: x, y: y};
			}
			else {
				return null;
			}
		}
		else if (func === "spawn_potion_beer") {
			return {type: 'item', item: 'potion', material: 'beer', x: x, y: y-5};
		}
		else if (func === "spawn_potion_milk") {
			return {type: 'item', item: 'potion', material: 'milk', x: x, y: y-5};
		}
		else if (func === "spawn_potions" || func === "spawn_wands") {
			return null; // disabled
		}
	}
	else if (biomeName === "meat") {
		if (func === "spawn_mouth") {
			if (!appSettings.showEnemies) return null;
			if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].mouth) {
				let spawnList = BIOME_ENEMY_MAP[biomeName].mouth;
				let offsetX = 5 + prng.Random(-10, 10);
				let offsetY = 5 + prng.Random(-10, 10);
				let entities = spawnEntities(ws, ng, x+offsetX, y+offsetY, spawnList, gameMode, perks);
				if (entities && entities.length > 0) {
					return {type: 'enemies', items: entities, x: x+offsetX, y: y+offsetY, biome: biomeName};
				}
			}
			return null;
		}
	}

	// Default functions come after biome-specific ones
	if (func === "spawn_shopitem") {
		// TODO: The default version of this assumes tier 10, but it's not clear which biomes that would apply to.
		// Also this behavior is overwritten in some weird places like winter_caves
		return generateShopItem(ws, ng, x, y, BIOME_TIERS[biomeName], 0);
	}
	// Enemies (TODO: At minimum need taikasauva)
	else if (func === "spawn_small_enemies" || func === "spawn_small_enemies2") {
		if (!appSettings.showEnemies && biomeName !== "wandcave" && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].small) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].small;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				if (biomeName === "wandcave") {
					// Taikasauva, special case
					let px = roundHalfOfEven(entities[entities.length-1].x);
					let py = roundHalfOfEven(entities[entities.length-1].y);
					const wand = generateWand(ws, ng, px, py, "wand_level_03", perks);
					if (wand) {
						wand['name'] = "Taikasauva";
					}
					// This would be more consistent with what is actually happening, the wand ghost enemy holds the wand,
					// However it just ends up looking confusing because the icon for the wand ghost is the same as the summon taikasauva spell
					// and also it makes searching for that spell more difficult
					// So instead let's just treat it as a normal wand spawn
					//entities.push(wand);
					return wand;
				}
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	if (func === "spawn_big_enemies" || func === "spawn_big_enemies2") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].big) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].big;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_unique_enemy") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].unique) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].unique;
			let offsetX = (biomeName === 'crypt' || biomeName === 'pyramid' || biomeName === 'wizardcave') ? -1 : 0;
			let offsetY = (biomeName === 'rainforest' || biomeName === 'rainforest_open' || biomeName === 'rainforest_dark') ? 12 : 0; // Who knows
			let entities = spawnEntities(ws, ng, x+offsetX, y+offsetY, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x+offsetX, y: y+offsetY, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_unique_enemy2") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].unique2) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].unique2;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_unique_enemy3") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].unique3) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].unique3;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_large_enemies") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].large) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].large;
			let offsetX = (biomeName === 'crypt' || biomeName === 'pyramid' || biomeName === 'wizardcave') ? -1 : 0;
			let entities = spawnEntities(ws, ng, x+offsetX, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x+offsetX, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_turret") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].turret) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].turret;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_ghost_crystal") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].ghost_crystal) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].ghost_crystal;
			let offsetX = (biomeName === 'crypt' || biomeName === 'pyramid' || biomeName === 'wizardcave') ? -1 : 0;
			let entities = spawnEntities(ws, ng, x+offsetX, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x+offsetX, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_nest") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].nest) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].nest;
			let offsetX = (biomeName === 'excavationsite' || biomeName === 'coalmine' || biomeName === 'coalmine_alt') ? 4 : 0; // Who knows
			let offsetY = biomeName === 'excavationsite' ? 8 : 0; // Who knows
			let entities = spawnEntities(ws, ng, x+offsetX, y+offsetY, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x+offsetX, y: y+offsetY, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_fungi") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (biomeName.includes("tower")) return spawnTowerEnemies(ws, ng, x, y);
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].fungi) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].fungi;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_robots") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].robots) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].robots;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_scavengers") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].scavengers) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].scavengers;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_scavenger_party") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].scavenger_party) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].scavenger_party;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_fish") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].fish) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].fish;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	else if (func === "spawn_scorpions" || func === "spawn_scorpion") {
		if (!appSettings.showEnemies && gameMode !== 'nightmare') return null;
		if (BIOME_ENEMY_MAP[biomeName] && BIOME_ENEMY_MAP[biomeName].scorpions) {
			let spawnList = BIOME_ENEMY_MAP[biomeName].scorpions;
			let entities = spawnEntities(ws, ng, x, y, spawnList, gameMode, perks);
			if (entities && entities.length > 0) {
				return {type: 'enemies', items: entities, x: x, y: y, biome: biomeName};
			}
		}
		return null;
	}
	// Props
	/*
	else if (func === "spawn_props") {

	}
	else if (func === "spawn_props2") {

	}
	*/
	// Used for potions in some areas (potion laboratory in mines, hiisi base bar, as implemented above), other props are not interesting
	/*
	else if (func === "spawn_props3") {

	}
	*/
	/*
	else if (func === "spawn_lamp") {

	}
	else if (func === "spawn_ghostlamp") {

	}
	*/
	// Kummitus spawns (might be nice, though we can't really predict the bones wands)
	/*
	else if (func === "spawn_candles") {

	}
	else if (func === "spawn_apparition") {

	}
	*/
	// Other junk I don't care about
	/*
	else if (func === "spawn_portal") {

	}
	else if (func === "spawn_end_portal") {

	}
	else if (func === "spawn_orb") {

	}
	else if (func === "spawn_perk") {

	}
	else if (func === "spawk_all_perks") {

	}
	else if (func === "spawn_wand_trap") {

	}
	else if (func === "spawn_wand_trap_ignite") {

	}
	else if (func === "spawn_wand_trap_electricity_source") {

	}
	else if (func === "spawn_wand_trap_electricity") {

	}
	else if (func === "spawn_moon") {

	}
	else if (func === "spawn_collapse") {

	}
	*/
	// Wand altar (just called "items")
	else if (func === "spawn_wand_altar" || func === "spawn_items") {
		// TODO: Block spawn for specific biomes where it's explicitly overwritten to not generate, low priority since it would require specific overlaps
		const checkResult = checkWandAltar(ws, ng, x, y, biomeName);
		if (checkResult === 'utility_box') {
			return generateUtilityBox(ws, ng, x, y, perks, gameMode);
		}
		else if (checkResult) {
			let offsetX = -10;
			let offsetY = -17;
			if (BIOME_WAND_ALTAR_OFFSET_MAP[biomeName]) {
				offsetX = BIOME_WAND_ALTAR_OFFSET_MAP[biomeName].x;
				offsetY = BIOME_WAND_ALTAR_OFFSET_MAP[biomeName].y;
			}
			if (BIOMES_WITH_SMALL_ALTARS.includes(biomeName)) {
				// Small altar
				return loadPixelScene(biomeData, biomeName, "wand_altar_vault", ws, ng, x+offsetX, y+offsetY, skipCosmeticScenes, false, gameMode);
			}
			else {
				// Normal size altar
				return loadPixelScene(biomeData, biomeName, "wand_altar", ws, ng, x+offsetX, y+offsetY, skipCosmeticScenes, false, gameMode);
			}
		}
		else {
			return null;
		}
	}
	else if (func === "spawn_wand" || func === "spawn_wands") {
		return spawnWand(ws, ng, x, y, biomeName, perks);
	}
	else if (func === "spawn_potion_altar") {
		const checkResult = checkPotionAltar(ws, ng, x, y, biomeName);
		if (checkResult) {
			let offsetX = -5;
			let offsetY = -15;
			if (BIOME_POTION_ALTAR_OFFSET_MAP[biomeName]) {
				offsetX = BIOME_POTION_ALTAR_OFFSET_MAP[biomeName].x;
				offsetY = BIOME_POTION_ALTAR_OFFSET_MAP[biomeName].y;
			}
			if (BIOMES_WITH_SMALL_ALTARS.includes(biomeName)) {
				// Small altar
				return loadPixelScene(biomeData, biomeName, "potion_altar_vault", ws, ng, x+offsetX, y+offsetY, skipCosmeticScenes, false, gameMode);
			}
			else {
				// Normal size altar
				return loadPixelScene(biomeData, biomeName, "potion_altar", ws, ng, x+offsetX, y+offsetY, skipCosmeticScenes, false, gameMode);
			}
		}
		else {
			return null;
		}
	}
	else if (func === "spawn_potion" || func === "spawn_potions") {
		return spawnItem(ws, ng, x, y, biomeName, perks, gameMode);
	}
	else if (func === "spawn_heart") {
		return spawnHeart(ws, ng, x, y, biomeName, perks, gameMode);
	}
	// Not technically a default spawn function, used for mines and tower
	else if (func === "spawn_chest") {
		// Note *only* tower has the higher GTC rate without greed curse
		return spawnChest(ws, ng, x, y, biomeName.includes('tower'), perks, gameMode);
	}
	// Also not technically default, used for mines and snowy depths
	else if (func === "load_altar") {
		//console.log("Spawning altar pixel scene at", x, y);
		return loadPixelScene(biomeData, biomeName, "trailer_altar", ws, ng, x-92, y-96, skipCosmeticScenes, true, gameMode);
	}
	else if (func === "spawn_treasure") {
		// TODO: This is probably better as an isolated spell but it's easier to set up as an item
		return {type: 'item', item: 'treasure', x: x, y: y};
	}
	else if (func === "spawn_specialshop") {
		// Apparently this is broken and doesn't actually spawn the spells, instead it just gets a Lua error.
		/*
		console.log("Spawning special shop at", x, y);
		if (y > -3000 && y < 1000) {
			return generateShopItem(ws, ng, x, y, 0, 0);
		}
		else {
			return generateShopItem(ws, ng, x, y, 10, 0);
		}
		*/
	}
	else if (func === "spawn_music_machine") {
		return {type: 'item', item: 'music_machine', x: x, y: y};
	}
	// Default pixel scenes (technically only 1 and 2 are, but adding the other reused ones for convenience here)
	if (PIXEL_SCENE_BIOME_MAP[biomeName]) {
		// The lua's `load_pixel_sceneN(x, y)` nudges the position for a few biomes
		// before it rolls, so the offset has to go in here rather than at the stamp
		// -- it moves the ProceduralRandom seed too (PIXEL_SCENE_LIST_OFFSETS).
		const offsets = PIXEL_SCENE_LIST_OFFSETS[biomeName] ?? {};
		const roll = (listName) => {
			const [dx, dy] = offsets[listName] ?? [0, 0];
			return loadRandomPixelScene(biomeData, biomeName, scenes[listName], ws, ng,
				x + dx, y + dy, skipCosmeticScenes, gameMode);
		};
		if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_01"] && func === "load_pixel_scene") {
			return roll("g_pixel_scene_01");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_01_alt"] && func === "load_pixel_scene_alt") {
			return roll("g_pixel_scene_01_alt");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_02"] && func === "load_pixel_scene2") {
			return roll("g_pixel_scene_02");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_03"] && func === "load_pixel_scene3") {
			return roll("g_pixel_scene_03");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_04"] && func === "load_pixel_scene4") {
			return roll("g_pixel_scene_04");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_04_alt"] && func === "load_pixel_scene4_alt") {
			return roll("g_pixel_scene_04_alt");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_05"] && func === "load_pixel_scene5") {
			return roll("g_pixel_scene_05");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_05b"] && func === "load_pixel_scene5b") {
			return roll("g_pixel_scene_05b");
		}
		else if (PIXEL_SCENE_BIOME_MAP[biomeName]["g_pixel_scene_05_alt"] && func === "load_pixel_scene5_alt") {
			return roll("g_pixel_scene_05_alt");
		}
	}
	return null;
}