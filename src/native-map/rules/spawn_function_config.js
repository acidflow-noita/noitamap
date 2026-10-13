// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
export const BLOCK_DEFAULT_SPAWNS = [
	'wandcave',
	'sandcave',
	'winter_caves',
	'clouds',
	'the_sky',
	'the_end',
	'temple_altar',
	'secret_lab',
]

export const COALMINE_SPAWNS = [
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0xB40000, funcName: "spawn_fungi", active: true },
	{color: 0x969678, funcName: "load_structures" },
	{color: 0x967878, funcName: "load_large_structures" },
	{color: 0x967896, funcName: "load_i_structures" },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0xC35700, funcName: "load_oiltank", isPixelScene: true, active: true },
	{color: 0x55AF4B, funcName: "load_altar", isPixelScene: true, active: true },
	{color: 0x23B9C3, funcName: "spawn_altar_torch" },
	{color: 0x55AF8C, funcName: "spawn_skulls" },
	{color: 0x55FF8C, funcName: "spawn_chest", active: true },
	{color: 0x4e175e, funcName: "load_oiltank_alt", isPixelScene: true, active: true },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0x50fafa, funcName: "spawn_trapwand", active: true },
	{color: 0xf12ab5, funcName: "spawn_bbqbox", active: true },
	{color: 0x005cfd, funcName: "spawn_swing_puzzle_box" },
	{color: 0x00b5fc, funcName: "spawn_swing_puzzle_target", active: true },
	{color: 0x93ca00, funcName: "spawn_oiltank_puzzle", active: true },
	{color: 0xb97300, funcName: "spawn_receptacle_oil", active: true },
];

export const COALMINE_ALT_SPAWNS = [
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0xB40000, funcName: "spawn_fungi", active: true },
	{color: 0x969678, funcName: "load_structures" },
	{color: 0x967878, funcName: "load_large_structures" },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
];

export const EXCAVATIONSITE_SPAWNS = [
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0xFF50FF, funcName: "spawn_hanger" },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x00ac6e, funcName: "load_pixel_scene4_alt", isPixelScene: true, active: true },
	{color: 0x0050FF, funcName: "spawn_wheel" },
	{color: 0x0150FF, funcName: "spawn_wheel_small" },
	{color: 0x0250FF, funcName: "spawn_wheel_tiny" },
	{color: 0x2d2eac, funcName: "spawn_rock" },
	{color: 0x0A50FF, funcName: "spawn_physicsstructure" },
	{color: 0xc999ff, funcName: "spawn_hanging_prop" },
	{color: 0x7868ff, funcName: "load_puzzleroom", isPixelScene: true, active: true },
	{color: 0x70d79e, funcName: "load_gunpowderpool_01", isPixelScene: true, active: true },
	{color: 0x70d79f, funcName: "load_gunpowderpool_02", isPixelScene: true, active: true },
	{color: 0x70d7a0, funcName: "load_gunpowderpool_03", isPixelScene: true, active: true },
	{color: 0x70d7a1, funcName: "load_gunpowderpool_04", isPixelScene: true, active: true },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0xb09016, funcName: "spawn_meditation_cube", active: true },
	{color: 0x00855c, funcName: "spawn_receptacle" },
	{color: 0xb1ff99, funcName: "spawn_tower_short" },
	{color: 0x5c8550, funcName: "spawn_tower_tall" },
	{color: 0x227fff, funcName: "spawn_beam_low" },
	{color: 0x8228ff, funcName: "spawn_beam_low_flipped" },
	{color: 0x0098ba, funcName: "spawn_beam_steep" },
	{color: 0x7600a9, funcName: "spawn_beam_steep_flipped" }
];

export const SNOWCAVE_SPAWNS = [
	{color: 0xffeedd, funcName: "init"},
	{color: 0x00AC33, funcName: "load_pixel_scene3", isPixelScene: true, active: true },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x4691c7, funcName: "load_puzzle_capsule", isPixelScene: true, active: true },
	{color: 0x3691d7, funcName: "load_puzzle_capsule_b", isPixelScene: true, active: true },
	{color: 0x55AF4B, funcName: "load_altar", isPixelScene: true, active: true },
	{color: 0x23B9C3, funcName: "spawn_altar_torch" },
	{color: 0x55AF8C, funcName: "spawn_skulls" },
	{color: 0xF516E3, funcName: "spawn_scavenger_party", active: true },
	{color: 0xFFC84E, funcName: "spawn_acid" },
	{color: 0x7285c4, funcName: "load_acidtank_right", isPixelScene: true, active: true },
	{color: 0x9472c4, funcName: "load_acidtank_left", isPixelScene: true, active: true },
	{color: 0x504600, funcName: "spawn_stones" },
	{color: 0xc800ff, funcName: "load_pixel_scene_alt", isPixelScene: true, active: true },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x434040, funcName: "spawn_burning_barrel" },
	{color: 0xb4a00a, funcName: "spawn_fish", active: true },
	{color: 0xaa42ff, funcName: "spawn_electricity_trap" },
	{color: 0x366178, funcName: "spawn_buried_eye_teleporter", active: true },
	{color: 0x876543, funcName: "spawn_statue_hand" },
	{color: 0x00855c, funcName: "spawn_receptacle" }
];

export const SNOWCASTLE_SPAWNS = [
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x01a1fa, funcName: "spawn_turret", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0xc78f20, funcName: "spawn_barricade" },
	{color: 0xc022f5, funcName: "spawn_forcefield_generator" },
	{color: 0xa3d900, funcName: "spawn_brimstone", active: true },
	{color: 0x00d982, funcName: "spawn_vasta_or_vihta", active: true },
	{color: 0x932020, funcName: "spawn_cook", active: true },

	{color: 0x614630, funcName: "load_panel_01" },
	{color: 0x614635, funcName: "load_panel_02" },
	{color: 0x61463e, funcName: "load_panel_03" },
	{color: 0x614638, funcName: "load_panel_04" },
	{color: 0x614646, funcName: "load_panel_07" },
	{color: 0x614650, funcName: "load_panel_08" },
	{color: 0x614658, funcName: "load_panel_09" },

	{color: 0xc133ff, funcName: "load_chamfer_top_r", isPixelScene: true, active: true },
	{color: 0x8b33ff, funcName: "load_chamfer_top_l", isPixelScene: true, active: true },
	{color: 0x8824b3, funcName: "load_chamfer_bottom_r", isPixelScene: true, active: true },
	{color: 0x5f23ad, funcName: "load_chamfer_bottom_l", isPixelScene: true, active: true },
	{color: 0x73ffa7, funcName: "load_chamfer_inner_top_r", isPixelScene: true, active: true },
	{color: 0xd5ff7f, funcName: "load_chamfer_inner_top_l", isPixelScene: true, active: true },
	{color: 0x387d51, funcName: "load_chamfer_inner_bottom_r", isPixelScene: true, active: true },
	{color: 0x97b55b, funcName: "load_chamfer_inner_bottom_l", isPixelScene: true, active: true },

	{color: 0x44609c, funcName: "load_pillar_filler", isPixelScene: true, active: true },
	{color: 0x44449c, funcName: "load_pillar_filler_tall", isPixelScene: true, active: true },

	{color: 0xb03058, funcName: "load_pod_large", isPixelScene: true, active: true },
	{color: 0xb05830, funcName: "load_pod_small_l", isPixelScene: true, active: true },
	{color: 0xb09030, funcName: "load_pod_small_r", isPixelScene: true, active: true },
	{color: 0xffa659, funcName: "load_furniture" },
	{color: 0xfec390, funcName: "load_furniture_bunk" },
	{color: 0x4c63e0, funcName: "spawn_root_grower" },
	{color: 0x4cacab, funcName: "spawn_forge_check" },
	{color: 0x2a78ff, funcName: "spawn_drill_laser" },
];

export const RAINFOREST_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x400000, funcName: "spawn_scavengers", active: true },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x943030, funcName: "spawn_dragonspot", active: true },
	{color: 0x4c63e0, funcName: "spawn_root_grower" },
	{color: 0x806326, funcName: "spawn_tree" }
];

// Same as rainforest
export const RAINFOREST_OPEN_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x400000, funcName: "spawn_scavengers", active: true },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x943030, funcName: "spawn_dragonspot", active: true },
	{color: 0x4c63e0, funcName: "spawn_root_grower" },
	{color: 0x806326, funcName: "spawn_tree" }
];

// Same as rainforest
export const RAINFOREST_DARK_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x400000, funcName: "spawn_scavengers", active: true },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x943030, funcName: "spawn_dragonspot", active: true },
	{color: 0x4c63e0, funcName: "spawn_root_grower" },
	{color: 0x806326, funcName: "spawn_tree" }
];

export const VAULT_SPAWNS = [
	{color: 0x692e94, funcName: "load_pixel_scene_wide", isPixelScene: true, active: true },
	{color: 0x822e5b, funcName: "load_pixel_scene_tall", isPixelScene: true, active: true },

	{color: 0x00AC64, funcName: "load_warning_strip" },
	{color: 0x01a1fa, funcName: "spawn_turret", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x504B64, funcName: "spawn_machines" },
	{color: 0xc999ff, funcName: "spawn_hanging_prop" },
	{color: 0xBE8246, funcName: "spawn_pipes_hor", isPixelScene: true, active: true },
	{color: 0xBE8264, funcName: "spawn_pipes_turn_right", isPixelScene: true, active: true },
	{color: 0xBE8282, funcName: "spawn_pipes_turn_left", isPixelScene: true, active: true },
	{color: 0xBE82A0, funcName: "spawn_pipes_ver", isPixelScene: true, active: true },
	{color: 0xBE82BE, funcName: "spawn_pipes_cross", isPixelScene: true, active: true },
	{color: 0x2E8246, funcName: "spawn_pipes_big_hor", isPixelScene: true, active: true },
	{color: 0x2E8264, funcName: "spawn_pipes_big_turn_right", isPixelScene: true, active: true },
	{color: 0x2E8282, funcName: "spawn_pipes_big_turn_left", isPixelScene: true, active: true },
	{color: 0x2E82A0, funcName: "spawn_pipes_big_ver", isPixelScene: true, active: true },

	{color: 0x5c73da, funcName: "spawn_stains", isPixelScene: true, active: true },
	{color: 0x5c73db, funcName: "spawn_stains_ceiling", isPixelScene: true, active: true },
	{color: 0xc78f20, funcName: "spawn_barricade" },

	{color: 0x4a107d, funcName: "load_pillar" },
	{color: 0x7b59ab, funcName: "load_pillar_base" },
	{color: 0x40ffce, funcName: "load_catwalk", isPixelScene: true, active: true },
	{color: 0xbf4c86, funcName: "spawn_apparatus" },
	{color: 0xaa42ff, funcName: "spawn_electricity_trap" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },

	{color: 0xacf14b, funcName: "spawn_laser_trap", isPixelScene: true, active: true },
	{color: 0xa45aff, funcName: "spawn_lab_puzzle", active: true }
];

export const CRYPT_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x808000, funcName: "spawn_statues" },
	{color: 0x00AC33, funcName: "load_pixel_scene3", isPixelScene: true, active: true },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x97ab00, funcName: "load_pixel_scene5", isPixelScene: true, active: true },
	{color: 0xc9d959, funcName: "load_pixel_scene5b", isPixelScene: true, active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8001A, funcName: "spawn_ghost_crystal", active: true },
	{color: 0x82FF5A, funcName: "spawn_crawlers" },
	{color: 0x647D7D, funcName: "spawn_pressureplates" },
	{color: 0x649B7D, funcName: "spawn_doors" },
	{color: 0xA07864, funcName: "spawn_scavengers", active: true },
	{color: 0xFFCD2A, funcName: "spawn_scorpions", active: true }, 
	{color: 0x2D1E5A, funcName: "spawn_bones" },
	{color: 0x782060, funcName: "load_beam", isPixelScene: true, active: true },
	{color: 0x783060, funcName: "load_background_scene" },
	{color: 0x378ec4, funcName: "load_small_background_scene" },
	{color: 0x786460, funcName: "load_cavein", isPixelScene: true, active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x535988, funcName: "spawn_statue_back" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
];

export const PYRAMID_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x808000, funcName: "spawn_statues" },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8001A, funcName: "spawn_ghost_crystal", active: true },
	{color: 0x82FF5A, funcName: "spawn_crawlers" },
	{color: 0x647D7D, funcName: "spawn_pressureplates" },
	{color: 0x649B7D, funcName: "spawn_doors" },
	{color: 0xA07864, funcName: "spawn_scavengers", active: true },
	{color: 0x00AC33, funcName: "load_pixel_scene3", isPixelScene: true, active: true },
	{color: 0xFFCD2A, funcName: "spawn_scorpions", active: true },
	{color: 0x905ecb, funcName: "spawn_reward_wands" },
	{color: 0x905ecc, funcName: "spawn_boss_limbs_trigger" },
];

export const FUNGICAVE_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x400000, funcName: "spawn_robots", active: true },
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0x30b3b0, funcName: "spawn_physics_fungus" },
];

export const FUNGIFOREST_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0x30b3b0, funcName: "spawn_physics_fungus" },
	{color: 0x30b3f0, funcName: "spawn_physics_acid_fungus" },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x6a8d79, funcName: "spawn_fungitrap" },
];

export const WIZARDCAVE_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x808000, funcName: "spawn_statues" },
	{color: 0x00AC33, funcName: "load_pixel_scene3", isPixelScene: true, active: true },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x97ab00, funcName: "load_pixel_scene5", isPixelScene: true, active: true },
	{color: 0xc9d959, funcName: "load_pixel_scene5b", isPixelScene: true, active: true },
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0x400080, funcName: "spawn_large_enemies", active: true },
	{color: 0xC8001A, funcName: "spawn_ghost_crystal", active: true },
	{color: 0x82FF5A, funcName: "spawn_crawlers" },
	{color: 0x647D7D, funcName: "spawn_pressureplates" },
	{color: 0x649B7D, funcName: "spawn_doors" },
	{color: 0xA07864, funcName: "spawn_scavengers", active: true },
	{color: 0xFFCD2A, funcName: "spawn_scorpions", active: true }, 
	{color: 0x2D1E5A, funcName: "spawn_bones" },
	{color: 0x782060, funcName: "load_beam", isPixelScene: true, active: true },
	{color: 0x783060, funcName: "load_background_scene" },
	{color: 0x378ec4, funcName: "load_small_background_scene" },
	{color: 0x786460, funcName: "load_cavein", isPixelScene: true, active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x535988, funcName: "spawn_statue_back" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
];

export const WANDCAVE_SPAWNS = [
	{color: 0x805000, funcName: "spawn_cloud_trap" },
	{color: 0x397780, funcName: "load_floor_rubble" },
	{color: 0x00ffa0, funcName: "load_floor_rubble_l" },
	{color: 0x1ca7ff, funcName: "load_floor_rubble_r" }
];

export const LIQUIDCAVE_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x00AC64, funcName: "load_background_panel_big" },
	{color: 0x967878, funcName: "spawn_lasergun", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0xc88dab, funcName: "spawn_statues", active: true },
];

export const ROBOBASE_SPAWNS = [
	{color: 0x00AC64, funcName: "load_warning_strip" },
	{color: 0x01a1fa, funcName: "spawn_turret", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0xc999ff, funcName: "spawn_hanging_prop" },
	{color: 0xc78f20, funcName: "spawn_barricade" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0x39a760, funcName: "spawn_lasergate_ver" }
];
export const SANDCAVE_SPAWNS = [
	{color: 0xC8C800, funcName: "spawn_lamp2" },
	{color: 0xDC0060, funcName: "spawn_props4" }
];
export const SNOWCHASM_SPAWNS = [
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0xd0d0b4, funcName: "spawn_treasure", active: true },
	{color: 0x41704d, funcName: "spawn_specialshop", active: true },
	{color: 0x235a15, funcName: "spawn_music_machine", active: true },
	{color: 0xffeedd, funcName: "init" }
];
export const THE_END_SPAWNS = [
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0xbe704d, funcName: "spawn_specialshop", active: true }
];

export const THE_SKY_SPAWNS = [
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0xbe704d, funcName: "spawn_specialshop", active: true }
];

export const MEAT_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x55AF8C, funcName: "spawn_skulls" },
	{color: 0x4c63e1, funcName: "spawn_cyst" },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0xd97f7f, funcName: "spawn_mouth", active: true },
	{color: 0xc999ff, funcName: "spawn_hanging_prop" }
];

export const VAULT_FROZEN_SPAWNS = [
	{color: 0x400000, funcName: "spawn_robots", active: true },
	{color: 0x00AC64, funcName: "load_pixel_scene4", isPixelScene: true, active: true },
	{color: 0x01a1fa, funcName: "spawn_turret", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x504B64, funcName: "spawn_machines" },
	{color: 0xBE8246, funcName: "spawn_pipes_hor", isPixelScene: true, active: true },
	{color: 0xBE8264, funcName: "spawn_pipes_turn_right", isPixelScene: true, active: true },
	{color: 0xBE8282, funcName: "spawn_pipes_turn_left", isPixelScene: true, active: true },
	{color: 0xBE82A0, funcName: "spawn_pipes_ver", isPixelScene: true, active: true },
	{color: 0xBE82BE, funcName: "spawn_pipes_cross", isPixelScene: true, active: true },
	{color: 0xc78f20, funcName: "spawn_barricade" }
];

export const TOWER_SPAWNS = [
	{color: 0x0000ff, funcName: "spawn_nest", active: true },
	{color: 0xB40000, funcName: "spawn_fungi", active: true },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x55AF8C, funcName: "spawn_skulls" },
	{color: 0x55FF8C, funcName: "spawn_chest", active: true },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
];

export const SNOWCASTLE_CAVERN_SPAWNS = [
	{color: 0xC8C800, funcName: "spawn_lamp" },
	{color: 0x80FF5A, funcName: "spawn_vines" },
	{color: 0x33934c, funcName: "spawn_shopitem", active: true },
	{color: 0xffeedd, funcName: "init" },
	{color: 0x03deaf, funcName: "spawn_fish", active: true },
	{color: 0xff2974, funcName: "spawn_hourglass_blood" },
	{color: 0xff9122, funcName: "spawn_hourglass_master" },
	{color: 0x216bff, funcName: "spawn_hourglass_music_trigger" }
];

export const EXCAVATIONSITE_CUBE_CHAMBER_SPAWNS = [
	{color: 0x55AF8C, funcName: "spawn_skulls" },
	{color: 0xffeedd, funcName: "init" },
	{color: 0x366178, funcName: "spawn_teleporter" }
];

export const ROBOT_EGG_SPAWNS = [
	{color: 0xffeedd, funcName: "init" },
	{color: 0x548f77, funcName: "spawn_teleport" },
	{color: 0x709615, funcName: "spawn_chest" }
];

export const TEMPLES_COMMON_SPAWNS = [
	{ color: 0x805000, funcName: "spawn_cloud_trap" },
	{ color: 0x397780, funcName: "load_floor_rubble" },
	{ color: 0x00ffa0, funcName: "load_floor_rubble_l" },
	{ color: 0x1ca7ff, funcName: "load_floor_rubble_r" },
	{ color: 0xffeed1, funcName: "spawn_puzzle_watchtower" },
	{ color: 0xffeeda, funcName: "spawn_puzzle_barren" },
	{ color: 0xffeedb, funcName: "spawn_puzzle_potion_mimics" },
	{ color: 0xffeedc, funcName: "spawn_puzzle_darkness" },
	{ color: 0xffeedd, funcName: "spawn_boss", active: true },
	{ color: 0xffeede, funcName: "spawn_potion_mimic_empty", active: true },
	{ color: 0xffeedf, funcName: "spawn_potion_mimic", active: true },
	{ color: 0xffeed0, funcName: "spawn_fish_many" },
	{ color: 0xffeed2, funcName: "spawn_boss_phase2_marker", active: true },
	{ color: 0xffeed3, funcName: "spawn_book_barren" },
	{ color: 0xffeed4, funcName: "spawn_potion_beer", active: true },
	{ color: 0xffeed5, funcName: "spawn_potion_milk", active: true },
	{ color: 0xffeed6, funcName: "spawn_scorpion", active: true },
	{ color: 0xffaaaa, funcName: "spawn_sign_left" },
	{ color: 0xffaadd, funcName: "spawn_sign_right" }
];

export const WATCHTOWER_SPAWNS = [
	{ color: 0xaaff00, funcName: "spawn_small_enemies2", active: true },
	{ color: 0xffaa00, funcName: "spawn_big_enemies2", active: true }
];

export const CLOUDS_SPAWNS = [];
export const TEMPLE_ALTAR_SPAWNS = [];
export const LAKE_DEEP_SPAWNS = [];

// Assume all active for now
export const DEFAULT_SPAWNS = [
	{color: 0xff0000, funcName: "spawn_small_enemies", active: true },
	{color: 0x800000, funcName: "spawn_big_enemies", active: true },
	{color: 0x00ff00, funcName: "spawn_items", isPixelScene: true, active: true }, // Could occasionally not be a pixel scene...
	{color: 0xc88d1a, funcName: "spawn_props", active: true },
	{color: 0xc88000, funcName: "spawn_props2", active: true },
	{color: 0xc80040, funcName: "spawn_props3", active: true },
	{color: 0xffff00, funcName: "spawn_lamp", active: true },
	{color: 0xff0aff, funcName: "load_pixel_scene", isPixelScene: true, active: true },
	{color: 0xFF0080, funcName: "load_pixel_scene2", isPixelScene: true, active: true },
	{color: 0xFF8000, funcName: "spawn_unique_enemy", active: true },
	{color: 0xc84040, funcName: "spawn_unique_enemy2", active: true },
	{color: 0x804040, funcName: "spawn_unique_enemy3", active: true },
	{color: 0x96C850, funcName: "spawn_ghostlamp", active: true },
	{color: 0x60A064, funcName: "spawn_candles", active: true },
	{color: 0x50a000, funcName: "spawn_potion_altar", isPixelScene: true, active: true },
	{color: 0xbca0f0, funcName: "spawn_potions", active: true },
	{color: 0x00FF5A, funcName: "spawn_apparition", active: true },
	{color: 0x78FFFF, funcName: "spawn_heart", active: true },
	{color: 0x50A0F0, funcName: "spawn_wands", active: true },
	{color: 0xbf26a6, funcName: "spawn_portal", active: true },
	{color: 0x04A977, funcName: "spawn_end_portal", active: true },
	{color: 0xffd171, funcName: "spawn_orb", active: true },
	{color: 0xffd181, funcName: "spawn_perk", active: true },
	{color: 0xffff81, funcName: "spawn_all_perks", active: true },
	{color: 0xc7eb28, funcName: "spawn_wand_trap", active: true },
	{color: 0xE8FF80, funcName: "spawn_wand_trap_ignite", active: true },
	{color: 0x2768DE, funcName: "spawn_wand_trap_electricity_source", active: true },
	{color: 0x2768DF, funcName: "spawn_wand_trap_electricity", active: true },
	{color: 0x6b4f9b, funcName: "spawn_moon", active: true },
	{color: 0xd7b3e8, funcName: "spawn_collapse", active: true }
];

// Concat arrays for biomes, with default spawns first so they can be overridden by biome-specific ones if needed
export const BIOME_SPAWN_FUNCTION_MAP = {
	"general": [...DEFAULT_SPAWNS], // Not a real biome, just for things that can spawn anywhere
	"coalmine": [...DEFAULT_SPAWNS, ...COALMINE_SPAWNS],
	"coalmine_alt": [...DEFAULT_SPAWNS, ...COALMINE_ALT_SPAWNS],
	"excavationsite": [...DEFAULT_SPAWNS, ...EXCAVATIONSITE_SPAWNS],
	"snowcave": [...DEFAULT_SPAWNS, ...SNOWCAVE_SPAWNS],
	"snowcastle": [...DEFAULT_SPAWNS, ...SNOWCASTLE_SPAWNS],
	"rainforest": [...DEFAULT_SPAWNS, ...RAINFOREST_SPAWNS],
	"rainforest_open": [...DEFAULT_SPAWNS, ...RAINFOREST_OPEN_SPAWNS],
	"rainforest_dark": [...DEFAULT_SPAWNS, ...RAINFOREST_DARK_SPAWNS],
	"vault": [...DEFAULT_SPAWNS, ...VAULT_SPAWNS],
	"vault_frozen": [...DEFAULT_SPAWNS, ...VAULT_FROZEN_SPAWNS],
	"crypt": [...DEFAULT_SPAWNS, ...CRYPT_SPAWNS],
	"pyramid": [...DEFAULT_SPAWNS, ...PYRAMID_SPAWNS],
	"fungicave": [...DEFAULT_SPAWNS, ...FUNGICAVE_SPAWNS],
	"fungiforest": [...DEFAULT_SPAWNS, ...FUNGIFOREST_SPAWNS],
	"wandcave": [...DEFAULT_SPAWNS, ...WANDCAVE_SPAWNS],
	"wizardcave": [...DEFAULT_SPAWNS, ...WIZARDCAVE_SPAWNS],
	"liquidcave": [...DEFAULT_SPAWNS, ...LIQUIDCAVE_SPAWNS],
	"robobase": [...DEFAULT_SPAWNS, ...ROBOBASE_SPAWNS],
	"sandcave": [...DEFAULT_SPAWNS, ...SANDCAVE_SPAWNS],
	"winter_caves": [...DEFAULT_SPAWNS, ...SNOWCHASM_SPAWNS], // Snowy Chasm
	"clouds": [...DEFAULT_SPAWNS, ...CLOUDS_SPAWNS],
	"the_sky": [...DEFAULT_SPAWNS, ...THE_SKY_SPAWNS],
	"the_end": [...DEFAULT_SPAWNS, ...THE_END_SPAWNS],
	"temple_altar": [...DEFAULT_SPAWNS, ...TEMPLE_ALTAR_SPAWNS],
	"meat": [...DEFAULT_SPAWNS, ...MEAT_SPAWNS],
	"lake_deep": [...DEFAULT_SPAWNS, ...LAKE_DEEP_SPAWNS],
	"solid_wall_tower_1": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Mines
	"solid_wall_tower_2": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Coal Pits
	"solid_wall_tower_3": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Snowy Depths
	"solid_wall_tower_4": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Hiisi Base
	"solid_wall_tower_5": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Fungal Caverns
	"solid_wall_tower_6": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Underground Jungle
	"solid_wall_tower_7": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // The Vault
	"solid_wall_tower_8": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Temple of the Art
	"solid_wall_tower_9": [...DEFAULT_SPAWNS, ...TOWER_SPAWNS], // Hell
	"snowcastle_cavern": [...DEFAULT_SPAWNS, ...SNOWCASTLE_CAVERN_SPAWNS],
	"excavationsite_cube_chamber": [...DEFAULT_SPAWNS, ...EXCAVATIONSITE_CUBE_CHAMBER_SPAWNS],
	"robot_egg": [...DEFAULT_SPAWNS, ...ROBOT_EGG_SPAWNS],
	"biome_watchtower": [...DEFAULT_SPAWNS, ...TEMPLES_COMMON_SPAWNS, ...WATCHTOWER_SPAWNS],
	"biome_barren": [...DEFAULT_SPAWNS, ...TEMPLES_COMMON_SPAWNS],
	"biome_potion_mimics": [...DEFAULT_SPAWNS, ...TEMPLES_COMMON_SPAWNS],
	"biome_darkness": [...DEFAULT_SPAWNS, ...TEMPLES_COMMON_SPAWNS],
	"biome_boss_sky": [...DEFAULT_SPAWNS, ...TEMPLES_COMMON_SPAWNS],
};