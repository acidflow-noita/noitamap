// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
export const BLOCKED_COLORS = [
	0x00ac6e, // load_pixel_scene4_alt
	0x70d79e, // load_gunpowderpool_01
	0x70d79f, // load_gunpowderpool_02
	0x70d7a0, // load_gunpowderpool_03
	0x70d7a1, // load_gunpowderpool_04
	0x7868ff, // load_puzzleroom
	0xc35700, // load_oiltank
	0xff0080, // load_pixel_scene2
	0xff00ff, //???
	0xff0aff, // load_pixel_scene
	0x00AC64, // load_pixel_scene4
];

// Unclear what these are for exactly
export const PIXEL_SCENE_ROOM_MAP = {
	0x00ac6e: "load_pixel_scene4_alt",
	0x70d79e: "load_gunpowderpool_01",
	0x70d79f: "load_gunpowderpool_02",
	0x70d7a0: "load_gunpowderpool_03",
	0x70d7a1: "load_gunpowderpool_04",
	0x7868ff: "load_puzzleroom",
	0xc35700: "load_oiltank",
	0xff0080: "load_pixel_scene2",
	0xff00ff: "unknown_ff00ff",
	0xff0aff: "load_pixel_scene",
}

export const COALMINE_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "coalpit01"},
		{prob: 0.5, name: "coalpit02"},
		{prob: 0.5, name: "carthill"},
		{prob: 0.5, name: "coalpit03"},
		{prob: 0.5, name: "coalpit04"},
		{prob: 0.5, name: "coalpit05"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "shrine01"},
		{prob: 0.5, name: "shrine02"},
		{prob: 0.5, name: "slimepit"},
		{prob: 0.5, name: "laboratory"},
		{prob: 0.5, name: "swarm"},
		{prob: 0.5, name: "symbolroom"},
		{prob: 0.5, name: "physics_01"},
		{prob: 0.5, name: "physics_02"},
		{prob: 0.5, name: "physics_03"},
		{prob: 1.5, name: "shop"},
		{prob: 0.5, name: "radioactivecave"},
		{prob: 0.75, name: "wandtrap_h_02"},
		{prob: 0.75, name: "wandtrap_h_04", color_material: {"f0bbee": ["oil", "alcohol", "gunpowder_explosive"]}},
		{prob: 0.75, name: "wandtrap_h_06", color_material: {"f0bbee": ["magic_liquid_teleportation", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "radioactive_liquid"]}},
		{prob: 0.75, name: "wandtrap_h_07", color_material: {"f0bbee": ["water", "oil", "alcohol", "radioactive_liquid"]}},
		{prob: 0.5, name: "physics_swing_puzzle"},
		{prob: 0.5, name: "receptacle_oil"},
	],
	"g_oiltank": [
		{prob: 1.0, name: "oiltank_1", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "coal", "radioactive_liquid"]}},
		{prob: 0.0004, name: "oiltank_1", color_material: {"f0bbee": ["magic_liquid_teleportation", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "magic_liquid_berserk", "magic_liquid_charm", "magic_liquid_invisibility", "magic_liquid_hp_regeneration", "salt", "blood", "gold", "honey"]}},
		{prob: 0.01, name: "oiltank_2", color_material: {"f0bbee": ["blood_fungi", "blood_cold", "lava", "poison", "slime", "gunpowder_explosive", "soil", "salt", "blood", "cement"]}},
		{prob: 1.0, name: "oiltank_2", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "oil", "coal", "radioactive_liquid"]}},
		{prob: 1.0, name: "oiltank_3", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "water", "coal", "radioactive_liquid", "magic_liquid_teleportation"]}},
		{prob: 1.0, name: "oiltank_4", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "coal", "radioactive_liquid", "magic_liquid_polymorph"]}},
		{prob: 1.0, name: "oiltank_5", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "radioactive_liquid", "coal", "radioactive_liquid"]}}, //*
		{prob: 0.05, name: "oiltank_puzzle"},
	],
	"g_oiltank_alt": [
		{prob: 1.0, name: "oiltank_alt", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "radioactive_liquid", "radioactive_liquid", "magic_liquid_berserk"]}},
	],
	"g_altar": [
		{prob: 1.0, name: "trailer_altar"},
	],
};

export const COALMINE_ALT_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "coalpit01"},
		{prob: 0.5, name: "coalpit02"},
		{prob: 0.5, name: "carthill"},
		{prob: 0.5, name: "coalpit03"},
		{prob: 0.5, name: "coalpit04"},
		{prob: 0.5, name: "coalpit05"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "shrine01_alt", unique: true}, // *** Might be a huge issue
		{prob: 0.5, name: "shrine02_alt"},
		{prob: 0.5, name: "swarm_alt"},
		{prob: 1.2, name: "symbolroom_alt"},
		{prob: 1.2, name: "physics_01_alt"},
		{prob: 1.2, name: "physics_02_alt"},
		{prob: 1.2, name: "physics_03_alt"},
		{prob: 0.75, name: "shop_alt"},
		{prob: 0.5, name: "radioactivecave"},
	],
};

export const EXCAVATIONSITE_SCENES = {
	"g_pixel_scene_01": [],
	"g_pixel_scene_02": [],
	"g_pixel_scene_04": [
		{prob: 0.5, name: "machine_1"},
		{prob: 0.5, name: "machine_2"},
		{prob: 0.5, name: "machine_3b"},
		{prob: 0.5, name: "machine_4"},
		{prob: 0.5, name: "machine_5"},
		{prob: 0.5, name: "machine_6"},
		{prob: 0.3, name: "machine_7"},
		{prob: 3.0, name: "shop"},
		{prob: 0.8, name: "oiltank_1"},
		{prob: 0.8, name: "lake"},
	],
	"g_pixel_scene_04_alt": [
		{prob: 0.5, name: "machine_1_alt"},
		{prob: 0.5, name: "machine_2_alt"},
		{prob: 0.5, name: "machine_3b_alt"},
		{prob: 0.5, name: "machine_4_alt"},
		{prob: 0.5, name: "machine_5_alt"},
		{prob: 0.5, name: "machine_6_alt"},
		{prob: 0.3, name: "machine_7_alt"},
		{prob: 3.0, name: "shop_alt"},
		{prob: 0.7, name: "receptacle_steam"},
		{prob: 0.8, name: "lake_alt"},
	],
	"g_puzzleroom": [
		{prob: 1.5, name: "puzzleroom_01"},
		{prob: 1.5, name: "puzzleroom_02"},
		{prob: 1.5, name: "puzzleroom_03"},
	],
	"g_gunpowderpool_01": [
		{prob: 1.5, name: "gunpowderpool_01"},
	],
	"g_gunpowderpool_02": [
		{prob: 1.5, name: "gunpowderpool_02"},
	],
	"g_gunpowderpool_03": [
		{prob: 1.5, name: "gunpowderpool_03"},
	],
	"g_gunpowderpool_04": [
		{prob: 1.5, name: "gunpowderpool_04"},
	],
	"extras": [
		{name: "meditation_cube_visual"}
	]
};

export const SNOWCAVE_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "verticalobservatory"},
		{prob: 0.5, name: "verticalobservatory2"},
		{prob: 0.5, name: "icebridge2"},
		{prob: 0.5, name: "pipe"},
		{prob: 0.25, name: "receptacle_water"},
	],
	"g_pixel_scene_01_alt": [
		{prob: 0.5, name: "verticalobservatory_alt"},
		{prob: 0.5, name: "verticalobservatory2_alt"},
		{prob: 0.5, name: "icebridge2_alt"},
		{prob: 0.5, name: "pipe_alt"},
	],
	"g_pixel_scene_02": [
		{prob: 0.4, name: "crater"},
		{prob: 0.5, name: "horizontalobservatory"},
		{prob: 0.5, name: "horizontalobservatory2"},
		{prob: 0.3, name: "horizontalobservatory3"},
		{prob: 0.4, name: "icebridge"},
		{prob: 0.4, name: "snowcastle"},
		{prob: 0.0, name: "symbolroom"}, // We were cheated out of greatness.
		{prob: 0.5, name: "icepillar"},
		{prob: 1.5, name: "shop"},
		{prob: 0.5, name: "camp"},
	],
	"g_pixel_scene_03": [
		{prob: 0.9, name: ""},
		{prob: 0.5, name: "tinyobservatory"},
		{prob: 0.5, name: "tinyobservatory2"},
		{prob: 0.2, name: "buried_eye"},
	],
	"g_acidtank_right": [
		{prob: 1.7, name: ""},
		{prob: 0.2, name: "acidtank_2"},
	],
	"g_acidtank_left": [
		{prob: 1.7, name: ""},
		{prob: 0.2, name: "acidtank"},
	],
	"g_pixel_scene_04": [
		{prob: 0.5, name: ""},
		{prob: 0.5, name: "icicles"},
		{prob: 0.5, name: "icicles2"},
		{prob: 0.5, name: "icicles3"},
		{prob: 0.5, name: "icicles4"},
	],
	"g_puzzle_capsule": [
		{prob: 9.0, name: ""},
		{prob: 1.0, name: "puzzle_capsule"},
	],
	"g_puzzle_capsule_b": [
		{prob: 9.0, name: ""},
		{prob: 1.0, name: "puzzle_capsule_b"},
	],
	"g_altar": [
		{prob: 1.0, name: "trailer_altar"},
	],
	"extras": [
		{name: "altar_snowcave_capsule"},
	]
};

export const SNOWCASTLE_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "shaft"},
		{prob: 0.5, name: "bridge"},
		{prob: 0.5, name: "drill"},
		{prob: 0.5, name: "greenhouse"},
	],
	"g_pixel_scene_02": [
		{prob: 0.4, name: "cargobay"},
		{prob: 0.8, name: "bar"},
		{prob: 0.8, name: "bedroom"},
		{prob: 0.4, name: "acidpool"},
		{prob: 0.4, name: "polymorphroom"},
		{prob: 0.2, name: "teleroom"},
		{prob: 0.3, name: "sauna"},
		{prob: 0.3, name: "kitchen"},
	],
	"g_pods_large": [
		{prob: 1.0, name: "pod_large_blank_01"},
		{prob: 1.0, name: "pod_large_01"},
		{prob: 1.0, name: "pod_large_01"},
		{prob: 1.0, name: "pod_large_01"},
	],
	"g_pods_small_l": [
		{prob: 1.0, name: "pod_small_l_blank_01"},
		{prob: 1.0, name: "pod_small_l_01"},
		{prob: 1.0, name: "pod_small_l_01"},
	],
	"g_pods_small_r": [
		{prob: 1.0, name: "pod_small_r_blank_01"},
		{prob: 1.0, name: "pod_small_r_01"},
		{prob: 1.0, name: "pod_small_r_01"},
	],
	"extras": [
		{name: "chamfer_top_r"},
		{name: "chamfer_top_l"},
		{name: "chamfer_bottom_r"},
		{name: "chamfer_bottom_l"},
		{name: "chamfer_inner_top_r"},
		{name: "chamfer_inner_top_l"},
		{name: "chamfer_inner_bottom_r"},
		{name: "chamfer_inner_bottom_l"},
		{name: "pillar_filler_01"},
		{name: "pillar_filler_tall_01"},
		{name: "forge"},
		{name: "altar_snowcastle_capsule"},
	]
};

export const RAINFOREST_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "pit01"},
		{prob: 0.5, name: "pit02"},
		{prob: 0.5, name: "pit03"},
		{prob: 0.8, name: "oiltank_01"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "hut01"},
		{prob: 0.5, name: "hut02"},
		{prob: 0.4, name: "base"},
		{prob: 0.5, name: "hut03"},
		{prob: 1.2, name: "symbolroom"},
	],
	"g_pixel_scene_04": [
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
	],
};

export const RAINFOREST_OPEN_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "pit01"},
		{prob: 0.5, name: "pit02"},
		{prob: 0.5, name: "pit03"},
		{prob: 0.8, name: "oiltank_01"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "hut01"},
		{prob: 0.5, name: "hut02"},
		{prob: 0.4, name: "base"},
		{prob: 0.5, name: "hut03"},
		{prob: 1.2, name: "symbolroom"},
	],
	"g_pixel_scene_04": [
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
		{prob: 0.5, name: "plantlife"},
	],
};

export const RAINFOREST_DARK_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "pit01"},
		{prob: 0.5, name: "pit02"},
		{prob: 0.5, name: "pit03"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "hut03"},
		{prob: 1.2, name: "symbolroom"},
	],
};

const VAULT_LAB_LIQUIDS = {
	"f0bbee": ["radioactive_liquid", "radioactive_liquid", "acid", "acid", "acid", "alcohol"],
	"a4dbd5": ["radioactive_liquid", "radioactive_liquid", "acid", "acid", "acid", "alcohol"], // TODO: Second liquid replacement not yet implemented
}

export const VAULT_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "acidtank"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "lab", color_material: {"f0bbee": ["radioactive_liquid", "radioactive_liquid", "acid", "acid", "acid", "alcohol"]} },
		{prob: 0.5, name: "lab2", color_material: VAULT_LAB_LIQUIDS },
		{prob: 0.5, name: "lab3", color_material: VAULT_LAB_LIQUIDS },
		{prob: 1.2, name: "symbolroom"},
		{prob: 0.3, name: "lab_puzzle"},
	],
	"g_pixel_scene_wide": [
		{prob: 0.5, name: "brain_room"},
		{prob: 0.5, name: "shop"},
	],
	"g_pixel_scene_tall": [
		{prob: 0.5, name: "electric_tunnel_room"},
	],
	"g_pipes_hor": [
		{prob: 0.5, name: "pipe_hor_1"},
		{prob: 0.5, name: "pipe_hor_2"},
		{prob: 0.05, name: "pipe_hor_3"},
	],
	"g_pipes_ver": [
		{prob: 0.5, name: "pipe_ver_1"},
		{prob: 0.5, name: "pipe_ver_2"},
		{prob: 0.05, name: "pipe_ver_3"},
		{prob: 0.1, name: "pipe_ver_4"},
	],
	"g_pipes_turn_right": [
		{prob: 0.5, name: "pipe_turn_right"},
	],
	"g_pipes_turn_left": [
		{prob: 0.5, name: "pipe_turn_left"},
	],
	"g_pipes_cross": [
		{prob: 0.5, name: "pipe_cross"},
	],
	"g_pipes_big_hor": [
		{prob: 0.5, name: "pipe_big_hor_1"},
		{prob: 0.5, name: "pipe_big_hor_2"},
	],
	"g_pipes_big_ver": [
		{prob: 0.5, name: "pipe_big_ver_1"},
		{prob: 0.5, name: "pipe_big_ver_2"},
	],
	"g_pipes_big_turn_right": [
		{prob: 0.5, name: "pipe_big_turn_right"},
	],
	"g_pipes_big_turn_left": [
		{prob: 0.5, name: "pipe_big_turn_left"},
	],
	"g_stains": [
		{prob: 0.5, name: ""},
		{prob: 0.5, name: "stain"},
		{prob: 0.5, name: "stain"},
		{prob: 0.5, name: "stain"},
	],
	"g_stains_ceiling": [
		{prob: 0.5, name: ""},
		{prob: 0.5, name: "stain_ceiling"},
		{prob: 0.5, name: "stain_ceiling"},
	],
	"g_catwalks": [
		{prob: 1.0, name: "catwalk_01"},
		{prob: 0.1, name: "catwalk_02"},
		{prob: 0.1, name: "catwalk_02b"},
		{prob: 0.1, name: "catwalk_03"},
		{prob: 0.1, name: "catwalk_04"},
	],
	"extras": [
		{name: "hole"},
		{name: "altar_vault_capsule"},
	],
};

export const VAULT_FROZEN_SCENES = {
	"g_pipes_hor": [
		{prob: 0.5, name: "pipe_hor_1"},
		{prob: 0.5, name: "pipe_hor_2"},
	],
	"g_pipes_ver": [
		{prob: 0.5, name: "pipe_ver_1"},
		{prob: 0.5, name: "pipe_ver_2"},
	],
	"g_pipes_turn_right": [
		{prob: 0.5, name: "pipe_turn_right"},
	],
	"g_pipes_turn_left": [
		{prob: 0.5, name: "pipe_turn_left"},
	],
	"g_pipes_cross": [
		{prob: 0.5, name: "pipe_cross"},
	],
};

export const CRYPT_SCENES = {
	"g_pixel_scene_01": [
		{prob: 1.0, name: "cathedral"},
		{prob: 1.0, name: "mining"},
		{prob: 1.0, name: "polymorphroom"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "stairs_right"},
	],
	"g_pixel_scene_03": [
		{prob: 1.0, name: "lavaroom"},
		{prob: 1.0, name: "pit"},
		{prob: 1.0, name: "symbolroom"},
		{prob: 1.0, name: "water_lava"},
	],
	"g_pixel_scene_04": [
		{prob: 0.5, name: "stairs_left"},
	],
	"g_pixel_scene_05": [
		{prob: 1.0, name: "room_liquid_funnel"},
		{prob: 1.0, name: "room_gate_drop"},
		{prob: 1.0, name: "shop"},
	],
	"g_pixel_scene_05b": [
		{prob: 1.0, name: "room_liquid_funnel_b"},
		{prob: 1.0, name: "room_gate_drop_b"},
		{prob: 1.0, name: "shop_b"},
	],
	"g_beam": [
		{prob: 1.0, name: "beam_01"},
		{prob: 1.0, name: "beam_02"},
		{prob: 1.0, name: "beam_03"},
		{prob: 1.0, name: "beam_04"},
		{prob: 1.0, name: "beam_05"},
		{prob: 1.0, name: "beam_06"},
		{prob: 1.0, name: "beam_07"},
		{prob: 1.0, name: "beam_08"},
	],
	"g_caveins": [
		{prob: 5.0, name: ""},
		{prob: 1.0, name: "cavein_01"},
		{prob: 1.0, name: "cavein_02"},
		{prob: 1.0, name: "cavein_03"},
		{prob: 1.0, name: "cavein_04"},
	]
};

// I have no idea why I wrote these all out, the pixel scene spawn functions for tower literally just do nothing
export const TOWER_SCENES = {
	/*
	"g_pixel_scene_01": [
		{prob: 0.5, name: "coalpit01"},
		{prob: 0.5, name: "coalpit02"},
		{prob: 0.5, name: "carthill"},
		{prob: 0.5, name: "coalpit03"},
		{prob: 0.5, name: "coalpit04"},
		{prob: 0.5, name: "coalpit05"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "shrine01"},
		{prob: 0.5, name: "shrine02"},
		{prob: 0.5, name: "slimepit"},
		{prob: 0.5, name: "laboratory"},
		{prob: 0.5, name: "swarm"},
		{prob: 0.5, name: "symbolroom"},
		{prob: 1.2, name: "physics_01"},
		{prob: 1.2, name: "physics_02"},
		{prob: 1.2, name: "physics_03"},
		{prob: 0.75, name: "shop"},
		{prob: 0.1, name: "radioactivecave"},
		{prob: 1.5, name: "wandtrap_h_02"},
		{prob: 1.5, name: "wandtrap_h_04", color_material: {"f0bbee": ["oil", "alcohol", "gunpowder_explosive", "oil", "alcohol", "oil", "alcohol"]}},
		{prob: 1.5, name: "wandtrap_h_06", color_material: {"f0bbee": ["magic_liquid_teleportation", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "radioactive_liquid"]}},
		{prob: 1.5, name: "wandtrap_h_07", color_material: {"f0bbee": ["water", "oil", "alcohol", "radioactive_liquid"]}},
	],
	"g_oiltank": [
		{prob: 1.0, name: "oiltank_1", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "coal", "radioactive_liquid"]}},
		{prob: 0.0004, name: "oiltank_1", color_material: {"f0bbee": ["magic_liquid_teleportation", "magic_liquid_polymorph", "magic_liquid_random_polymorph", "magic_liquid_berserk", "magic_liquid_charm", "magic_liquid_invisibility", "magic_liquid_hp_regeneration", "salt", "blood", "gold", "honey"]}},
		{prob: 0.01, name: "oiltank_2", color_material: {"f0bbee": ["blood_fungi", "blood_cold", "lava", "poison", "slime", "gunpowder_explosive", "soil", "salt", "blood", "cement"]}},
		{prob: 1.0, name: "oiltank_2", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "oil", "coal", "radioactive_liquid"]}},
		{prob: 1.0, name: "oiltank_3", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "water", "coal", "radioactive_liquid", "magic_liquid_teleportation"]}},
		{prob: 1.0, name: "oiltank_4", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "coal", "radioactive_liquid", "magic_liquid_polymorph"]}},
		{prob: 1.0, name: "oiltank_5", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "radioactive_liquid", "coal", "radioactive_liquid"]}},
	],
	"g_oiltank_alt": [
		{prob: 1.0, name: "oiltank_alt", color_material: {"f0bbee": ["water", "oil", "water", "oil", "alcohol", "sand", "radioactive_liquid", "radioactive_liquid", "magic_liquid_berserk"]}},
	],
	*/
};

// Unused but still in files...
export const SANDCAVE_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.6, name: "shaft"},
		{prob: 0.4, name: "bridge"},
	],
	"g_pixel_scene_02": [
		{prob: 0.4, name: "cargobay"},
		{prob: 0.4, name: "bar"},
		{prob: 0.4, name: "bedroom"},
	],
};

export const LIQUIDCAVE_SCENES = {
	"g_pixel_scene_01": [
		{prob: 0.5, name: "container_01", color_material: {"f0bbee": ["oil", "alcohol", "lava", "magic_liquid_teleportation", "magic_liquid_protection_all", "material_confusion", "liquid_fire", "magic_liquid_weakness"]}},
	],
};

// These are not used for normal hell spawns but will become relevant in vertical PWs
export const THE_END_SCENES = {
	"g_pixel_scene_01": [
		{prob: 1.0, name: "cathedral"},
		{prob: 1.0, name: "mining"},
	]
};

// The pyramid's interior rooms are the CRYPT's rooms: every magic-pixel scene
// data/scripts/biomes/pyramid.lua loads names a file under
// data/biome_impl/crypt/, not data/biome_impl/pyramid/ (which holds only the
// hand-placed pyramid structure itself, the "extras" below). `dir` says so --
// the scene key stays `pyramid/<name>` because a spawn color's index is
// per-biome, but the PNG is read from data/pixel_scenes/crypt/.
//
// The lists are pyramid.lua's g_pixel_scene_NN verbatim, which is NOT the same
// set as crypt.lua's: no polymorphroom in 01, no water_lava in 03.
export const PYRAMID_SCENES = {
	"g_pixel_scene_01": [
		{prob: 1.0, name: "cathedral", dir: "crypt"},
		{prob: 1.0, name: "mining", dir: "crypt"},
	],
	"g_pixel_scene_02": [
		{prob: 0.5, name: "stairs_right", dir: "crypt"},
	],
	"g_pixel_scene_03": [
		{prob: 1.0, name: "lavaroom", dir: "crypt"},
		{prob: 1.0, name: "pit", dir: "crypt"},
		{prob: 1.0, name: "symbolroom", dir: "crypt"},
	],
	"g_pixel_scene_04": [
		{prob: 0.5, name: "stairs_left", dir: "crypt"},
	],
	"extras": [
		{name: "boss_limbs"},
		{name: "entrance"},
		{name: "hallway"},
		{name: "left"},
		{name: "left_bottom"},
		//{name: "reward"}, // Unused
		{name: "right"},
		{name: "right_bottom"},
		{name: "top"},
	]
};

export const THE_SKY_SCENES = {
	"g_pixel_scene_01": [
		{prob: 1.0, name: "cathedral"},
		{prob: 1.0, name: "mining"},
	],
};

export const GENERAL_SCENES = {
	"extras": [
		{name: "wand_altar"},
		{name: "wand_altar_vault"},
		{name: "potion_altar"},
		{name: "potion_altar_vault"},
		{name: "the_end_shop"}, // Moving this to general to avoid alias issue
		{name: "tower_start"},
		{name: "greed_treasure"},
		{name: "fishing_hut"},
		{name: "bunker"},
		{name: "bunker2"},
		{name: "rainbow_cloud"},
		{name: "eyespot"},
		{name: "huussi"},
		{name: "dragoncave"},
		{name: "funroom"},
		{name: "meatroom"},
		{name: "null_room"},
		{name: "roboroom"},
		{name: "robot_egg"},
		{name: "wizardcave_entrance"},
		{name: "teleportroom"}, // Renamed because of another non-general one with the smae name
		{name: "ocarina"},
		{name: "orbroom"},
		{name: "secret_lab"},
		{name: "essenceroom"},
		{name: "essenceroom_submerged"},
		{name: "alchemist_secret"},
		{name: "alchemist_secret_music"},
		{name: "boss_victoryroom"},
		{name: "cavern"},
		{name: "friendroom"},
		{name: "watercave_layout_1"},
		{name: "watercave_layout_2"},
		{name: "watercave_layout_3"},
		{name: "watercave_layout_4"},
		{name: "watercave_layout_5"},
		{name: "solid_wall_hidden_cavern"},
		{name: "mystery_teleport"},
		{name: "roadblock"},
		{name: "boss_arena_top"},
		{name: "lavalake_racing"},
		{name: "lavalake_pit"},
		{name: "lavalake_pit_cracked"},
		{name: "cauldron"},
		{name: "clean_entrance"},
		{name: "scale"},
		{name: "scale_old"},
	]
}

export const OVERWORLD_SCENES = {
	"extras": [
		{name: "essence_altar"},
		{name: "essence_altar_desert"},
		{name: "snowy_ruins_eye_pillar"},
		{name: "cliff"},
		{name: "desert_ruins_base_01"},
		{name: "music_machine_stand"},
	]
}

export const TEMPLE_SCENES = {
	"extras": [
		{name: "altar"},
		{name: "altar_left"},
		{name: "altar_right"},
		{name: "altar_right_snowcastle"},
		{name: "altar_top"},
		{name: "altar_top_blood"},
		{name: "altar_top_lava"},
		{name: "altar_top_oil"},
		{name: "altar_top_radioactive"},
		{name: "altar_top_water"},
		{name: "altar_top_ending"},
	]
};

// A mountain biome cell paints a SET of scenes, not one: its init(x, y, w, h)
// in data/scripts/biomes/mountain/*.lua issues several LoadPixelScene calls at
// fixed offsets from the cell origin, most of them landing in NEIGHBOURING
// cells -- the hall's own cell is only the top-left quarter of the Holy
// Mountain room. js/static_spawns.js PIXEL_SCENE_BIOMES holds the offsets;
// every name it can ask for has to be loadable, so they are all listed here.
export const MOUNTAIN_SCENES = {
	"extras": [
		{name: "floating_island"},
		{name: "top"},
		{name: "left_entrance"},
		{name: "left_entrance_below"},
		{name: "left_entrance_bottom"},
		{name: "left_stub"},
		{name: "left_stub_edge"},
		{name: "hall"},
		{name: "hall_instructions"},
		{name: "hall_b"},
		{name: "hall_br"},
		{name: "hall_r"},
		{name: "hall_bottom"},
		{name: "hall_bottom_2"},
		{name: "right"},
		{name: "right_bottom"},
		{name: "right_stub"}
	]
};

export const TEMPLE_ALTAR_SCENES = {};
export const FUNGICAVE_SCENES = {};
export const FUNGIFOREST_SCENES = {};
export const WANDCAVE_SCENES = {};
export const WIZARDCAVE_SCENES = {};
export const ROBOBASE_SCENES = {};
export const SNOWCHASM_SCENES = {};
export const CLOUDS_SCENES = {};
export const EXCAVATIONSITE_CUBE_CHAMBER_SCENES = {
	"extras": [
		{name: "cube_chamber"},
	]
};
export const SNOWCAVE_SECRET_CHAMBER_SCENES = {
	"extras": [
		{name: "secret_chamber"},
	]
};
export const SNOWCASTLE_CAVERN_SCENES = {
	"extras": [
		{name: "side_cavern_left"},
		{name: "side_cavern_right"},
	]
};
export const SNOWCASTLE_HOURGLASS_CHAMBER_SCENES = {
	"extras": [
		{name: "hourglass_chamber"},
	]
};
export const BIOME_WATCHTOWER_SCENES = {};
export const BIOME_BARREN_SCENES = {};
export const BIOME_POTION_MIMICS_SCENES = {};
export const BIOME_DARKNESS_SCENES = {};
export const BIOME_BOSS_SKY_SCENES = {};

export const SPLICED_SCENES = {
	"extras": [
		{name: "boss_arena"},
		{name: "gourd_room"},
		{name: "lake_statue"},
		{name: "lavalake_pit_bottom"},
		{name: "lavalake2"},
		{name: "moon"},
		{name: "moon_dark"},
		{name: "mountain_lake"},
		{name: "skull"},
		{name: "skull_in_desert"},
		{name: "tree"},
		{name: "watercave"}
	]
}

export const PIXEL_SCENE_BIOME_MAP = {
	"coalmine": COALMINE_SCENES,
	"coalmine_alt": COALMINE_ALT_SCENES,
	"excavationsite": EXCAVATIONSITE_SCENES,
	"snowcave": SNOWCAVE_SCENES,
	"snowcastle": SNOWCASTLE_SCENES,
	"rainforest": RAINFOREST_SCENES,
	"rainforest_open": RAINFOREST_OPEN_SCENES,
	"rainforest_dark": RAINFOREST_DARK_SCENES,
	"vault": VAULT_SCENES,
	"vault_frozen": VAULT_FROZEN_SCENES,
	"crypt": CRYPT_SCENES,
	"fungicave": FUNGICAVE_SCENES,
	"fungiforest": FUNGIFOREST_SCENES,
	"wandcave": WANDCAVE_SCENES,
	"wizardcave": WIZARDCAVE_SCENES,
	"liquidcave": LIQUIDCAVE_SCENES,
	"robobase": ROBOBASE_SCENES,
	"sandcave": SANDCAVE_SCENES,
	"winter_caves": SNOWCHASM_SCENES,
	"clouds": CLOUDS_SCENES,
	"the_sky": THE_SKY_SCENES,
	"the_end": THE_END_SCENES,
	"temple_altar": TEMPLE_ALTAR_SCENES,
	// (Note that the tower biomes do not have pixel scenes, aside from the general ones like wand/potion pedestals)
	"solid_wall_tower_1": TOWER_SCENES, // Mines
	"solid_wall_tower_2": TOWER_SCENES, // Coal Pits
	"solid_wall_tower_3": TOWER_SCENES, // Snowy Depths
	"solid_wall_tower_4": TOWER_SCENES, // Hiisi Base
	"solid_wall_tower_5": TOWER_SCENES, // Fungal Caverns
	"solid_wall_tower_6": TOWER_SCENES, // Underground Jungle
	"solid_wall_tower_7": TOWER_SCENES, // The Vault
	"solid_wall_tower_8": TOWER_SCENES, // Temple of the Art
	"solid_wall_tower_9": TOWER_SCENES, // Hell
	"excavationsite_cube_chamber": EXCAVATIONSITE_CUBE_CHAMBER_SCENES,
	"snowcave_secret_chamber": SNOWCAVE_SECRET_CHAMBER_SCENES,
	"snowcastle_cavern": SNOWCASTLE_CAVERN_SCENES,
	"snowcastle_hourglass_chamber": SNOWCASTLE_HOURGLASS_CHAMBER_SCENES,
	"pyramid": PYRAMID_SCENES,
	"biome_watchtower": BIOME_WATCHTOWER_SCENES,
	"biome_barren": BIOME_BARREN_SCENES,
	"biome_potion_mimics": BIOME_POTION_MIMICS_SCENES,
	"biome_darkness": BIOME_DARKNESS_SCENES,
	"biome_boss_sky": BIOME_BOSS_SKY_SCENES,
	"overworld": OVERWORLD_SCENES,
	"temple": TEMPLE_SCENES,
	"mountain": MOUNTAIN_SCENES,
	"general": GENERAL_SCENES,
	"spliced": SPLICED_SCENES,
};

/**
 * Where a biome's `load_pixel_sceneN` nudges the magic pixel's position before
 * it rolls, as `[dx, dy]` per scene list.
 *
 * Most of them are the identity -- `load_random_pixel_scene(g_pixel_scene_01,
 * x, y)` -- but a handful in data/scripts/biomes/*.lua are not, and the offset
 * has to be applied at the CALL, not when the chosen scene is stamped: the roll
 * itself is `ProceduralRandom(ws + ng, x, y)` over the shifted position, so a
 * missing offset picks a different room as well as placing it 5 px off.
 *
 * Transcribed from the lua; every `load_random_pixel_scene` call in the game's
 * biome scripts with a non-zero offset, for the biomes telescope models
 * (magic_gate has one and is not modelled; the_end's is on a list it does not
 * carry; pyramid_hallway is not a biome map colour of its own).
 */
export const PIXEL_SCENE_LIST_OFFSETS = {
	"crypt": { g_pixel_scene_02: [6, 0], g_pixel_scene_04: [-5, 0] },
	"pyramid": { g_pixel_scene_02: [6, 0], g_pixel_scene_04: [-5, 0] },
	"liquidcave": { g_pixel_scene_01: [-5, -3] },
};