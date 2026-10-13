// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { ALTAR_SPAWN_DATA } from "./spawn_config.js";
import { unlockedSpells } from "./unlocks.js";
import { POTION_MATERIALS_MAGIC, POTION_MATERIALS_STANDARD, POTION_MATERIALS_SECRET, POTION_LIQUIDS, POTION_SANDS, POWDER_MATERIALS_MAGIC, POTION_MATERIALS_MAGIC_NIGHTMARE, POWDER_MATERIALS_STANDARD } from "./potion_config.js";
import { appSettings } from "./settings.js";

// Just checks whether it should spawn, without spawning the potion/item on it, to refactor for pixel scenes
export function checkPotionAltar(ws, ng, x, y, biome) {
    const prng = new NollaPrng(0);
    if (!ALTAR_SPAWN_DATA[biome]) {
        //console.log(`Unknown biome for altar spawn: ${biome} at (${x}, ${y})`);
        return null;
    }
    if (ALTAR_SPAWN_DATA[biome].gx !== undefined && ALTAR_SPAWN_DATA[biome].gy !== undefined) {
        x += ALTAR_SPAWN_DATA[biome].gx;
        y += ALTAR_SPAWN_DATA[biome].gy;
    }
    // Was r0 ever needed for potions?
    /*
    if (ALTAR_SPAWN_DATA[biome].r0) {
        let r0 = prng.ProceduralRandom( x, y, ws );
        if (r0 >= ALTAR_SPAWN_DATA[biome].r0) {
            return null;
        }
    }
    */
    let r = prng.ProceduralRandom( ws + ng, x, y );
    let rp = (ALTAR_SPAWN_DATA[biome].rp !== undefined) ? ALTAR_SPAWN_DATA[biome].rp : 0.65;
    if (r < rp) {
        return null;
    }

	return true;
}

export function spawnPotionAltar(ws, ng, x, y, biome, perks={}, gameMode = 'normal') {
    const prng = new NollaPrng(0);
    if (!ALTAR_SPAWN_DATA[biome]) {
        //console.log(`Unknown biome for altar spawn: ${biome} at (${x}, ${y})`);
        return null;
    }
    if (ALTAR_SPAWN_DATA[biome].gx !== undefined && ALTAR_SPAWN_DATA[biome].gy !== undefined) {
        x += ALTAR_SPAWN_DATA[biome].gx;
        y += ALTAR_SPAWN_DATA[biome].gy;
    }
    // Was r0 ever needed for potions?
    /*
    if (ALTAR_SPAWN_DATA[biome].r0) {
        let r0 = prng.ProceduralRandom( x, y, ws );
        if (r0 >= ALTAR_SPAWN_DATA[biome].r0) {
            return null;
        }
    }
    */
    let r = prng.ProceduralRandom( ws + ng, x, y );
    let rp = (ALTAR_SPAWN_DATA[biome].rp !== undefined) ? ALTAR_SPAWN_DATA[biome].rp : 0.65;
    if (r < rp) {
        return null;
    }

    let px = (ALTAR_SPAWN_DATA[biome].px !== undefined) ? ALTAR_SPAWN_DATA[biome].px : 0;
    let py = (ALTAR_SPAWN_DATA[biome].py !== undefined) ? ALTAR_SPAWN_DATA[biome].py : 0;

    let itemX = x + px;
    let itemY = y + py;
    let item;// = null;
    if (biome === 'liquidcave') {
        item = generateItemLiquidcave(ws, ng, itemX, itemY, gameMode);
    }
    else {
        item = generateItem(ws, ng, itemX, itemY, perks, gameMode);
    }
    if (!item) {
        return null;
    }
    item['x'] = itemX;
    item['y'] = itemY;
	//if (appSettings.rngInfo) {
	if (appSettings.rngInfo) {
		item['r'] = r;
	}
    item['type'] = 'item';
    return item;
}

// TODO: Add perks for greed die, kind of pointless but technically necessary
export function spawnItem(ws, ng, x, y, biome, perks={}, gameMode = 'normal') {
	let item;// = null;
	//let rx = roundRNGPos(x);
    if (biome === 'liquidcave') {
        item = generateItemLiquidcave(ws, ng, x, y, gameMode);
    }
    else {
        item = generateItem(ws, ng, x, y, perks, gameMode);
    }
    if (!item) {
        return null;
    }
    if (item['x'] === undefined) item['x'] = x;
    if (item['y'] === undefined) item['y'] = y;
	// No longer have access to this :(
	/*
	if (appSettings.rngInfo) {
		item['r'] = r;
	}
	*/
    item['type'] = 'item';
    return item;
}

function generateItem(ws, ng, x, y, perks={}, gameMode = 'normal') {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x, y);
	let rnd = prng.Random(1, 1000);
	if (rnd > 995 && y >= 512 * 3) {
		return {type: 'item', item: 'mimic_potion', x: x, y: y};
	}
	prng.SetRandomSeed(ws + ng, x + 425, y - 243);
	rnd = prng.Random(1, 91);
	if (rnd <= 65) {
		return createPotion(ws, ng, x, y-2, 'normal', gameMode);
	}
	else if (rnd <= 70) {
		return createPowderPouch(ws, ng, x, y-2);
	}
	else if (rnd <= 71) {
		let unlocked = unlockedSpells[363];
		if (unlocked) {
			if (perks['greedCurse']) {
				return {type: 'item', item: 'greed_die', x: x, y: y-12};
			}
			else {
				return {type: 'item', item: 'chaos_die', x: x, y: y-12};
			}
		}
		else {
			return null;
		}
	}
	else if (rnd <= 72) {
		const options = ['runestone_light', 'runestone_fire', 'runestone_magma', 'runestone_weight', 'runestone_emptiness', 'runestone_edges', 'runestone_metal'];
		prng.SetRandomSeed(ws, x + 2617.941, y - 1229.3581);
		rnd = prng.Random(0, 6);
		let runestoneActive = prng.Random(1, 10);
		return {type: 'item', item: options[rnd], active: runestoneActive === 2, x: x, y: y-10};
	}
	else if (rnd <= 73) {
		return {type: 'item', item: 'egg_purple', x: x, y: y-2};
	}
	else if (rnd <= 77) {
		return {type: 'item', item: 'egg_slime', x: x, y: y-2};
	}
	else if (rnd <= 79) {
		return {type: 'item', item: 'egg_monster', x: x, y: y-2};
	}
	else if (rnd <= 83) {
		return {type: 'item', item: 'kiuaskivi', x: x, y: y-2};
	}
	else if (rnd <= 85) {
		return {type: 'item', item: 'ukkoskivi', x: x, y: y-2};
	}
	else if (rnd <= 89) {
		return {type: 'item', item: 'broken_wand', x: x, y: y-2};
	}
	else {
		if (perks['greedCurse']) {
			return {type: 'item', item: 'greed_orb', x: x, y: y-2};
		}
		else {
			return {type: 'item', item: 'shiny_orb', x: x, y: y-2};
		}
	}
}

function generateItemLiquidcave(ws, ng, x, y, gameMode = 'normal') {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x + 425, y - 243);
	let rnd = prng.Random(1, 86);
	if (rnd <= 49) {
		return createPotion(ws, ng, x, y-2, 'normal', gameMode);
	}
	else if (rnd <= 52) {
		return {type: 'item', item: 'egg_purple', x: x, y: y-2};
	}
	else if (rnd <= 55) {
		return {type: 'item', item: 'egg_fire', x: x, y: y-2};
	}
	else if (rnd <= 58) {
		return {type: 'item', item: 'egg_slime', x: x, y: y-2};
	}
	else if (rnd <= 64) {
		return {type: 'item', item: 'egg_monster', x: x, y: y-2};
	}
	else if (rnd <= 70) {
		return {type: 'item', item: 'kiuaskivi', x: x, y: y-2};
	}
	else if (rnd <= 76) {
		return {type: 'item', item: 'ukkoskivi', x: x, y: y-2};
	}
	else if (rnd <= 82) {
		return {type: 'item', item: 'kuu', x: x, y: y-2};
	}
	else {
		return {type: 'item', item: 'broken_wand', x: x, y: y-2};
	}
}

export function createPotion(ws, ng, x, y, type, gameMode = 'normal') {
	const prng = new NollaPrng(0);
	// Hopefully rounding it here is fine?
	//prng.SetRandomSeed(ws + ng, roundRNGPos(x - 4.5), y - 4);
	//prng.SetRandomSeed(ws + ng, roundRNGPos(x) - 4.5, y - 4);
	prng.SetRandomSeed(ws + ng, x - 4.5, y - 4);
	if (type === 'normal') {
		if (gameMode === 'nightmare') {
			let rnd = prng.Random(1, 100);
			if (rnd <= 50) {
				return {type: 'item', item: 'potion', material: POTION_MATERIALS_MAGIC_NIGHTMARE[prng.Random(0, POTION_MATERIALS_MAGIC_NIGHTMARE.length - 1)], x: x, y: y};
			}
			else {
				return {type: 'item', item: 'potion', material: POTION_MATERIALS_STANDARD[prng.Random(0, POTION_MATERIALS_STANDARD.length - 1)], x: x, y: y};
			}
		}
		else {
			let rnd = prng.Random(0, 100);
			let material = null;
			if (rnd <= 75) {
				if (prng.Random(0, 100000) <= 50) {
					material = 'magic_liquid_hp_regeneration';
					//return {type: 'item', item: 'potion', material: 'magic_liquid_hp_regeneration', x: x, y: y};
				}
				else if (prng.Random(200, 100000) <= 250) {
					material = 'purifying_powder';
					//return {type: 'item', item: 'potion', material: 'purifying_powder', x: x, y: y};
				}
				else if (prng.Random(250, 100000) <= 500) {
					material = 'magic_liquid_weakness';
					//return {type: 'item', item: 'potion', material: 'magic_liquid_weakness', x: x, y: y};
				}
				else {
					material = POTION_MATERIALS_MAGIC[prng.Random(0, POTION_MATERIALS_MAGIC.length - 1)];
					//return {type: 'item', item: 'potion', material: POTION_MATERIALS_MAGIC[prng.Random(0, POTION_MATERIALS_MAGIC.length - 1)], x: x, y: y};
				}
			}
			else {
				material = POTION_MATERIALS_STANDARD[prng.Random(0, POTION_MATERIALS_STANDARD.length - 1)];
				//return {type: 'item', item: 'potion', material: POTION_MATERIALS_STANDARD[prng.Random(0, POTION_MATERIALS_STANDARD.length - 1)], x: x, y: y};
			}
			if ((appSettings.date.month === 4 && appSettings.date.day === 30) || (appSettings.date.month === 5 && appSettings.date.day === 1)) {
				if (prng.Random(0, 100) <= 20) {
					if (prng.Random(0, 5) <= 4) {
						material = 'sima';
					}
					else {
						material = 'beer';
					}
				}
			}
			if (appSettings.date.month === 6 && appSettings.date.day >= 19 && appSettings.date.day <= 25) {
				if (prng.Random(0, 100) <= 9) {
					if (prng.Random(0, 3) <= 2) {
						material = 'juhannussima';
					}
					else {
						material = 'beer';
					}
				}
			}
			if ((appSettings.date.month === 3 && appSettings.date.day >= 29) || (appSettings.date.month === 4 && appSettings.date.day <= 4)) {
				if (prng.Random(0, 100) <= 10) material = 'mammi';
			}
			if (appSettings.date.month === 2 && appSettings.date.day === 14) {
				if (prng.Random(0, 100) <= 8) material = 'magic_liquid_charm';
			}
			return {type: 'item', item: 'potion', material: material, x: x, y: y};
		}
	}
	else if (type === 'secret') {
		return {type: 'item', item: 'potion', material: POTION_MATERIALS_SECRET[prng.Random(0, POTION_MATERIALS_SECRET.length - 1)], x: x, y: y};
	}
	else if (type === 'random') {
		if (prng.Random(0, 100) <= 50) {
			return {type: 'item', item: 'potion', material: POTION_LIQUIDS[prng.Random(0, POTION_LIQUIDS.length - 1)], x: x, y: y};
		}
		else {
			return {type: 'item', item: 'potion', material: POTION_SANDS[prng.Random(0, POTION_SANDS.length - 1)], x: x, y: y};
		}
	}
}

export function createPowderPouch(ws, ng, x, y) {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x - 4.5, y - 5.5);
	let rnd = prng.Random(0, 100);
	if (rnd <= 75) {
		// random_from_array(POWDER_MATERIALS_MAGIC);
		// Apparently the weights here aren't even used?
		const selected = prng.Random(0, POWDER_MATERIALS_MAGIC.length - 1);
		return {type: 'item', item: 'pouch', material: POWDER_MATERIALS_MAGIC[selected].material, x: x, y: y};
	}
	else {
		// random_from_array(POWDER_MATERIALS_STANDARD);
		const selected = prng.Random(0, POWDER_MATERIALS_STANDARD.length - 1);
		return {type: 'item', item: 'pouch', material: POWDER_MATERIALS_STANDARD[selected].material, x: x, y: y};
	}
}

export function spawnJar(x, y) {
	return {type: 'item', item: 'jar', material: 'urine', x: x, y: y};
}



const POTION_DEBUG = false;
if (POTION_DEBUG) {

	// Test to find item offset
	console.log('--- Initial Test ---');
	let target_material = 'magic_liquid_charm';
	let target_item = 'potion';
	let temp_seed = 8;
	let base_x = -100;
	let base_y = 894;
	let max_search = 10;
	let matches1 = [];
	for (let i = -max_search; i < max_search; i++) {
		for (let j = -max_search; j < max_search; j++) {
			let x = base_x + i;
			let y = base_y + j;
			let item = createPotion(temp_seed, x, y, 'normal', 'normal');
			if ((target_item == 'potion' && item && item.item == 'potion') || (target_item == 'pouch' && item.item == 'pouch')) {
				let material = item ? item.material : 'null';
				if (material === target_material) {
					console.log(i, j, x, y, material);
					matches1.push({i, j});
					//console.log(potion);
				}
			}
			else if (item && item.item === target_item) {
				console.log(i, j, x, y);
			}
		}
	}

	// Dual test
	// Doesn't seem to work if the items are different types
	console.log('--- Dual Test ---');
	let base_x2 = -84;
	let base_y2 = 894;
	let target_material2 = 'radioactive_liquid';
	let target_item2 = 'potion';
	let matches2 = [];
	for (let i = -max_search; i < max_search; i++) {
		for (let j = -max_search; j < max_search; j++) {
			let x = base_x2 + i;
			let y = base_y2 + j;
			let item = createPotion(temp_seed, x, y, 'normal', 'normal');
			if ((target_item2 == 'potion' && item && item.item == 'potion') || (target_item2 == 'pouch' && item.item == 'pouch')) {
				let material = item ? item.material : 'null';
				if (material === target_material2) {
					console.log(i, j, x, y, material);
					//console.log(potion);
					matches2.push({i, j});
				}
			}
			else if (item && item.item === target_item2) {
				console.log(i, j, x, y);
			}
		}
	}

	// Find matches in both
	console.log('--- Matches in Both ---');
	for (let match1 of matches1) {
		for (let match2 of matches2) {
			if (match1.i === match2.i && match1.j === match2.j) {
				console.log('Match found at offset: ', match1.i, match1.j);
			}
		}
	}

}