// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { createPotion } from "./potion_generation.js";
import { roundRNGPos } from "./utils.js";
import { unlockedSpells } from "./unlocks.js";
import { MakeRandomUtilitySpell } from "./spell_generator.js";

export function generateUtilityBox(ws, ng, x, y, perks={}, gameMode='normal') {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, roundRNGPos(x) + 509.7, y + 683.1);

	let items = [];

	let count = 1;
	while (count > 0) {
		count--;
		let rnd = prng.Random(1, 100);
		if (rnd <= 2) {
			items.push({type: 'item', item: 'bomb', x: x, y: y});
		}
		else if (rnd <= 5) {
			rnd = prng.Random(0, 100);
			if (rnd > 98) {
				items.push({type: 'item', item: 'refresh_mimic', x: x, y: y});
			}
			else {
				items.push({type: 'item', item: 'spell_refresh', x: x, y: y});
			}
		}
		else if (rnd <= 11) {
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
						items.push(createPotion(ws, ng, x, y - 10, 'normal', gameMode));
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
		else if (rnd <= 97) {
			let amount = 2;
			let rnd2 = prng.Random(0, 100);
			if (rnd2 <= 40) {
				amount = 2;
			}
			else if (rnd2 <= 60) {
				amount += 1;
			}
			else if (rnd2 <= 77) {
				amount += 2;
			}
			else if (rnd2 <= 90) {
				amount += 3;
			}
			else {
				amount += 4;
			}

			for (let i = 1; i <= amount; i++) {
				const yJitter = prng.Random(-5, 5);
				items.push({...MakeRandomUtilitySpell(prng), x: x + (i - amount / 2) * 8, y: y - 4 + yJitter});
			}
		}
		else if (rnd <= 99) {
			count += 2;
		}
		else {
			count += 3;
		}
	}
	return {type: 'utility_box', items: items, x: x, y: y};
}
