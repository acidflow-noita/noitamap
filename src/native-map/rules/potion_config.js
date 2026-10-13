// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { fetchSafeJson } from './utils.js';

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

export const POTION_MATERIALS_SECRET = [
	'magic_liquid_hp_regeneration_unstable',
	'blood_worm',
	'gold',
	'snow',
	'glowshroom',
	'bush_seed',
	'cement',
	'salt',
	'sodium',
	'mushroom_seed',
	'plant_seed',
	'urine',
	'purifying_powder'
];

export const POTION_LIQUIDS = [
	'water',
	'water_temp',
	'water_ice',
	'water_swamp',
	'oil',
	'alcohol',
	'beer',
	'milk',
	'molut',
	'sima',
	'juhannussima',
	'magic_liquid',
	'material_confusion',
	'material_darkness',
	'material_rainbow',
	'magic_liquid_weakness',
	'magic_liquid_movement_faster',
	'magic_liquid_faster_levitation',
	'magic_liquid_faster_levitation_and_movement',
	'magic_liquid_worm_attractor',
	'magic_liquid_protection_all',
	'magic_liquid_mana_regeneration',
	'magic_liquid_unstable_teleportation',
	'magic_liquid_teleportation',
	'magic_liquid_hp_regeneration',
	'magic_liquid_hp_regeneration_unstable',
	'magic_liquid_polymorph',
	'magic_liquid_random_polymorph',
	'magic_liquid_unstable_polymorph',
	'magic_liquid_berserk',
	'magic_liquid_charm',
	'magic_liquid_invisibility',
	'cloud_radioactive',
	'cloud_blood',
	'cloud_slime',
	'swamp',
	'blood',
	'blood_fading',
	'blood_fungi',
	'blood_worm',
	'porridge',
	'blood_cold',
	'radioactive_liquid',
	'radioactive_liquid_fading',
	'plasma_fading',
	'gold_molten',
	'wax_molten',
	'silver_molten',
	'copper_molten',
	'brass_molten',
	'glass_molten',
	'glass_broken_molten',
	'steel_molten',
	'creepy_liquid',
	'cement',
	'slime',
	'slush',
	'vomit',
	'plastic_red_molten',
	'plastic_grey_molten',
	'acid',
	'lava',
	'urine',
	'rocket_particles',
	'peat',
	'plastic_prop_molten',
	'plastic_molten',
	'slime_yellow',
	'slime_green',
	'aluminium_oxide_molten',
	'steel_rust_molten',
	'metal_prop_molten',
	'aluminium_robot_molten',
	'aluminium_molten',
	'metal_nohit_molten',
	'metal_rust_molten',
	'metal_molten',
	'metal_sand_molten',
	'steelsmoke_static_molten',
	'steelmoss_static_molten',
	'steelmoss_slanted_molten',
	'steel_static_molten',
	'plasma_fading_bright',
	'radioactive_liquid_yellow',
	'cursed_liquid',
	'poison',
	'blood_fading_slow',
	'pus',
	'midas',
	'midas_precursor',
	'liquid_fire_weak',
	'liquid_fire',
	'just_death',
	'mimic_liquid',
	'void_liquid',
	'water_salt',
	'water_fading',
	'pea_soup',
];

export const POTION_SANDS = [
	'mud',
	'concrete_sand',
	'sand',
	'bone',
	'soil',
	'sandstone',
	'fungisoil',
	'honey',
	'glue',
	'explosion_dirt',
	'snow',
	'snow_sticky',
	'rotten_meat',
	'meat_slime_sand',
	'rotten_meat_radioactive',
	'ice',
	'sand_herb',
	'wax',
	'gold',
	'silver',
	'copper',
	'brass',
	'diamond',
	'coal',
	'sulphur',
	'salt',
	'sodium_unstable',
	'gunpowder',
	'gunpowder_explosive',
	'gunpowder_tnt',
	'gunpowder_unstable',
	'gunpowder_unstable_big',
	'monster_powder_test',
	'rat_powder',
	'fungus_powder',
	'orb_powder',
	'gunpowder_unstable_boss_limbs',
	'plastic_red',
	'plastic_grey',
	'grass',
	'grass_holy',
	'grass_darker',
	'grass_ice',
	'grass_dry',
	'fungi',
	'spore',
	'moss',
	'plant_material',
	'plant_material_red',
	'plant_material_dark',
	'ceiling_plant_material',
	'mushroom_seed',
	'plant_seed',
	'mushroom',
	'mushroom_giant_red',
	'mushroom_giant_blue',
	'glowshroom',
	'bush_seed',
	'poo',
	'mammi',
	'glass_broken',
	'moss_rust',
	'fungi_creeping_secret',
	'fungi_creeping',
	'grass_dark',
	'fungi_green',
	'shock_powder',
	'fungus_powder_bad',
	'burning_powder',
	'purifying_powder',
	'sodium',
	'metal_sand',
	'steel_sand',
	'gold_radioactive',
	'endslime_blood',
	'sandstone_surface',
	'soil_dark',
	'soil_dead',
	'soil_lush_dark',
	'soil_lush',
	'sand_petrify',
	'lavasand',
	'sand_surface',
	'sand_blue',
	'plasma_fading_pink',
	'plasma_fading_green',
	'fungi_yellow',
];

// Load material data from JSON file instead of with a giant hardcoded list
// Note slime needed to have its wang color manually modified since it matched honey in RGB...
// Also flummoxium has been adjusted to use its potion color instead of average texture color because the average of rainbow is gray and it looks bad
// Colors here have alpha included but not currently used
export const MATERIAL_DATA = await fetchSafeJson('../data/material_data.json');
export const MATERIAL_WANG_COLORS = {};
export const POTION_COLORS = {};
export const TEXTURE_COLORS = {};
// Whole (parent-resolved) material record by name, for callers that want more
// than one of the tables above -- the hover tooltip's texture/flat-color line.
export const MATERIAL_BY_NAME = new Map();
for (const material of MATERIAL_DATA) {
	MATERIAL_WANG_COLORS[material.name] = material.wang;
	POTION_COLORS[material.name] = material.color;
	TEXTURE_COLORS[material.name] = material.texture_color;
	MATERIAL_BY_NAME.set(material.name, material);
}

// Use texture colors in this
export let MATERIAL_COLOR_CONVERSION = {};
for (const material of Object.keys(MATERIAL_WANG_COLORS)) {
	const wangColor = MATERIAL_WANG_COLORS[material];
	const materialColor = TEXTURE_COLORS[material];
	const wangColorInt = parseInt(wangColor, 16) & 0xFFFFFF;
	const materialColorInt = parseInt(materialColor, 16) & 0xFFFFFF;
	MATERIAL_COLOR_CONVERSION[wangColorInt] = materialColorInt;
}

export const MATERIAL_COLOR_LOOKUP = {};
for (const material of Object.keys(MATERIAL_WANG_COLORS)) {
	const materialColor = MATERIAL_WANG_COLORS[material].toLowerCase().substring(2);
	MATERIAL_COLOR_LOOKUP[materialColor] = material;
}

// These weights are unused
export const POWDER_MATERIALS_STANDARD = [
    {material: 'sand', weight: 300},
    {material: 'soil', weight: 200},
    {material: 'snow', weight: 200},
    {material: 'salt', weight: 200},
    {material: 'coal', weight: 200},
    {material: 'gunpowder', weight: 200},
    {material: 'fungisoil', weight: 200},
];

// These weights are unused
export const POWDER_MATERIALS_MAGIC = [
    {material: 'copper', weight: 500},
    {material: 'silver', weight: 500},
    {material: 'gold', weight: 500},
    {material: 'brass', weight: 500},
    {material: 'bone', weight: 800},
    {material: 'purifying_powder', weight: 800},
    {material: 'fungi', weight: 800},
];

//console.log(POTION_COLORS['magic_liquid']);