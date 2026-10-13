// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { NollaPrng } from "./nolla_prng.js";
import { spawnWithRandomOffset } from "./spawn_functions.js";
import { MakeRandomSpell, GetRandomAction } from "./spell_generator.js";
import { getDateAndTime, getWorldCenter, getWorldSize } from "./utils.js";
import { generateWand, getWandType, spawnWandAltar } from "./wand_generation.js";
import { roundHalfOfEven } from "./utils.js";
import { createPotion } from "./potion_generation.js";

// Eye Room

const eyeRoomPos = {x: -3850, y: 5400}; // -8 * 512, 10 * 512
const eyeRoomSpellPositions = [
    {x: -3992, y: 5380},
    {x: -3971, y: 5397}, 
    {x: -3949, y: 5414}, 
    {x: -3926, y: 5428}, 
    {x: -3758, y: 5424}, 
    {x: -3735, y: 5410},
	{x: -3713, y: 5393}, 
    {x: -3692, y: 5376}
];

export function generateEyeRoom(ws, ng, pwIndex, gameMode='normal') {
    let prng = new NollaPrng(0);
    let spells = [];
    const worldSize = getWorldSize(ng > 0, gameMode);
    for (let i = 0; i < eyeRoomSpellPositions.length; i++) {
        let pos = eyeRoomSpellPositions[i];
        let x = pos.x + pwIndex * 512 * worldSize;
        let y = pos.y;
        //console.log(`Generating spell for Eye Room at (${x}, ${y})`);
        prng.SetRandomSeed(ws + ng, x, y);
        spells.push({type: 'item', item: 'spell', spell: MakeRandomSpell(prng), x: x, y: y});
    }
    let roomX = eyeRoomPos.x + pwIndex * 512 * worldSize;
    let roomY = eyeRoomPos.y;
    //console.log(eyeRoomPos, roomX, roomY, pwIndex);
    return {type: 'eye_room', items: spells, x: roomX, y: roomY, biome: 'snowcastle_hourglass_chamber'};
}

// Hourglass Shop

const hourglassBasePosition = {
    'left': {x: -5*512 + 50, y: 10*512},
    'right': {x: 3*512 - 50, y: 10*512}
};
const hourglassSpellPositions = {
    'left': [
        {x: 134, y: 361},
        {x: 158, y: 361},
        {x: 182, y: 361},
        {x: 206, y: 361}
    ],
    'right': [
        {x: 305, y: 361},
        {x: 329, y: 361},
        {x: 353, y: 361},
        {x: 377, y: 361}
    ]
}

// Only in NG0
export function generateHourglassShop(ws) {
    const prng = new NollaPrng(0);
    const is_right = prng.ProceduralRandom(ws, 0, 0) > 0.5;

    const baseX = is_right ? hourglassBasePosition.right.x : hourglassBasePosition.left.x;
    const baseY = is_right ? hourglassBasePosition.right.y : hourglassBasePosition.left.y;
    const spellPositions = is_right ? hourglassSpellPositions.right : hourglassSpellPositions.left;
    let spells = [];
    for (let i = 0; i < spellPositions.length; i++) {
        let pos = spellPositions[i];
        let x = baseX + pos.x;
        let y = baseY + pos.y;
        prng.SetRandomSeed(ws, x, y);
        spells.push({type: 'item', item: 'spell', spell: GetRandomAction(ws, 0, x, y, 2, 0), x: x, y: y});
    }
    // side might be redundant 
    return {type: 'shop', items: spells, x: baseX+256, y: baseY+256, side: is_right ? 'right' : 'left', biome: 'snowcastle_cavern'};
}

// Meditation Cube

const meditationCubePosition = {x: -9 * 512 + 350, y: 4 * 512 + 303};

export function generateMeditationCube(ws, ng, pwIndex, perks={}, gameMode='normal') {
    const worldSize = getWorldSize(ng > 0, gameMode);
    const x = meditationCubePosition.x + pwIndex * 512 * worldSize;
    const y = meditationCubePosition.y;
    const wand = spawnWandAltar(ws, ng, x, y, 'excavationsite_cube_chamber', perks, gameMode);
    wand['biome'] = 'excavationsite_cube_chamber';
    return wand;
}

// Snowy room

const snowyRoomPositions = [
    {x: 7 * 512 + 333, y: 8 * 512 + 297},
    {x: 7 * 512 + 439, y: 8 * 512 + 324}
];

// Only in NG0
export function generateSnowyRoom(ws, pwIndex, perks={}, gameMode='normal') {
    let wands = [];
    for (let i = 0; i < snowyRoomPositions.length; i++) {
        const pos = snowyRoomPositions[i];
        const x = pos.x + pwIndex * 512 * 70;
        const y = pos.y;
        const wand = spawnWandAltar(ws, 0, x, y, 'snowcave_secret_chamber', perks, gameMode);
        wand['biome'] = 'snowcave_secret_chamber';
        wands.push(wand);
    }
    return wands;
}

const robotEggPosition = {x: -10 * 512 + 390, y: 29 * 512 + 313};

export function generateRobotEgg(ws, ng, pwIndex, perks={}, gameMode='normal') {
    const worldSize = getWorldSize(ng > 0, gameMode);
    const x = robotEggPosition.x + pwIndex * 512 * worldSize;
    const y = robotEggPosition.y;
    // Oh this actually uses a different spawn function, weird.
    const wandType = getWandType(ws, ng, x + 5, y, 'robot_egg');
    // Get adjusted position (same logic as taikasauvas, but none of the other checks are needed)
    const prng = new NollaPrng(0);
    let px = x + 5 - 4 + prng.ProceduralRandom(ws + ng, x+1+5, y+5) * 8;
	let py = y + 5 - 4 + prng.ProceduralRandom(ws + ng, x+1+5, y+5) * 8;
    const wand = generateWand(ws, ng, roundHalfOfEven(px), roundHalfOfEven(py), wandType, perks);
    wand['biome'] = 'robot_egg';
    return wand;
}

// Jungle Portal

// Only in NG0 main
export function generatePortal(ws) {
    const biomeXMin = -2450;
    const biomeXMax = 1900;
    const biomeYMin = 6700;
    const biomeYMax = 8000;
    //const rim = 200;
    const prng = new NollaPrng(0);
    const px = biomeXMin + prng.ProceduralRandom(ws, 209, 13) * (biomeXMax - biomeXMin);
    const py = biomeYMin + prng.ProceduralRandom(ws, 211, 1.9) * (biomeYMax - biomeYMin);
    // TODO: Biome might not be rainforest, could also be rainforest_open or fungicave, but I don't care too much
    return {type: 'item', item: 'portal', x: px, y: py, biome: 'rainforest'};
}

// Triangle boss
// Only in NG0
const triangleBossBasePosition = {x: 5*512 + 271, y: 22*512 + 242 + 55};
const triangleBossOffsets = [
    {x: 0, y: 0},
    {x: -52, y: -8},
    {x: 52, y: -8},
    {x: -8, y: -60}
];

export function generateTriangleBossDrops(ws, pwIndex) {
    const prng = new NollaPrng(0);
    //const worldSize = isNGP ? 64 : 70;
    let spells = [];
    for (let i = 0; i < triangleBossOffsets.length; i++) {
        //const offset = triangleBossOffsets[i];
        //const x = triangleBossBasePosition.x + offset.x + pwIndex * 512 * 70;
        //const y = triangleBossBasePosition.y + offset.y;
        prng.SetRandomSeed(ws, i, 10+pwIndex);
        const spell = MakeRandomSpell(prng);
        spells.push({type: 'item', item: 'spell', spell: spell, x: triangleBossBasePosition.x + pwIndex * 512 * 70, y: triangleBossBasePosition.y});
    }
    return {type: 'triangle_boss', items: spells, x: triangleBossBasePosition.x + pwIndex * 512 * 70, y: triangleBossBasePosition.y, biome: 'wizardcave_entrance'};
}

const alchemistBossPosition = {x: -10*512 + 256, y: 1*512 + 256};

// Only in NG0
export function generateAlchemistBossDrops(ws, pwIndex) {
    let opts = ["ALPHA", "OMEGA", "GAMMA", "MU", "ZETA", "PHI", "TAU", "SIGMA"];
    const prng = new NollaPrng(0);
    prng.SetRandomSeed(ws, pwIndex, 60);
    let spells = [];
    prng.Next(); //let rnd = prng.Random(1, opts.length);
    for (let i = 1; i <= 4; i++) {
        let rnd = prng.Random(1, opts.length);
        let opt = opts[rnd-1];
        opts.splice(rnd-1, 1);
        spells.push({type: 'item', item: 'spell', spell: opt, x: alchemistBossPosition.x + pwIndex * 512 * 70, y: alchemistBossPosition.y});
    }
    return {type: 'alchemist_boss', items: spells, x: alchemistBossPosition.x + pwIndex * 512 * 70, y: alchemistBossPosition.y, biome: 'secret_lab'};
}

const pyramidBossPosition = {x: 19*512 + 256, y: -2*512 + 256};

// Only in NG0
// Why does tthis have pwIndex? It's only in main
export function generatePyramidBossDrops(ws, pwIndex) {
    let opts = ["NOLLA", "DAMAGE_RANDOM", "RANDOM_SPELL", "RANDOM_PROJECTILE", "RANDOM_MODIFIER", "RANDOM_STATIC_PROJECTILE", "DRAW_RANDOM", "DRAW_RANDOM_X3", "DRAW_3_RANDOM"];
    const prng = new NollaPrng(0);
    prng.SetRandomSeed(ws, pwIndex, 44);
    let spells = [];
    prng.Next(); //let rnd = prng.Random(1, opts.length);
    for (let i = 1; i <= 4; i++) {
        let rnd = prng.Random(1, opts.length);
        let opt = opts[rnd-1];
        opts.splice(rnd-1, 1);
        spells.push({type: 'item', item: 'spell', spell: opt, x: pyramidBossPosition.x + pwIndex * 512 * 70, y: pyramidBossPosition.y});
    }
    return {type: 'pyramid_boss', items: spells, x: pyramidBossPosition.x + pwIndex * 512 * 70, y: pyramidBossPosition.y, biome: 'pyramid_top'};
}

const dragonBossPosition = {x: 4*512 + 296, y: 14*512 + 305};
// Only in NG0 (though extra dragons can spawn in different positions in NG+)
export function generateDragonBossDrops(ws, pwIndex) {
    const x = dragonBossPosition.x + pwIndex * 512 * 70;
    return getDragonDrops(ws, 0, 'dragoncave', x, dragonBossPosition.y);
}

export function getDragonDrops(worldSeed, ngPlusCount, biomeName, x, y, perks={}, gameMode='normal') {
    let drops = [];

    drops.push({type: 'item', item: 'heart', x: x-16, y: y});
    // Wand (wand_unshuffle_06)
    let wand = generateWand(worldSeed, ngPlusCount, x+16, y, 'wand_unshuffle_06', perks);
    drops.push(wand);
    // I misread this, it actually sets the flag and THEN checks it, so this branch triggers every time!
    /*
    let opts = ["ORBIT_DISCS", "ORBIT_FIREBALLS", "ORBIT_NUKES", "ORBIT_LASERS", "ORBIT_LARPA"];
    let count = 3;
    if (unlockedSpells[331]) { // Nuke orbit index
        // If not first time kill, remove ORBIT_NUKES and only drop 1 card
        opts.splice(2, 1);
        count = 1;
    }
    */
    let opts = ["ORBIT_DISCS", "ORBIT_FIREBALLS", "ORBIT_LASERS", "ORBIT_LARPA"];
    const count = 1;
    const prng = new NollaPrng(0);
    const pwIndex = Math.floor((x + getWorldCenter(ngPlusCount > 0, gameMode) * 512) / (getWorldSize(ngPlusCount > 0, gameMode) * 512));
    prng.SetRandomSeed( worldSeed + ngPlusCount, pwIndex, 540 )
    for (let i = 0; i < count; i++) {
        let rnd = prng.Random(1, opts.length);
        let opt = opts[rnd-1];
        drops.push({type: 'item', item: 'spell', spell: opt, x: x - 8*count + (i-0.5)*16, y: y});
        opts.splice(rnd-1, 1);
    }
    return {type: 'dragon', items: drops, x: x, y: y, biome: biomeName};
}

export function getTinyDrops(worldSeed, ngPlusCount, biomeName, x, y, perks={}) {
    return {type: 'tiny', items: [
        // TODO: Add hearts I guess, who cares
        generateWand(worldSeed, ngPlusCount, x-16, y, 'wand_unshuffle_06', perks),
        generateWand(worldSeed, ngPlusCount, x+16, y, 'wand_unshuffle_10', perks)
    ], x: x, y: y, biome: biomeName};
}

export function getPitBossDrops(worldSeed, ngPlusCount, biomeName, x, y, perks={}) {
    return {type: 'pit_boss', items: [
        generateWand(worldSeed, ngPlusCount, x-24, y, 'wand_unshuffle_05', perks),
        generateWand(worldSeed, ngPlusCount, x+24, y, 'wand_level_06', perks)
    ], x: x, y: y, biome: biomeName};
}

const baseEndShopPositionHeaven = {x: 0, y: -13954};
const baseEndShopPositionHell = {x: 0, y: 24576};
const endShopSpellPositions = [
    {x: 41, y: 148},
    {x: 78, y: 148},
    {x: 114, y: 148},
    {x: 149, y: 148},
    {x: 184, y: 148},
    {x: 215, y: 148},
];

// Static heaven/hell shops
export function generateEndShop(ws, ng, direction) {
    // Note direction should be +/- 1
    if (direction != 1 && direction != -1) return null;
    const basePosition = direction == 1 ? baseEndShopPositionHell : baseEndShopPositionHeaven;
    const prng = new NollaPrng(0);
    let spells = [];
    for (let i = 0; i < endShopSpellPositions.length; i++) {
        let pos = endShopSpellPositions[i];
        let x = basePosition.x + pos.x;
        let y = basePosition.y + pos.y;
        prng.SetRandomSeed(ws, ng, x, y);
        // Note: NG is unused in the spell generation here, but it's not a bug
        spells.push({type: 'item', item: 'spell', spell: GetRandomAction(ws, ng, x, y, 10, 0), x: x, y: y});
    }
    
    //console.log(`Generated ${direction == 1 ? 'Hell' : 'Heaven'} Shop at (${basePosition.x}, ${basePosition.y}) with spells:`, spells);
    return {type: 'shop', items: spells, x: basePosition.x + 128, y: basePosition.y + 128, biome: direction == 1 ? 'the_end' : 'the_sky'};
}

// Why is this a thing? Why not just use random.Next?
function random_create(ws, ng, x, y) {
    return {ws: ws, ng: ng, x: x, y: y};
}
function random_next(rnd) {
    const prng = new NollaPrng(0);
    prng.SetRandomSeed(rnd.ws + rnd.ng, rnd.x, rnd.y);
    rnd.y += 1;
    return prng.Next();
}

const snowfallChance = 1/12.0;
const rainfallChance = 1/15.0;
const rain_duration_on_run_start = 4 * 60 * 60;
const snowTypes = [
	{
        type: "snow",
		chance: 1.0,
		rain_material: "snow",
		rain_particles_min: 1,
		rain_particles_max: 4,
		rain_duration: -1,
	},
	{
        type: "slush",
		chance: 0.25,
		rain_material: "slush",
		rain_particles_min: 3,
		rain_particles_max: 5,
		rain_duration: rain_duration_on_run_start,
	},
];

const rainTypes = [
	{
        type: "rain",
		chance: 1.0, // light rain
		rain_material: "water",
		rain_particles_min: 4,
		rain_particles_max: 7,
		rain_duration: rain_duration_on_run_start,
	},
	{
        type: "rain_heavy",
		chance: 0.05, // heavy rain
		rain_material: "water",
		rain_particles_min: 10,
		rain_particles_max: 15,
		rain_duration: rain_duration_on_run_start / 2,
	},
	{
        type: "blood",
		chance: 0.001,
		rain_material: "blood",
		rain_particles_min: 10,
		rain_particles_max: 15,
		rain_duration: rain_duration_on_run_start / 2,
	},
	{
        type: "acid",
		chance: 0.0002,
		rain_material: "acid",
		rain_particles_min: 10,
		rain_particles_max: 15,
		rain_duration: rain_duration_on_run_start / 2,
	},
	{
        type: "slime",
		chance: 0.0001,
		rain_material: "slime",
		rain_particles_min: 1,
		rain_particles_max: 4,
		rain_duration: rain_duration_on_run_start / 2,
	},
];

export function getStartingWeather(ws, ng) {
    const rnd = random_create(ws, ng, 7893434, 3458934);
    const datetime = getDateAndTime();
    const rnd_time = random_create(ws + ng, datetime.hour + datetime.day, datetime.hour + datetime.day + 1);
    const isSnowing = (datetime.month >= 12 || datetime.month <= 2) && random_next(rnd_time) <= snowfallChance;
    const isRaining = !isSnowing && random_next(rnd) <= rainfallChance;
    let weather = null;
    let rainDrawLongChance = 0.0;
    if (isSnowing) {
        for (let i = snowTypes.length - 1; i >= 0; i--) {
            if (random_next(rnd_time) <= snowTypes[i].chance) {
                weather = snowTypes[i];
                break;
            }
        }
        if (!weather) weather = snowTypes[0];
        // Apply biome modifiers... I'll just return snowing and use that, I guess
        rainDrawLongChance = 0.5;
    }
    else if (isRaining) {
        for (let i = rainTypes.length - 1; i >= 0; i--) {
            if (random_next(rnd) <= rainTypes[i].chance) {
                weather = rainTypes[i];
                break;
            }
        }
        if (!weather) weather = rainTypes[0];
        rainDrawLongChance = 1.0;
    }
    else {
        weather = {rain_material: null, rain_particles_min: 0, rain_particles_max: 0, rain_duration: 0};
    }
    let fog = 0.0;
    let clouds = 0.0;
    let rainDrawLong = false;
    let rainParticles = 0;
    if (isRaining || isSnowing) {
        fog = 0.3 + random_next(rnd)*(0.85 - 0.3);
        clouds = Math.max(fog, random_next(rnd));
        rainDrawLong = random_next(rnd) <= rainDrawLongChance;
        rainParticles = weather.rain_particles_min + random_next(rnd) * (weather.rain_particles_max - weather.rain_particles_min);
    }

    return {
        type: weather.type || "sunny",
        material: weather.rain_material,
        fog: fog,
        clouds: clouds,
        rainDrawLong: rainDrawLong,
        rainParticles: rainParticles,
        snowing: isSnowing
    }
}

const CHANCE_OF_MODIFIER_PER_BIOME = 0.1;
const CHANCE_OF_MODIFIER_COALMINE = 0.2;
const CHANCE_OF_MODIFIER_EXCAVATIONSITE = 0.15;
const CHANCE_OF_MOIST_FUNGICAVE = 0.5;
const CHANCE_OF_MOIST_LAKE = 0.75;
// Not sure what all I actually need from biome modifiers
const BIOME_MODIFIERS = [
    {
        id: "MOIST",
        probability: 0.7,
    },
    {
        id: "FOG_OF_WAR_REAPPEARS",
        probability: 1.0,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "HIGH_GRAVITY",
        probability: 0.5,
    },
    {
        id: "LOW_GRAVITY",
        probability: 0.5,
    },
    {
        id: "CONDUCTIVE",
        probability: 0.2,
        does_not_apply_to_biome: ["mountain_hall", "coalmine"],
    },
    {
        id: "FREEZING",
        probability: 0.0,
    },
    {
        id: "HOT",
        probability: 0.6,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "GOLD_VEIN",
        probability: 0.01,
        does_not_apply_to_biome: ["snowcastle"],
    },
    {
        id: "GOLD_VEIN_SUPER",
        probability: 0.00025,
        apply_only_to_biome: ["coalmine", "coalmine_alt", "excavationsite", "snowcave"],
    },
    {
        id: "PLANT_INFESTED",
        probability: 1.0,
        does_not_apply_to_biome: ["snowcastle","snowcave","rainforest","rainforest_open","mountain_hall"],
    },
    {
        id: "FURNISHED",
        probability: 0.5,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "BOOBY_TRAPPED",
        probability: 0.75,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "PERFORATED",
        probability: 0.75,
        does_not_apply_to_biome: ["vault", "vault_frozen", "crypt", "snowcave"],
    },
    {
        id: "SPOOKY",
        probability: 0.5,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "GRAVITY_FIELDS",
        probability: 0.3,
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "FUNGAL",
        probability: 0.5,
        does_not_apply_to_biome: ["mountain_hall", "snowcastle", "snowcave", "fungicave"],
    },
    {
        id: "FLOODED",
        probability: 0.75,
        does_not_apply_to_biome: ["mountain_hall", "rainforest", "rainforest_open", "snowcave", "vault"],
    },
    {
        id: "GAS_FLOODED",
        probability: 0.5,
        does_not_apply_to_biome: ["mountain_hall", "excavationsite", "snowcave", "snowcastle", "crypt"],
    },
    {
        id: "SHIELDED",
        probability: 0.1,
        does_not_apply_to_biome: ["mountain_hall", "excavationsite", "snowcave"],
    },
    {
        id: "PROTECTION_FIELDS",
        probability: 0.2,
        requires_flag: "moon_is_sun",
        does_not_apply_to_biome: ["mountain_hall"],
    },
    {
        id: "OMINOUS",
        probability: 0.2,
        requires_flag: "darkmoon_is_darksun",
        does_not_apply_to_biome: ["mountain_hall", "coalmine", "excavationsite"],
    },
    {
        id: "INVISIBILITY",
        probability: 0.1,
        does_not_apply_to_biome: ["mountain_hall", "coalmine"],
    },
    {
        id: "WORMY",
        probability: 0.05,
        does_not_apply_to_biome: ["mountain_hall", "coalmine"],
    },
];
const COSMETIC_FREEZE = {
    id: "FREEZING_COSMETIC",
    probability: 0.0,
};
const FOG_OF_WAR_CLEAR_AT_PLAYER = {
    id: "FOG_OF_WAR_CLEAR_AT_PLAYER",
    probability: 0.0,
}
export function getBiomeModifiers(ws, ng, snowing=false, flags={}) {
    // For now, just set the required flags and we can just display a disclaimer that the biome modifier will only exist if the flag is active.
    // It doesn't actually change the spawn probabilities at all, it just becomes no modifier if the flag isn't set and it gets rolled.
    flags = {"moon_is_sun": true, "darkmoon_is_darksun": true};
    const result = {};
    const getModifier = (modifierID) => {
        for (let modifier of BIOME_MODIFIERS) {
            if (modifier.id === modifierID) return modifier;
        }
        return null;
    };
    const setModifierIfHasNone = (biomeName, modifierID) => {
        if (!result[biomeName]) result[biomeName] = getModifier(modifierID);
    };
    const hasModifiers = (biomeName, rnd) => {
        let chance = CHANCE_OF_MODIFIER_PER_BIOME;
        if (biomeName === "coalmine") chance = CHANCE_OF_MODIFIER_COALMINE;
        if (biomeName === "excavationsite") chance = CHANCE_OF_MODIFIER_EXCAVATIONSITE;
        return random_next(rnd) <= chance;
    }
    const biomeModifierAppliesToBiome = (modifier, biomeName) => {
        if (!modifier) return false;
        if (modifier.requires_flag) {
            if (!flags[modifier.requires_flag]) return false;
        }
        let ok = true;
        if (modifier.does_not_apply_to_biome) {
            if (modifier.does_not_apply_to_biome.includes(biomeName)) ok = false;
        }
        if (modifier.apply_only_to_biome) {
            ok = false;
            if (modifier.apply_only_to_biome.includes(biomeName)) ok = true;
        }
        return ok;
    }
    const rnd = random_create(ws, ng, 347893, 90734);
    const biomes = [
        ["coalmine", "mountain_hall"],
        ["coalmine_alt"],
        ["excavationsite"],
        ["fungicave"],
        ["snowcave"],
        ["snowcastle"],
        ["rainforest", "rainforest_open"],
        ["vault"],
        ["crypt"]
    ];
    for (let biomeList of biomes) {
        let modifier = null;
        if (hasModifiers(biomeList[0], rnd)) {
            // pick random from table weighted
            let totalProbability = 0.0;
            for (let m of BIOME_MODIFIERS) {
                totalProbability += m.probability;
            }
            let rndValue = random_next(rnd) * totalProbability;
            for (let m of BIOME_MODIFIERS) {
                if (rndValue <= m.probability) {
                    modifier = m;
                    break;
                }
                rndValue -= m.probability;
            }
        }
        for (let biomeName of biomeList) {
            if (biomeModifierAppliesToBiome(modifier, biomeName)) {
                result[biomeName] = modifier;
            }
        }
    }

    if (random_next(rnd) <= CHANCE_OF_MOIST_FUNGICAVE) {
        setModifierIfHasNone("fungicave", "MOIST");
    }
    result["wandcave"] = FOG_OF_WAR_CLEAR_AT_PLAYER;
    result["wizardcave"] = FOG_OF_WAR_CLEAR_AT_PLAYER;
    result["alchemist_secret"] = FOG_OF_WAR_CLEAR_AT_PLAYER;
    setModifierIfHasNone("mountain_top", "FREEZING");
    setModifierIfHasNone("mountain_floating_island", "FREEZING");
    setModifierIfHasNone("winter", "FREEZING");
    result["winter_caves"] = COSMETIC_FREEZE;
    setModifierIfHasNone("lavalake", "HOT");
    setModifierIfHasNone("desert", "HOT");
    setModifierIfHasNone("pyramid_entrance", "HOT");
    setModifierIfHasNone("pyramid_left", "HOT");
    setModifierIfHasNone("pyramid_top", "HOT");
    setModifierIfHasNone("pyramid_right", "HOT");
    setModifierIfHasNone("watercave", "MOIST");
    if (random_next(rnd) <= CHANCE_OF_MOIST_LAKE) {
        setModifierIfHasNone("lake_statue", "MOIST");
    }
    if (snowing) {
        setModifierIfHasNone("hills", "FREEZING");
        setModifierIfHasNone("mountain_left_entrance", "FREEZING");
        setModifierIfHasNone("mountain_left_stub", "FREEZING");
        setModifierIfHasNone("mountain_right", "FREEZING");
        setModifierIfHasNone("mountain_right_stub", "FREEZING");
        setModifierIfHasNone("mountain_tree", "FREEZING");
        result["mountain_lake"] = COSMETIC_FREEZE;
    }
    // foreach applytodata
    return result;
}

// TODO: Check if biome modifiers and weather actually change with NG+?

export function getStartingLoadout(ws, isDaily=false, gameMode='normal') {
    const x = 227;
    const y = -81;
    const prng = new NollaPrng(0);
    if (!isDaily) {
        prng.SetRandomSeed(ws, 0, -11);
    }
    else {
        prng.SetRandomSeed(ws, 0, 0);
    }
    const wand = {
        type: 'wand',
        item: 'wand',
        mana_max: prng.Random(80, 130),
        deck_capacity: prng.Random(2, 3),
        name: ["Bolt staff"][prng.Random(0, 0)],
        reload_time: prng.Random(20, 28),
        fire_rate_wait: prng.Random(9, 15),
        mana_charge_speed: prng.Random(25, 40),
        actions_per_round: 1,
        shuffle_deck_when_empty: 0,
        spread_degrees: 0,
        speed_multiplier: 1.0,
        sprite: "custom/handgun",
        always_casts: [],
        x: x,
        y: y,
        grip: {x: 3, y: 3},
        tip: {x: 12, y: 3},
    }
    let cards = [];
    const spellCount = Math.min(prng.Random(1, 3), wand.deck_capacity);
    let spell = "LIGHT_BULLET";
    if (!isDaily) {
        if (prng.Random(1, 100) < 50) {
            spell = ["SPITTER", "RUBBER_BALL", "BOUNCY_ORB"][prng.Random(0, 2)];
        }
    }
    else {
        spell = ["LIGHT_BULLET", "SPITTER", "RUBBER_BALL", "BOUNCY_ORB"][prng.Random(0, 3)];
    }
    for (let i = 0; i < spellCount; i++) {
        cards.push(spell);
    }
    wand['cards'] = cards;

    if (!isDaily) {
        prng.SetRandomSeed(ws, -1, 0);
    }
    else {
        prng.SetRandomSeed(ws, 0, 0);
    }
    const bomb_wand = {
        type: 'wand',
        item: 'wand',
        mana_max: prng.Random(80, 110),
        deck_capacity: prng.Random(1, 1),
        name: "Bomb wand",
        reload_time: prng.Random(1, 10),
        fire_rate_wait: prng.Random(3, 8),
        mana_charge_speed: prng.Random(5, 20),
        actions_per_round: 1,
        shuffle_deck_when_empty: 1,
        spread_degrees: 0,
        speed_multiplier: 1.0,
        sprite: "custom/bomb_wand",
        always_casts: [],
        x: x,
        y: y,
        grip: {x: 3, y: 3},
        tip: {x: 13, y: 3},
    }

    let bombSpell = "BOMB";
    if (!isDaily) {
        let r = prng.Random(1, 100);
        if (r < 50) {
            bombSpell = ["BOMB", "DYNAMITE", "MINE", "ROCKET", "GRENADE"][prng.Random(0, 4)];
        }
    }
    else {
        bombSpell = ["BOMB", "DYNAMITE", "MINE", "ROCKET", "GRENADE"][prng.Random(0, 4)];
    }
    bomb_wand['cards'] = [bombSpell];

    let potion = null;
    if (!isDaily) {
        prng.SetRandomSeed(ws, -4.5, -4);
        let r = prng.Random(1, 100);
        let material = "unknown";
        if (r <= 65) {
            r = prng.Random(1, 100);
            if (r <= 10) material = "mud";
            else if (r <= 20) material = "water_swamp";
            else if (r <= 30) material = "water_salt";
            else if (r <= 40) material = "swamp";
            else if (r <= 50) material = "snow";
            else material = "water";
        }
        else if (r <= 70) material = "blood";
        else if (r <= 99) {
            // Useless roll?
            r = prng.Random(0, 100);
            material = ["acid", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "magic_liquid_berserk", "magic_liquid_charm", "magic_liquid_movement_faster"][prng.Random(0, 5)];
        }
        else {
            r = prng.Random(0, 100000);
            if (r === 666) material = "urine";
            else if (r === 79) material = "gold";
            else material = ["slime", "gunpowder_unstable"][prng.Random(0, 1)];
        }
        const datetime = getDateAndTime();
        if ((datetime.month === 5 && datetime.day === 1) || (datetime.month === 4 && datetime.day === 30)) {
            if (prng.Random(0, 100) <= 20) material = "sima";
        }
        potion = {
            type: 'item',
            item: 'potion',
            material: material,
            x: x,
            y: y,
        }
    }
    else {
        potion = createPotion(ws, 0, 0, 0, "normal", gameMode);
    }

    return {type: 'starting_loadout', items: [wand, bomb_wand, potion], x: x, y: y, biome: null};
}

// I was going to implement the coral chest but turns out it's not deterministic, seeded by frame count. Same for the dark chest. Oh well.
