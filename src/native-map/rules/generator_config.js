// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
export const GENERATOR_CONFIG = {
    'coalmine': { color: 0xffd57917, wangFile: '../data/wang_tiles/coalmine.png', name: "Mines" },
    'coalmine_alt': { color: 0xffD56517, wangFile: '../data/wang_tiles/coalmine_alt.png', name: "Collapsed Mines" },
    'excavationsite': { color: 0xff124445, wangFile: '../data/wang_tiles/excavationsite.png', name: "Coal Pits" },
    'snowcave': { color: 0xff1775d5, wangFile: '../data/wang_tiles/snowcave.png', name: "Snowy Depths" },
    'snowcastle': { color: 0xff0046FF, wangFile: '../data/wang_tiles/snowcastle.png', name: "Hiisi Base" },
    'rainforest': { color: 0xff808000, wangFile: '../data/wang_tiles/rainforest.png', name: "Underground Jungle" },
    'rainforest_open': { color: 0xffA08400, wangFile: '../data/wang_tiles/rainforest_open.png', name: "Underground Jungle (Open)" },
    'vault': { color: 0xff008000, wangFile: '../data/wang_tiles/vault.png', name: "The Vault" },
    'crypt': { color: 0xff786C42, wangFile: '../data/wang_tiles/crypt.png', name: "Temple of the Art" },
    'fungicave': { color: 0xffe861f0, wangFile: '../data/wang_tiles/fungicave.png', name: "Fungal Caverns" },
    'fungiforest': { color: 0xffa861ff, wangFile: '../data/wang_tiles/fungiforest.png', name: "Overgrown Cavern" },
    'rainforest_dark': { color: 0xff375c00, wangFile: '../data/wang_tiles/rainforest_dark.png', name: "Lukki Lair" },
    'wizardcave': { color: 0xff726186, wangFile: '../data/wang_tiles/wizardcave.png', name: "Wizard's Den" },
    'liquidcave': { color: 0xff89a04b, wangFile: '../data/wang_tiles/liquidcave.png', name: "Ancient Laboratory", randomColors: {0x01CFEE: [0xF86868,0x7FCEEA,0xA3569F,0xC23055,0x0BFFE5]} }, /* 0x12BBEE: [0x000000,0xFFFFFF]} */
    'robobase': { color: 0xff4e5267, wangFile: '../data/wang_tiles/robobase.png', name: "Power Plant" },
    'vault_frozen': { color: 0xff0080a8, wangFile: '../data/wang_tiles/vault_frozen.png', name: "Frozen Vault" },
    'meat': { color: 0xff572828, wangFile: '../data/wang_tiles/meat.png', name: "Meat Realm" },
    'wandcave': { color: 0xff006C42, hasStuff: false, wangFile: '../data/wang_tiles/wand.png', name: "Magical Temple" },
    'pyramid': { color: 0xff967f11, hasStuff: false, wangFile: '../data/wang_tiles/pyramid.png', optional: true, name: "Pyramid" },
    'sandcave': { color: 0xffE1CD32, hasStuff: false, wangFile: '../data/wang_tiles/sandcave.png', optional: true, name: "Sandcave" },
    'clouds': { color: 0xff36d5c9, hasStuff: false, wangFile: '../data/wang_tiles/clouds.png', optional: true, name: "Cloudscape" },
    'the_sky': { color: 0xffD3E6F0, hasStuff: false, wangFile: '../data/wang_tiles/the_sky.png', optional: true, name: "The Work (Sky)" },
    'the_end': { color: 0xff3C0F0A, hasStuff: false, wangFile: '../data/wang_tiles/the_end.png', name: "The Work (Hell)" },
    'boss_victoryroom': { color: 0xff50eed7, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "The Work (Victory Room)" },
    'winter_caves': { color: 0xff77A5BD, hasStuff: false, wangFile: '../data/wang_tiles/snowchasm.png', optional: true, name: "Snowy Chasm" },
    'solid_wall_tower_1': { color: 0xff3d3e37, wangFile: '../data/wang_tiles/coalmine.png', name: "Tower (Mines)" },
    'solid_wall_tower_2': { color: 0xff3d3e38, wangFile: '../data/wang_tiles/excavationsite.png', name: "Tower (Coal Mines)" },
    'solid_wall_tower_3': { color: 0xff3d3e39, wangFile: '../data/wang_tiles/snowcave.png', name: "Tower (Snowy Depths)" },
    'solid_wall_tower_4': { color: 0xff3d3e3a, wangFile: '../data/wang_tiles/snowcastle.png', name: "Tower (Hiisi Base)" },
    'solid_wall_tower_5': { color: 0xff3d3e3b, wangFile: '../data/wang_tiles/fungicave.png', name: "Tower (Fungal Caverns)" },
    'solid_wall_tower_6': { color: 0xff3d3e3c, wangFile: '../data/wang_tiles/rainforest.png', name: "Tower (Underground Jungle)" },
    'solid_wall_tower_7': { color: 0xff3d3e3d, wangFile: '../data/wang_tiles/vault.png', name: "Tower (The Vault)" },
    'solid_wall_tower_8': { color: 0xff3d3e3e, wangFile: '../data/wang_tiles/crypt.png', name: "Tower (Temple of the Art)" },
    'solid_wall_tower_9': { color: 0xff3d3e3f, wangFile: '../data/wang_tiles/the_end.png', name: "Tower (Hell)" },
    'lake_deep': { color: 0xff1158f1, wangFile: '../data/wang_tiles/water.png', optional: true, name: "Lake" },
    // Extra biomes that don't have wang tiles
    'excavationsite_cube_chamber': { color: 0xff24888a, fillMaterial: 'rock_static_grey', fillApprox: true, name: "Meditation Cube" },
    'snowcave_secret_chamber': { color: 0xff18a0d6, fillMaterial: 'snowrock_static', fillApprox: true, name: "Snowcave Secret Chamber" },
    'snowcastle_cavern': { color: 0xff775ddb, fillMaterial: 'rock_hard_border', name: "Hiisi Hourglass Shop" },
    'snowcastle_hourglass_chamber': { color: 0xff18d6d6, fillMaterial: 'rock_static_grey', fillApprox: true, name: "Eye Room" },
    'robot_egg': { color: 0xff9e4302, fillMaterial: 'lava', name: "Robot Egg" },
    'pyramid_hallway': { color: 0xff167f5f, fillMaterial: 'templebrickdark_static', fillApprox: true, hasStuff: false, name: "Pyramid (Hallway)" },
    'pyramid_right': { color: 0xff968f96, hasStuff: false, name: "Pyramid (Right)" },
    'pyramid_entrance': { color: 0xff967f5f, hasStuff: false, name: "Pyramid (Entrance)" },
    'pyramid_left': { color: 0xff968f5f, hasStuff: false, name: "Pyramid (Left)" },
    'pyramid_top': { color: 0xffc88f5f, name: "Pyramid (Top)"},
    'secret_lab': { color: 0xffbaa345, fillMaterial: 'templebrickdark_static', sceneOnly: true, name: "Abandoned Alchemy Lab" },
    'wizardcave_entrance': { color: 0xff804169, name: "Triangle Boss"},
    'dragoncave': { color: 0xff364d24, fillMaterial: 'rock_hard_border', sceneOnly: true, name: "Dragoncave" },
    'roboroom': { color: 0xff9d893d, fillMaterial: 'rock_static', sceneOnly: true, name: "Mecha Kolmi Boss Room" },
    'meatroom': { color: 0xff796620, fillMaterial: 'meat_static', sceneOnly: true, name: "Meatball Boss Room" },
    'ghost_secret': { color: 0xff1F3B64, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Forgotten Boss Room" },
    'mestari_secret': { color: 0xff1F3B62, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Throne Room" },
    'temple_altar': { color: 0xff93cb4c, sceneOnly: true, name: "Holy Mountain" }, // Apparently the only one with edge noise??
    'temple_altar_left': { color: 0xff93cb4d, sceneOnly: true, hasStuff: false, name: "Holy Mountain (Left)" },
    'temple_altar_right': { color: 0xff93cb4e, sceneOnly: true, hasStuff: false, name: "Holy Mountain (Right)" },
    'temple_altar_right_snowcave': { color: 0xff93cb4f, sceneOnly: true, hasStuff: false, name: "Holy Mountain (Snowy Depths Exit)" }, // note: not used in NG, for some reason
    'temple_altar_right_snowcastle': { color: 0xff93cb5a, sceneOnly: true, hasStuff: false, name: "Holy Mountain (Hiisi Base Exit)" }, // note: not used in NG+, for some reason
    'temple_wall_ending': { color: 0xff5a9628, sceneOnly: true, hasStuff: false, name: "Holy Mountain Basin (End)" },
    'temple_wall': { color: 0xff6dcb28, fillMaterial: 'templebrick_static', hasStuff: false, name: "Holy Mountain Basin" },
    'solid_wall_temple': { color: 0xffB8A928, fillMaterial: 'templebrick_static', hasStuff: false, name: "Holy Mountain (Solid)" },
    // Empty HM variants excluded since they only apply to daily practice run mod
    'boss_arena': { color: 0xff14EED7, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "The Laboratory" },
    'boss_arena_top': { color: 0xff0da899, hasStuff: false, name: "The Laboratory (Top)" },
    // Surface and other kind of useless ones
    'hills': { color: 0xff36d517, hasStuff: false, name: "Hills" },
    'hills2': { color: 0xff33e311, hasStuff: false, name: "Hills2" },
    'desert': { color: 0xffCC9944, hasStuff: false, name: "Desert" },
    'scale': { color: 0xffeba500, hasStuff: false, name: "Scale" },
    'winter': { color: 0xffD6D8E3, hasStuff: false, name: "Snowy Wasteland" },
    'lake': { color: 0xff1133F1, hasStuff: false, name: "Lake (Surface)" },
    'lake_statue': { color: 0xff11A3FC, hasStuff: false, name: "Lake (Island)" },
    'lava': { color: 0xffFF6A02, fillMaterial: 'lava', hasStuff: false, name: "Volcanic Lake" },
    'lava_90percent': { color: 0xffFFA717, fillMaterial: 'lava', hasStuff: false, name: "Volcanic Lake (90%)" },
    'gold': { color: 0xffFFFF00, fillMaterial: 'gold', hasStuff: false, name: "Gold" }, // Functionally useful but not for this
    'water': { color: 0xff0000FF, fillMaterial: 'water', hasStuff: false, name: "Water" }, // Literally useless and yet very mysterious!
    'solid_wall': { color: 0xff3d3d3d, fillMaterial: 'rock_hard_border', hasStuff: false, name: "EDR" },
    //'solid_wall_damage': { color: 0xff684C4C, hasStuff: false, name: "Cursed Rock" }, // Actually got this mixed up, I don't know if this one is used
    'solid_wall_tower': { color: 0xff3f3d3e, fillMaterial: 'rock_static_cursed', hasStuff: false, name: "Cursed Rock" },
    // Orb rooms
    'orbroom_00': { color: 0xffffd100, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (0)" },
    'orbroom_01': { color: 0xffffd101, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (1)" },
    'orbroom_02': { color: 0xffffd102, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (2)" },
    'orbroom_03': { color: 0xffffd103, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (3)" },
    'orbroom_04': { color: 0xffffd104, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (4)" },
    'orbroom_05': { color: 0xffffd105, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (5)" },
    'orbroom_06': { color: 0xffffd106, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (6)" },
    'orbroom_07': { color: 0xffffd107, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (7)" },
    'orbroom_08': { color: 0xffffd108, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (8)" },
    'orbroom_09': { color: 0xffffd109, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (9)" },
    'orbroom_10': { color: 0xffffd110, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (10)" },
    'orbroom_11': { color: 0xffffd111, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Orb Room (11)" },
    // Static tile
    'biome_watchtower': { color: 0xffb70000, wangFile: '../data/wang_tiles/static/watchtower_fg.png', optional: true, name: "Watchtower" },
    'biome_potion_mimics': { color: 0xffff00fe, wangFile: '../data/wang_tiles/static/potion_mimics_fg.png', name: "Henkevä Temple" },
    'biome_darkness': { color: 0xffff00fd, wangFile: '../data/wang_tiles/static/darkness_fg.png', name: "Ominous Temple" },
    'biome_boss_sky': { color: 0xffff00fc, wangFile: '../data/wang_tiles/static/boss_fg.png', optional: true, name: "Kivi Temple" },
    'biome_barren': { color: 0xffff00fb, wangFile: '../data/wang_tiles/static/barren_fg.png', optional: true, name: "Barren Temple" },
    // Spliced pixel scene biomes and other useless stuff
    'mountain_lake': { color: 0xfff7cf8d, hasStuff: false, name: "Pond" },
    'lavalake': { color: 0xff3d5a3d, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "Lava Lake" },
    'lavalake_pit': { color: 0xff3d5a4f, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "Lava Lake Pit" },
    'lavalake_racing': { color: 0xff4118d6, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "Racetrack" },
    'mountain_left_stub': { color: 0xff608080, hasStuff: false, name: "Mountain (Left Stub)" },
    'mountain_left_entrance': { color: 0xff208080, hasStuff: false, name: "Mountain (Left Entrance)" },
    'mountain_hall': { color: 0xff204060, sceneOnly: true, hasStuff: false, name: "Mountain (Hall)" },
    'mountain_right': { color: 0xff408080, hasStuff: false, name: "Mountain (Right)" },
    'mountain_right_stub': { color: 0xffE08080, hasStuff: false, name: "Mountain (Right Stub)" },
    'mountain_top': { color: 0xffC08080, hasStuff: false, name: "Mountain (Top)" },
    'mountain_floating_island': { color: 0xffC08082, hasStuff: false, name: "Mountain (Floating Island)" },
    'mountain_tree': { color: 0xff14E1D7, hasStuff: false, name: "Tree" },
    'solid_wall_hidden_cavern': { color: 0xff42244d, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Hidden Cavern" },
    'solid_wall_tower_10': { color: 0xff3d3e41, fillMaterial: 'templebrickdark_static', sceneOnly: true, name: "Tower (Reward)" },
    // The two chunks at 53,22 and 55,22 flanking the tower reward room. The game
    // gives this color no biome of its own: data/biome/_biomes_all.xml:17-20 is a
    // second <Biome> entry pointing at the same data/biome/hills.xml as #36d517.
    'hills_tower': { color: 0xff3d3e40, hasStuff: false, name: "Hills (Tower)" },
    'bridge': { color: 0xffad8111, hasStuff: false, name: "Bridge" },
    'empty': { color: 0xff48E311, hasStuff: false, name: "Empty" },
    'snowcave_tunnel': { color: 0xff7be311, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "Snowcave Tunnel" },
    'watercave': { color: 0xff3046c1, sceneOnly: true, fillMaterial: 'rock_static', hasStuff: false, name: "Dark Cave" },
    'sky_light_injector': { color: 0xfffe0000, hasStuff: false, name: "Sky Light Injector" },
    'teleroom': { color: 0xff5f8fab, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Teleport Room" },
    'friend_1': { color: 0xff6db55a, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (1)" },
    'friend_2': { color: 0xff6db55b, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (2)" },
    'friend_3': { color: 0xff6db55c, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (3)" },
    'friend_4': { color: 0xff6db55d, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (4)" },
    'friend_5': { color: 0xff6db55e, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (5)" },
    'friend_6': { color: 0xff6db55f, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Friend Room (6)" },
    'gun_room': { color: 0xff39a760, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Gun Room" },
    'null_room': { color: 0xffe17e32, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Nullification Altar" },
    'rock_room': { color: 0xff326655, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Rock Room" },
    'funroom': { color: 0xff0a95a4, sceneOnly: true, hasStuff: false, name: "Fungal Map" },
    'song_room': { color: 0xff9d99d1, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Coral Chest" },
    'alchemist_secret': { color: 0xff57dace, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Dark Chest" },
    'moon_room': { color: 0xff567cb0, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Moon Room" },
    // Covered end to end by the spliced gourd_room scene, which paints its own
    // explicit material colors; fillMaterial is only the answer for a scene's
    // density-1.0 class, and the game's dump of the cell reads 86.5% rock_hard_border.
    'gourd_room': { color: 0xff2e99d1, fillMaterial: 'rock_hard_border', sceneOnly: true, hasStuff: false, name: "Gourd Room" },
    'greed_room': { color: 0xff3f55d1, sceneOnly: true, hasStuff: false, name: "Greed Room" }, // Not sure this is used
    'ocarina': { color: 0xff57cace, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Ocarina" },
    'essenceroom_air': { color: 0xff157cb8, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Essence of Air" },
    'essenceroom': { color: 0xff157cb0, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Essence of Earth" },
    'essenceroom_hell': { color: 0xff157cb5, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Essence of Water" },
    'essenceroom_alc': { color: 0xff157cb6, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Essence of Spirits" },
    'mystery_teleport': { color: 0xff157cb7, fillMaterial: 'templebrickdark_static', sceneOnly: true, hasStuff: false, name: "Mystery Teleport" },
    'roadblock': { color: 0xfff0d517, sceneOnly: true, fillMaterial: 'rock_hard_border', hasStuff: false, name: "Roadblock" },
};

Object.values(GENERATOR_CONFIG).forEach(conf => {
    conf.enabled = true; // Default to all enabled, we can disable later if needed
    conf.pois = conf.pois || []; // No longer used... Overlaps made PoIs not really work per-biome
});

export const BIOME_COLOR_TO_NAME = {};
Object.entries(GENERATOR_CONFIG).forEach(([biomeName, conf]) => {
    BIOME_COLOR_TO_NAME[conf.color & 0xffffff] = biomeName;
});

// Only the ones with wang tiles. This means "has a generated buffer / an atlas
// region", which is what the GL region tables key off — do NOT widen it to cover
// fill biomes; use BIOME_COLORS_WITH_TERRAIN for "the game paints something here".
export const BIOME_COLORS_WITH_TILES = new Set(Object.values(GENERATOR_CONFIG).filter(conf => conf.wangFile != null).map(conf => conf.color & 0xffffff));

/**
 * `fillMaterial`: biome-map color -> the biome's density-1.0 material, i.e. what
 * the engine paints where its <MaterialComponent> bands say "solid" (data/biome/*.xml).
 *
 * Where two components overlap (solid_wall's rock_hard index 10 + rock_hard_border
 * index 9, watercave's rock_hard + rock_static) the lower material_index wins,
 * which is also what the hand-authored biome_map_foreground colors agree with.
 *
 * This map answers two different questions and only one of them is "is the whole
 * chunk solid":
 *
 *  1. the color a stamped pixel scene's white/gray (density 1.0) pixels resolve
 *     to — `sceneMaterialFillColorForBiome` in image_processing.js. True for
 *     every entry here, `sceneOnly` or not: white in a scene really is "fill with
 *     this biome's own material" (validated to the exact pixel count on lavalake
 *     and teleroom, scripts/reports/room_biome_game_mechanism.md §1.4).
 *  2. the color the renderers paint the *chunk* with — FILL_LAYER_MATERIALS below.
 *
 * `sceneOnly: true` splits the two. Those biomes are BIOME_WANG_TILE topology with
 * an empty wang_template_file: the generator paints **nothing**, the chunk is air,
 * and all of its content comes from the room's pixel scene (which telescope already
 * stamps). Filling those chunks was telescope's single largest terrain error —
 * rock_room's chunk is 82% air in-game and telescope painted it 100% solid. See
 * scripts/reports/room_biome_game_mechanism.md §2.1 for the per-biome evidence.
 *
 * `fillApprox: true` survives on exactly the four class-B cave rooms whose
 * <MaterialComponent> bands start below 1.0, so a perlin density field really does
 * hollow ~10% of the chunk out. Telescope has no density field, so a constant fill
 * of the dominant material is an approximation there rather than the engine's answer.
 */
export const FILL_BIOME_MATERIALS = {};
Object.values(GENERATOR_CONFIG).forEach(conf => {
    if (conf.fillMaterial) FILL_BIOME_MATERIALS[conf.color & 0xffffff] = conf.fillMaterial;
});

export const FILL_BIOME_COLORS = new Set(Object.keys(FILL_BIOME_MATERIALS).map(Number));

/**
 * Biomes that paint no terrain at all — everything in the chunk is its pixel scene.
 *
 * The engine's own rule for this is BIOME_ENGINE.paintsNothing in
 * js/engine_resolve/engine_data.js: a BIOME_WANG_TILE topology with an empty
 * wang_template_file, which the GL path reads directly (gl/engine_resources.js,
 * engChunk bit 11). This hand list is that rule transcribed, so the two agree —
 * the flags on temple_altar*, temple_wall_ending, mountain_hall, watercave,
 * funroom, greed_room and roadblock came from it, after the GL side started
 * correctly painting air in those chunks while the CPU bake and the hover
 * readout still claimed a chunk fill (watercave and roadblock were the two that
 * carried a `fillMaterial`, so they were the two that actually painted).
 *
 * It is transcribed rather than imported because generator_config.js is pulled
 * into workers that have no other reason to parse engine_data.js's 278 KB.
 *
 * One disagreement is deliberately left standing: `boss_arena` is flagged here
 * (measured — scripts/reports/room_biome_game_mechanism.md §2.1) but is NOT
 * paintsNothing in the engine table. Keeping the flag preserves the measured
 * behaviour; the table entry is the thing to re-derive.
 */
export const SCENE_ONLY_COLORS = new Set(Object.values(GENERATOR_CONFIG)
    .filter(conf => conf.sceneOnly).map(conf => conf.color & 0xffffff));

/**
 * The fill biomes the engine really fills, and with what: `fillMaterial` minus the
 * `sceneOnly` rooms. This is the "paint this whole chunk solid" set, so it is what
 * the fill layers (tile_generator.js), the CPU bake and GL chunk texture
 * (image_processing.js terrainFillColor / gl/chunk_textures.js CHUNK_FLAG_FILL) and
 * the hover readout key off — one source of truth, so the two renderers cannot
 * disagree about which chunks are filled.
 */
export const FILL_LAYER_MATERIALS = {};
Object.values(GENERATOR_CONFIG).forEach(conf => {
    if (conf.fillMaterial && !conf.sceneOnly) FILL_LAYER_MATERIALS[conf.color & 0xffffff] = conf.fillMaterial;
});

export const FILL_LAYER_COLORS = new Set(Object.keys(FILL_LAYER_MATERIALS).map(Number));

/**
 * Every biome the renderers paint terrain for: wang buffers plus constant fills.
 *
 * The `sceneOnly` rooms stay in: the wobble at their border is a real neighbour
 * bleed (noise_biome_edges defaults to 1, and the game's rock_room dump shows a
 * ~30px rock rim around the air pocket), so a neighbour's terrain drifting into
 * one of these chunks must still paint. What changed is only that the room chunk
 * no longer paints itself.
 */
export const BIOME_COLORS_WITH_TERRAIN = new Set([...BIOME_COLORS_WITH_TILES, ...FILL_BIOME_COLORS]);

// Used to generate the holy mountain basin material variants
export const HOLY_MOUNTAIN_BASIN_COLORS = new Set([
    0x93cb4c, // temple_altar
    0x93cb4d, // temple_altar_left
    0x93cb4e, // temple_altar_right
    0x93cb4f, // temple_altar_right_snowcave (note: not used in NG, for some reason)
    0x93cb5a, // temple_altar_right_snowcastle (note: not used in NG+, for some reason)
    0x5a9628, // temple_wall_ending
    0x6dcb28, // temple_wall
]);
