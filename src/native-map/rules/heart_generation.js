// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { generateChest, generateGreatChest } from "./chest_generation.js";
import { appSettings } from "./settings.js";

// TODO: Not working for NG+?
export function spawnHeart(ws, ng, x, y, biome, perks={}, gameMode='normal') {
	let prng = new NollaPrng(0);
	let r = prng.ProceduralRandom(ws+ng, x, y);
	let heart_spawn_rate = 0.7;
	if (appSettings.date.month === 2 && appSettings.date.day === 14) {
		heart_spawn_rate = 0.35;
	}

	//console.log(`spawnHeart at (${x}, ${y}): r = ${r}`);

	if (r > heart_spawn_rate) {
		return {type: 'item', item: 'heart', x: x, y: y};
	}
	else if (r > 0.3) {
		prng.SetRandomSeed(ws+ng, x + 45, y - 2123);
		let rnd = prng.Random(1, 100);
		if (rnd <= 90 || y < 512 * 3) {
			rnd = prng.Random(1, 1000);
			//let hasSign = false;
			if (prng.Random(1, 300) == 1) {
				//hasSign = true;
			}
			if (rnd >= 1000) {
				return generateGreatChest(ws, ng, x, y, perks, gameMode);
			}
			else {
				return generateChest(ws, ng, x, y, perks, gameMode);
			}
		}
		else {
			rnd = prng.Random(1, 100);
			//let hasSign = false;
			if (prng.Random(1, 30) == 1) {
				//hasSign = true;
			}
			if (rnd <= 95) {
				return {type: 'item', item: 'mimic', x: x, y: y};
			}
			else {
				return {type: 'item', item: 'chest_leggy', x: x, y: y};
			}
		}
	}
	else {
		return null;
	}
}