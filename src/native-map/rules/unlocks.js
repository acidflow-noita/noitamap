// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { ALL_SPELLS } from "./spells.js";

export const UNLOCKABLES = {
    // Orbs
    "sea_lava": ["SEA_LAVA"],
    "crumbling_earth": ["CRUMBLING_EARTH"],
    "cloud_thunder": ["CLOUD_THUNDER"],
    "nuke": ["NUKE"],
    "bomb_holy": ["BOMB_HOLY"],
    "necromancy": ["NECROMANCY"],
    "material_cement": ["MATERIAL_CEMENT"], 
    "firework": ["FIREWORK"],
    "exploding_deer": ["EXPLODING_DUCKS", "EXPLODING_DEER", "WORM_SHOT"],
    "spiral_shot": ["SPIRAL_SHOT"],
    "tentacle": ["TENTACLE", "TENTACLE_TIMER"],

    // Cessation questline
    "sea_mimic": ["SEA_MIMIC"], 
    "touch_grass": ["TOUCH_GRASS"], 
    "cessation": ["CESSATION"], 
    "piss": ["TOUCH_PISS"],

    // Notes
    "kantele": ["KANTELE_A", "KANTELE_D", "KANTELE_DIS", "KANTELE_E", "KANTELE_G"],
    "ocarina": ["OCARINA_A", "OCARINA_A2", "OCARINA_B", "OCARINA_C", "OCARINA_D", "OCARINA_E", "OCARINA_F", "OCARINA_GSHARP"],

    // Chests
    "musicbox": ["BURST_8", "BURST_X", "DIVIDE_2", "DIVIDE_3", "DIVIDE_4"],
    "alchemy": ["LARPA_CHAOS_2", "ALL_ACID", "ALL_BLACKHOLES", "ALL_DEATHCROSSES", "ALL_DISCS", "ALL_NUKES", "ALL_ROCKETS"],
    "everything": ["ALL_SPELLS", "DISC_BULLET_BIGGER"], // EoE

    // Avarice
    "divide": ["DIVIDE_10"],
    "bomb_holy_giga": ["BOMB_HOLY_GIGA"],
    "nukegiga": ["NUKE_GIGA"],

    // Bosses
    "mestari": ["ADD_TRIGGER", "ADD_TIMER", "ADD_DEATH_TRIGGER", "DUPLICATE", "RESET"],
    "duplicate": ["ALPHA", "GAMMA", "MU", "OMEGA", "PHI", "SIGMA", "TAU", "ZETA"],
    "pyramid": ["RANDOM_SPELL", "RANDOM_MODIFIER", "RANDOM_PROJECTILE", "RANDOM_STATIC_PROJECTILE", "DAMAGE_RANDOM", "NOLLA", "DRAW_RANDOM", "DRAW_3_RANDOM", "DRAW_RANDOM_X3"],
    "dragon": ["ORBIT_DISCS", "ORBIT_FIREBALLS", "ORBIT_LARPA", "ORBIT_LASERS", "ORBIT_NUKES"],
    "rain": ["METEOR_RAIN", "WORM_RAIN"],
    "polymorph": ["MASS_POLYMORPH"],

    // Experimental
    "paint": ["COLOUR_BLUE", "COLOUR_GREEN", "COLOUR_INVIS", "COLOUR_ORANGE", "COLOUR_PURPLE", "COLOUR_RAINBOW", "COLOUR_RED", "COLOUR_YELLOW"],
    "maths": ["IF_ELSE", "IF_END", "IF_ENEMY", "IF_HALF", "IF_HP", "IF_PROJECTILE", "SLOW_BUT_STEADY"],
    "funky": ["FUNKY_SPELL"],

    // Fish questline
    "fish": ["FISH"],
    "homing_wand": ["HOMING_WAND"],

    // Sun quest
    "black_hole": ["WHITE_HOLE_GIGA", "BLACK_HOLE_GIGA"],

    // Etc
    "rainbow_trail": ["RAINBOW_TRAIL"],
    "destruction": ["DESTRUCTION"],
};

export const UNLOCK_DISPLAY_NAMES = {
    "sea_lava": "Sea of Lava Orb",
    "crumbling_earth": "Earthquake Orb",
    "cloud_thunder": "Thundercloud Orb",
    "nuke": "Nuke Orb",
    "bomb_holy": "Holy Bomb Orb",
    "necromancy": "Necromancy Orb",
    "material_cement": "Cement Orb",
    "firework": "Firework Orb",
    "exploding_deer": "Ducks/Deercoy Orb",
    "spiral_shot": "Spiral Shot Orb",
    "tentacle": "Tentacle Orb",
    "sea_mimic": "Sea of Mimicium",
    "touch_grass": "Touch of Grass",
    "cessation": "Cessation",
    "piss": "Touch of Piss",
    "kantele": "Kantele Notes",
    "ocarina": "Ocarina Notes",
    "musicbox": "Divides/Coral Chest",
    "alchemy": "Dark Chest",
    "everything": "End of Everything",
    "divide": "Divide by 10",
    "bomb_holy_giga": "Giga Holy Bomb",
    "nukegiga": "Giga Nuke",
    "mestari": "Master of Masters",
    "duplicate": "Alchemist/Greek Letters",
    "pyramid": "Pyramid Boss",
    "dragon": "Dragon",
    "rain": "Pit Boss",
    "polymorph": "Mass Polymorph",
    "paint": "Glimmer Spells",
    "maths": "Requirement Spells",
    "funky": "Chaingun",
    "fish": "Fish",
    "homing_wand": "Wand Homing",
    "black_hole": "Omega Black Hole",
    "rainbow_trail": "Rainbow Trail",
    "destruction": "Destruction",
}

// Initialize active spells (defaulting to all true before reset)
export let unlockedSpells = new Array(ALL_SPELLS.length).fill(true);

// Global to keep track of it... (not used?)
let unlock_list = [];

export function injectUnlocksData(cachedData) {
    unlockedSpells = cachedData;
}

export function setUnlocks(new_unlock_list) {
    unlock_list = new_unlock_list;
    // Reset to base state (all true initially)
    unlockedSpells.fill(true);

    // 1. Lock all spells that are in the unlockables dictionary
    for (const key in UNLOCKABLES) {
        const spellsToLock = UNLOCKABLES[key];
        for (const spellName of spellsToLock) {
            const index = ALL_SPELLS.findIndex(s => s.name === spellName);
            if (index !== -1) {
                unlockedSpells[index] = false;
            }
        }
    }

    // 2. Unlock spells based on the provided list
    for (const unlockKey of unlock_list) {
        if (UNLOCKABLES[unlockKey]) {
            const spellsToUnlock = UNLOCKABLES[unlockKey];
            for (const spellName of spellsToUnlock) {
                const index = ALL_SPELLS.findIndex(s => s.name === spellName);
                if (index !== -1) {
                    unlockedSpells[index] = true;
                }
            }
        }
    }
    
    return unlockedSpells;
}