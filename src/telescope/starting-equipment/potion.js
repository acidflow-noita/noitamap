// Derived from Lymm37/noita-telescope (MIT). See NOTICE.txt and LICENSE.txt.
// Pure starting/normal potion rules: usable by baked metadata without loading world assets.
import { NollaPrng } from "./rng.js";

export const POTION_MATERIALS_STANDARD = [
	'lava',
	'water',
	'blood',
	'alcohol',
	'oil',
	'slime',
	'acid',
	'radioactive_liquid',
	'gunpowder_unstable',
	'liquid_fire',
	'blood_cold'
];

export const POTION_MATERIALS_MAGIC = [
	'magic_liquid_unstable_teleportation',
	'magic_liquid_polymorph',
	'magic_liquid_random_polymorph',
	'magic_liquid_berserk',
	'magic_liquid_charm',
	'magic_liquid_invisibility',
	'material_confusion',
	'magic_liquid_movement_faster',
	'magic_liquid_faster_levitation',
	'magic_liquid_worm_attractor',
	'magic_liquid_protection_all',
	'magic_liquid_mana_regeneration'
];

export const POTION_MATERIALS_MAGIC_NIGHTMARE = [
	'magic_liquid_unstable_teleportation',
	'magic_liquid_polymorph',
	'magic_liquid_random_polymorph',
	'magic_liquid_berserk',
	'magic_liquid_charm',
	'material_confusion',
	'magic_liquid_movement_faster',
	'magic_liquid_worm_attractor',
];

export function selectNormalPotionMaterial(ws, ng, x, y, gameMode, calendar) {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws + ng, x - 4.5, y - 4);
	if (gameMode === 'nightmare') {
		let rnd = prng.Random(1, 100);
		if (rnd <= 50) {
			return POTION_MATERIALS_MAGIC_NIGHTMARE[prng.Random(0, POTION_MATERIALS_MAGIC_NIGHTMARE.length - 1)];
		}
		else {
			return POTION_MATERIALS_STANDARD[prng.Random(0, POTION_MATERIALS_STANDARD.length - 1)];
		}
	}
	else {
		let rnd = prng.Random(0, 100);
		let material = null;
		if (rnd <= 75) {
			if (prng.Random(0, 100000) <= 50) {
				material = 'magic_liquid_hp_regeneration';
			}
			else if (prng.Random(200, 100000) <= 250) {
				material = 'purifying_powder';
			}
			else if (prng.Random(250, 100000) <= 500) {
				material = 'magic_liquid_weakness';
			}
			else {
				material = POTION_MATERIALS_MAGIC[prng.Random(0, POTION_MATERIALS_MAGIC.length - 1)];
			}
		}
		else {
			material = POTION_MATERIALS_STANDARD[prng.Random(0, POTION_MATERIALS_STANDARD.length - 1)];
		}
		if ((calendar.month === 4 && calendar.day === 30) || (calendar.month === 5 && calendar.day === 1)) {
			if (prng.Random(0, 100) <= 20) {
				if (prng.Random(0, 5) <= 4) {
					material = 'sima';
				}
				else {
					material = 'beer';
				}
			}
		}
		if (calendar.month === 6 && calendar.day >= 19 && calendar.day <= 25) {
			if (prng.Random(0, 100) <= 9) {
				if (prng.Random(0, 3) <= 2) {
					material = 'juhannussima';
				}
				else {
					material = 'beer';
				}
			}
		}
		if ((calendar.month === 3 && calendar.day >= 29) || (calendar.month === 4 && calendar.day <= 4)) {
			if (prng.Random(0, 100) <= 10) material = 'mammi';
		}
		if (calendar.month === 2 && calendar.day === 14) {
			if (prng.Random(0, 100) <= 8) material = 'magic_liquid_charm';
		}
		return material;
	}
}
