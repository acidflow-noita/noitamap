// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
// TODO: A lot of these can be removed since making pixel scenes work removed the need for tuned offsets
export const ALTAR_SPAWN_DATA = {
    // Some of these will apparently have extra offsets that I can't explain but just work?
    'coalmine': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4,
        gx: 0,
        gy: 0,
    },
    'coalmine_alt': {
        r0: 0.47,
        rl: 0.725,
        x: 0,
        y: -14,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4,
    },
    'excavationsite': {
        rl: 0.725,
        x: 0,
        y: -14,
        xoff: -11.431,
        yoff: 10.5257
    },
    'snowcave': {
        rg: 0.45,
        x: -5,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'snowcastle': {
        rl: 0.2,
        x: 5,
        y: -5, // -5 if offset is 5
        xoff: -11.631,
        yoff: 10.2257,
        gx: 0,
        gy: 0, // Fixes the 1 tile offset, though not sure where it came from
        rp: 0.65,
        px: 6,
        py: -3
    },
    // TODO: Still bugged, might be a hack in game because of the slightly offset tiles of the two biomes
    'rainforest': {
        rl: 0.27,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        gx: 0,
        gy: 0, // Fixes the 1 tile offset, though not sure where it came from
        rp: 0.65,
        px: 5,
        py: -4
    },
    'rainforest_open': {
        rl: 0.27,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'rainforest_dark': {
        rl: 0.27, // Seems off, getting false positives occasionally?
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'vault': {
        rg: 0.93,
        x: 5,
        y: -6,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 6,
        py: -4
    },
    'crypt': {
        rl: 0.38,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'fungicave': {
        rl: 0.06,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0, // No threshold here
        px: 0,
        py: -6
    },
    'fungiforest': {
        rl: 0.06,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0, // No threshold here
        px: 0,
        py: -6
    },
    'wizardcave': {
        rl: 0.38,
        x: 0,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'liquidcave': {
        rg: 0.0,
        x: 0,
        y: -14, // No wands here anyway
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4,
        gx: 0,
        gy: 0
    },
    // Copied from snowcastle, no wands or potions yet there are configs for them
    'sandcave': {
        rg: 0.94,
        x: 5,
        y: -5,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 6,
        py: -3
    },
    'robobase': {
        rg: 0.93,
        x: 5,
        y: -6,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 6,
        py: -4
    },
    'vault_frozen': {
        // Utility box
        ru: 0.93,
        rg: 0.83,
        x: 5,
        y: -6,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 6,
        py: -4
    },
    'meat': {
        // Utility box
        ru: 0.55,
        rg: 0.3,
        x: -5,
        y: -14,
        xoff: -11.631,
        yoff: 10.2257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_1': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_2': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_3': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_4': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_5': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_6': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_7': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'solid_wall_tower_8': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    // This one is broken for some reason? Maybe
    'solid_wall_tower_9': {
        r0: 0.47,
        rl: 0.755,
        x: 5,
        y: -9,
        xoff: -11.431,
        yoff: 10.5257,
        rp: 0.65,
        px: 5,
        py: -4
    },
    'excavationsite_cube_chamber': {
        rg: 1.0,
        x: 0,
        y: 0,
        xoff: 0.0,
        yoff: 0.0,
        rp: 0.0,
        px: 0,
        py: 0
    },
    'snowcave_secret_chamber': {
        rg: 1.0,
        x: 0,
        y: 0,
        xoff: 0.0,
        yoff: 0.0,
        rp: 0.0,
        px: 0,
        py: 0
    },
    'robot_egg': {
        rg: 1.0,
        x: 0,
        y: 0,
        xoff: 0.0,
        yoff: 0.0,
        rp: 0.0,
        px: 0,
        py: 0
    }
};

export const WAND_SPAWN_DATA = {
    'coalmine': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'premade_10', 'premade_11', 'premade_12', 'premade_13', 'premade_14', 'premade_15', 'premade_16', 'premade_17',
            'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1.9]
    },
    'coalmine_alt': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9'],
        weights: [1,1,1,1,1,1,1,1,1]
    },
    'excavationsite': {
        types: ['wand_unshuffle_01', 'wand_level_02', 'wand_level_02_better'], 
        weights: [2, 2, 2] 
    },
    'snowcave': {
        types: ['wand_level_02', 'wand_level_02_better', 'wand_unshuffle_02'], 
        weights: [5, 5, 5] 
    },
    'snowcastle': {
        types: ['wand_level_03', 'wand_level_03_better', 'wand_unshuffle_03'], 
        weights: [5, 5, 5] 
    },
    'rainforest': {
        types: ['wand_level_04', 'wand_level_05', 'wand_unshuffle_02', 'wand_unshuffle_03', 'wand_level_04_better'], 
        weights: [5, 3, 3, 3, 5] 
    },
    'rainforest_open': {
        types: ['wand_level_04', 'wand_level_05', 'wand_unshuffle_02', 'wand_unshuffle_03', 'wand_level_04_better'], 
        weights: [5, 3, 3, 3, 5] 
    },
    'vault': {
        types: ['wand_level_05', 'wand_level_05_better', 'wand_unshuffle_03', 'wand_unshuffle_04'], 
        weights: [5, 5, 3, 2]
    },
    'crypt': {
        types: ['wand_level_06', 'wand_level_06_better', 'wand_unshuffle_05', 'wand_unshuffle_06'], 
        weights: [5, 5, 3, 2] 
    },
    'fungicave': {
        types: ['wand_unshuffle_02', 'wand_unshuffle_01'], 
        weights: [0.5, 0.5] 
    },
    'fungiforest': {
        types: ['wand_unshuffle_03', 'wand_unshuffle_04', 'wand_level_05_better'], 
        weights: [5, 5, 5] 
    },
    'rainforest_dark': {
        types: ['wand_level_04', 'wand_level_05', 'wand_unshuffle_03', 'wand_unshuffle_04', 'wand_level_05_better'], 
        weights: [5, 3, 3, 3, 5] 
    },
    'wizardcave': {
        types: ['wand_level_06', 'wand_level_06_better', 'wand_unshuffle_05', 'wand_unshuffle_06'], 
        weights: [5, 5, 3, 2] 
    },
    'liquidcave': {
        types: [], 
        weights: [] 
    },
    'sandcave': {
        types: ['wand_level_04', 'wand_unshuffle_02'],
        weights: [5, 5]
    },
    'robobase': {
        types: ['wand_level_05', 'wand_level_05_better', 'wand_unshuffle_03', 'wand_unshuffle_04'], 
        weights: [5, 5, 3, 2] 
    },
    'vault_frozen': {
        types: ['wand_level_05', 'wand_unshuffle_03', 'wand_unshuffle_04'], 
        weights: [5, 3, 2] 
    },
    'meat': {
        types: ['wand_level_05', 'wand_level_06', 'wand_unshuffle_04', 'wand_unshuffle_05'], 
        weights: [5, 5, 5, 5] 
    },
    'solid_wall_tower_1': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_2': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_3': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_4': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_5': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_6': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_7': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_8': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'solid_wall_tower_9': {
        types: ['premade_1', 'premade_2', 'premade_3', 'premade_4', 'premade_5', 'premade_6', 'premade_7', 'premade_8', 'premade_9', 'wand_level_01'],
        weights: [1,1,1,1,1,1,1,1,1,1]
    },
    'excavationsite_cube_chamber': {
        types: ['wand_level_03', 'wand_unshuffle_02'],
        weights: [0.5, 0.5]
    },
    'snowcave_secret_chamber': {
        types: ['wand_level_03', 'wand_unshuffle_02'],
        weights: [0.5, 0.5]
    },
    'robot_egg': {
        types: ['wand_level_05', 'wand_level_05_better', 'wand_unshuffle_03', 'wand_unshuffle_04'],
        weights: [5, 5, 3, 2]
    }
};

export const BIOMES_WITH_SMALL_ALTARS = [
    'snowcastle',
    'vault',
    'vault_frozen',
    'robobase'
];

// Can exclude x: -10, y: -17 since it's the default
export const BIOME_WAND_ALTAR_OFFSET_MAP = {
    // TODO: 
    coalmine: {x: -5, y: -12},
    //coalmine_alt: {x: -10, y: -17},
    //excavationsite: {x: -10, y: -17},
    snowcave: {x: -15, y: -17},
    snowcastle: {x: -5, y: -9},
    //rainforest: {x: -10, y: -17},
    //rainforest_open: {x: -10, y: -17},
    //rainforest_dark: {x: -10, y: -17},
    vault: {x: -5, y: -10},
    vault_frozen: {x: -5, y: -10},
    robobase: {x: -5, y: -10},
    meat: {x: -15, y: -17},
    solid_wall_tower_1: {x: -5, y: -12},
    solid_wall_tower_2: {x: -5, y: -12},
    solid_wall_tower_3: {x: -5, y: -12},
    solid_wall_tower_4: {x: -5, y: -12},
    solid_wall_tower_5: {x: -5, y: -12},
    solid_wall_tower_6: {x: -5, y: -12},
    solid_wall_tower_7: {x: -5, y: -12},
    solid_wall_tower_8: {x: -5, y: -12},
    solid_wall_tower_9: {x: -5, y: -12},
    // Note: pyramid and liquidcave explcitly *disable* this spawn...
    // So does meditation cube, winter_caves, probably some other ones too
    // Normal side biomes with wand altars don't though.
}

// Default x: -5, y: -15
export const BIOME_POTION_ALTAR_OFFSET_MAP = {
    // TODO: 
    snowcastle: {x: -3, y: -9},
    vault: {x: -3, y: -10},
    vault_frozen: {x: -3, y: -10},
    robobase: {x: -3, y: -10},
    fungicave: {x: -10, y: -17},
    fungiforest: {x: -10, y: -17},
}