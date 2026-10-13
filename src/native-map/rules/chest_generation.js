// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { createPotion, createPowderPouch } from "./potion_generation.js";
import { createWand } from "./wand_generation.js";
import { WAND_TYPES } from "./wand_config.js";
import { unlockedSpells } from "./unlocks.js";
import { roundRNGPos, isDuplicateObject } from "./utils.js";
import { MakeRandomSpell } from "./spell_generator.js";

export function spawnChest(ws, ng, x, y, isTower=false, perks={}, gameMode='normal') {
    let prng = new NollaPrng(0);
	//x = roundRNGPos(x); Testing with and without this, neither is really working correctly?
    prng.SetRandomSeed(ws + ng, x, y);
    let greedCurse = perks['greedCurse'] ? perks['greedCurse'] : false;
    let great_chest_rate = 2000;
    if (greedCurse) great_chest_rate = 100;
    //if (biome.includes('tower')) great_chest_rate = 100;
	if (isTower) great_chest_rate = 100;
    let rnd = prng.Random(1, great_chest_rate);

    if (rnd >= great_chest_rate - 1) {
        return generateGreatChest(ws, ng, x, y, perks, gameMode);
    }
    else {
        return generateChest(ws, ng, x, y, perks, gameMode);
    }
}

export function generateGreatChest(ws, ng, x, y, perks={}, gameMode='normal') {
	const prng = new NollaPrng(0);
	const noMoreShuffle = perks['noMoreShuffle'] || false;
	prng.SetRandomSeed(ws + ng, roundRNGPos(x), y);
	let items = [];
	let count = 1;

	// Very special
	if (prng.Random(0, 100000) >= 100000) {
		count = 0;
		if (prng.Random(0, 1000) === 999) {
			items.push({type: 'item', item: 'true_orb', x: x, y: y});
		}
		else {
			items.push({type: 'item', item: 'sampo', x: x, y: y});
		}
	}

	while (count > 0) {
		count--;
		let rnd = prng.Random(1, 100);
		if (rnd <= 10) {
			rnd = prng.Random(0, 100);
			if (rnd <= 30) {
				let dupPotion = createPotion(ws, ng, x, y, 'normal', gameMode);
				items.push(dupPotion);
				items.push(dupPotion);
				items.push(createPotion(ws, ng, x, y, 'secret', gameMode));
			}
			else {
				let dupPotion = createPotion(ws, ng, x, y, 'secret', gameMode);
				items.push(dupPotion);
				items.push(dupPotion);
				items.push(createPotion(ws, ng, x, y, 'random', gameMode));
			}
		}
		else if (rnd <= 15) {
			items.push({type: 'item', item: 'gold', amount: 1000, x: x, y: y});
		}
		else if (rnd <= 18) {
			rnd = prng.Random(1, 30);
			if (rnd === 30) {
				items.push({type: 'item', item: 'kakkakikkare', x: x, y: y});
			}
			else {
				items.push({type: 'item', item: 'vuoksikivi', x: x, y: y});
			}
		}
		else if (rnd <= 39) {
			rnd = prng.Random(0, 100);
			if (rnd <= 25) {
				//T4 false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_04'], false, noMoreShuffle));
			}
			else if (rnd <= 50) {
				//T4NS false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_04'], false, noMoreShuffle));
			}
			else if (rnd <= 75) {
				//T5 false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_05'], false, noMoreShuffle));
			}
			else if (rnd <= 90) {
				//T5NS false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_05'], false, noMoreShuffle));
			}
			else if (rnd <= 96) {
				//T6 false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_06'], false, noMoreShuffle));
			}
			else if (rnd <= 98) {
				//T6NS false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_06'], false, noMoreShuffle));
			}
			else if (rnd <= 99) {
				//T6 false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_06'], false, noMoreShuffle));
			}
			else {
				//T10 false
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_10'], false, noMoreShuffle));
			}
		}
		else if (rnd <= 60) {
			rnd = prng.Random(0, 100);
			if (rnd <= 89) {
				items.push({type: 'item', item: 'heart', x: x, y: y});
			}
			else if (rnd <= 99) {
				items.push({type: 'item', item: 'heart_bigger', x: x, y: y});
			}
			else {
				items.push({type: 'item', item: 'full_heal', x: x, y: y});
			}
		}
		else if (rnd <= 98) {
			count += 2;
		}
		else {
			count += 3;
		}
	}

	// Deduplicate items and add count property
	let dedupedItems = [];
	for (let item of items) {
		let found = false;
		for (let deduped of dedupedItems) {
			if (isDuplicateObject(deduped, item)) {
				deduped.count = (deduped.count || 1) + 1;
				found = true;
				break;
			}
		}
		if (!found) {
			dedupedItems.push(item);
		}
	}

	return {type: 'great_chest', items: dedupedItems, x: x, y: y};
}

export function generateGreatChestStandalone(seed) {
	const prng = new NollaPrng(0);
	prng.Seed = seed;
	let items = [];
	let count = 1;

	// Very special
	if (prng.Random(0, 100000) >= 100000) {
		count = 0;
		if (prng.Random(0, 1000) === 999) {
			items.push({type: 'item', item: 'true_orb'});
		}
		else {
			items.push({type: 'item', item: 'sampo'});
		}
	}

	while (count > 0) {
		count--;
		let rnd = prng.Random(1, 100);
		if (rnd <= 10) {
			rnd = prng.Random(0, 100);
			if (rnd <= 30) {
				let dupPotion = {type: 'item', item: 'potion_normal'};
				items.push(dupPotion);
				items.push(dupPotion);
				items.push({type: 'item', item: 'potion_secret'});
			}
			else {
				let dupPotion = {type: 'item', item: 'potion_secret'};
				items.push(dupPotion);
				items.push(dupPotion);
				items.push({type: 'item', item: 'potion_random'});
			}
		}
		else if (rnd <= 15) {
			items.push({type: 'item', item: 'gold', amount: 1000});
		}
		else if (rnd <= 18) {
			rnd = prng.Random(1, 30);
			if (rnd === 30) {
				items.push({type: 'item', item: 'kakkakikkare'});
			}
			else {
				items.push({type: 'item', item: 'vuoksikivi'});
			}
		}
		else if (rnd <= 39) {
			rnd = prng.Random(0, 100);
			if (rnd <= 25) {
				//T4 false
				items.push({type: 'wand', wandType: 'wand_level_04'});
			}
			else if (rnd <= 50) {
				//T4NS false
				items.push({type: 'wand', wandType: 'wand_unshuffle_04'});
			}
			else if (rnd <= 75) {
				//T5 false
				items.push({type: 'wand', wandType: 'wand_level_05'});
			}
			else if (rnd <= 90) {
				//T5NS false
				items.push({type: 'wand', wandType: 'wand_unshuffle_05'});
			}
			else if (rnd <= 96) {
				//T6 false
				items.push({type: 'wand', wandType: 'wand_level_06'});
			}
			else if (rnd <= 98) {
				//T6NS false
				items.push({type: 'wand', wandType: 'wand_unshuffle_06'});
			}
			else if (rnd <= 99) {
				//T6 false
				items.push({type: 'wand', wandType: 'wand_level_06'});
			}
			else {
				//T10 false
				items.push({type: 'wand', wandType: 'wand_level_10'});
			}
		}
		else if (rnd <= 60) {
			rnd = prng.Random(0, 100);
			if (rnd <= 89) {
				items.push({type: 'item', item: 'heart'});
			}
			else if (rnd <= 99) {
				items.push({type: 'item', item: 'heart_bigger'});
			}
			else {
				items.push({type: 'item', item: 'full_heal'});
			}
		}
		else if (rnd <= 98) {
			count += 2;
		}
		else {
			count += 3;
		}
	}

	// Deduplicate items and add count property
	/*
	let dedupedItems = [];
	for (let item of items) {
		let found = false;
		for (let deduped of dedupedItems) {
			if (isDuplicateObject(deduped, item)) {
				deduped.count = (deduped.count || 1) + 1;
				found = true;
				break;
			}
		}
		if (!found) {
			dedupedItems.push(item);
		}
	}
	*/

	return {type: 'great_chest', items: items};
}


export function generateChest(ws, ng, x, y, perks={}, gameMode='normal') {
	const noMoreShuffle = perks['noMoreShuffle'] || false;
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, roundRNGPos(x) + 509.7, y + 683.1);
	let items = [];
	let count = 1;
	while (count > 0) {
		count--;
		let rnd = prng.Random(1, 100);
		if (rnd <= 7) {
			items.push({type: 'item', item: 'bomb', x: x, y: y});
		}
		else if (rnd <= 40) {
			let totalGold = 0;
			let amount;// = 5; // No idea why they set it to 5 if it always gets set to something higher?
			rnd = prng.Random(0, 100);
			if (rnd <= 80) {
				amount = 7;
			}
			else if (rnd <= 95) {
				amount = 10;
			}
			else {
				amount = 20;
			}

			rnd = prng.Random(0, 100);
			if (rnd > 30 && rnd <= 80) {
				prng.Next();
				prng.Next();
				totalGold += 50;
			}
			else if (rnd <= 95) {
				prng.Next();
				prng.Next();
				totalGold += 200;
			}
			else if (rnd <= 99) {
				prng.Next();
				prng.Next();
				totalGold += 1000;
			}
			else {
				let tamount = prng.Random(1, 3);
				for (let i = 0; i < tamount; i++) {
					prng.Next();
					prng.Next();
					totalGold += 50;
				}
				if (prng.Random(0, 100) > 50) {
					tamount = prng.Random(1, 3);
					for (let i = 0; i < tamount; i++) {
						prng.Next();
						prng.Next();
						totalGold += 200;
					}
				}
				if (prng.Random(0, 100) > 80) {
					tamount = prng.Random(1, 3);
					for (let i = 0; i < tamount; i++) {
						prng.Next();
						prng.Next();
						totalGold += 1000;
					}
				}
			}
			for (let i = 0; i < amount; i++) {
				prng.Next();
				prng.Next();
				totalGold += 10;
			}
			items.push({type: 'item', item: 'gold', amount: totalGold, x: x, y: y});
		}
		else if (rnd <= 50) {
			rnd = prng.Random(0, 100);
			if (rnd <= 94) {
				items.push(createPotion(ws, ng, x + 510, y + 683, 'normal', gameMode));
			}
			else if (rnd <= 98) {
				items.push(createPowderPouch(ws, ng, x + 510, y + 683));
			}
			else {
				rnd = prng.Random(0, 100);
				if (rnd <= 98) {
					items.push(createPotion(ws, ng, x + 510, y + 683, 'secret', gameMode));
				}
				else {
					items.push(createPotion(ws, ng, x + 510, y + 683, 'random', gameMode));
				}
			}
		}
		else if (rnd <= 54) {
			rnd = prng.Random(0, 100);
			if (rnd <= 98) {
				items.push({type: 'item', item: 'spell_refresh', x: x, y: y});
			}
			else {
				items.push({type: 'item', item: 'refresh_mimic', x: x, y: y});
			}
		}
		else if (rnd <= 60) {
			const opts = ['kammi', 'kuu', 'ukkoskivi', 'paha_silma', 'kiuaskivi', '???', 'chaos_die', 'shiny_orb'];
			let selected = prng.Random(0, opts.length - 1);
			if (opts[selected] == '???') {
				const runestoneOpts = ['runestone_light', 'runestone_fire', 'runestone_magma', 'runestone_weight', 'runestone_emptiness', 'runestone_edges', 'runestone_metal'];
				selected = prng.Random(0, runestoneOpts.length - 1);
				items.push({type: 'item', item: runestoneOpts[selected], x: x, y: y});
			}
			else {
				if (opts[selected] == 'chaos_die') {
					let unlocked = unlockedSpells[363];
					if (unlocked) {
						if (perks['greedCurse']) {
							items.push({type: 'item', item: 'greed_die', x: x, y: y});
						}
						else {
							items.push({type: 'item', item: 'chaos_die', x: x, y: y});
						}
					}
					else {
						items.push({type: 'item', item: 'blocked_by_unlock', x: x, y: y});
						items.push(createPotion(ws, ng, x, y - 12, 'normal', gameMode));
					}   
				}
				else if (opts[selected] == 'shiny_orb') {
					if (perks['greedCurse']) {
						items.push({type: 'item', item: 'greed_orb', x: x, y: y});
					}
					else {
						items.push({type: 'item', item: 'shiny_orb', x: x, y: y});
					}
				}
				else {
					items.push({type: 'item', item: opts[selected], x: x, y: y});
				}
			}
		}
		else if (rnd <= 65) {
			let amount = 1;
			let rnd2 = prng.Random(0, 100);
			if (rnd2 <= 50) {
				amount = 1;
			}
			else if (rnd2 <= 70) {
				amount += 1;
			}
			else if (rnd2 <= 80) {
				amount += 2;
			}
			else if (rnd2 <= 90) {
				amount += 3;
			}
			else {
				amount += 4;
			}

			//console.log(`Adding ${amount} random spells to chest`);
			for (let i = 0; i < amount; i++) {
				prng.Next();
				items.push({type: 'item', item: 'spell', spell: MakeRandomSpell(prng), x: x, y: y});
			}
			//console.log(items);
		}
		else if (rnd <= 84) {
			rnd = prng.Random(0, 100);
			if (rnd <= 25) {
				//T1 true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_01'], true, noMoreShuffle));
			}
			else if (rnd <= 50) {
				//T1NS true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_01'], true, noMoreShuffle));
			}
			else if (rnd <= 75) {
				//T2 true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_02'], true, noMoreShuffle));
			}
			else if (rnd <= 90) {
				//T2NS true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_02'], true, noMoreShuffle));
			}
			else if (rnd <= 96) {
				//T3 true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_03'], true, noMoreShuffle));
			}
			else if (rnd <= 98) {
				//T3NS true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_03'], true, noMoreShuffle));
			}
			else if (rnd <= 99) {
				//T4 true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_level_04'], true, noMoreShuffle));
			}
			else {
				//T4NS true
				items.push(createWand(ws, ng, x, y, WAND_TYPES['wand_unshuffle_04'], true, noMoreShuffle));
			}
		}
		else if (rnd <= 95) {
			rnd = prng.Random(0, 100);
			if (rnd <= 88) {
				items.push({type: 'item', item: 'heart', x: x, y: y});
			}
			else if (rnd <= 89) {
				items.push({type: 'item', item: 'heart_mimic', x: x, y: y});
			}
			else if (rnd <= 99) {
				items.push({type: 'item', item: 'heart_bigger', x: x, y: y});
			}
			else {
				items.push({type: 'item', item: 'full_heal', x: x, y: y});
			}
		}
		else if (rnd <= 98) {
			items.push({type: 'item', item: 'gold', amount: 200, x: x, y: y});
		}
		else if (rnd <= 99) {
			count += 2;
		}
		else {
			count += 3;
		}
		//console.log(count);
	}
	//console.log("Creating chest");

	// Deduplicate items and add count property
	let dedupedItems = [];
	for (let item of items) {
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

	return {type: 'chest', items: dedupedItems, x: x, y: y};
}

