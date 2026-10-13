// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
import { HOLY_MOUNTAIN_BASIN_COLORS, SCENE_ONLY_COLORS } from "./generator_config.js";
import { NollaPrng } from "./nolla_prng.js";
import { loadPixelScene } from "./pixel_scene_generation.js";
import { getWorldCenter, getWorldSize } from "./utils.js";
import { getStartingLoadout, getTinyDrops } from "./misc_generation.js";
import { appSettings } from "./settings.js";
import { generateWand } from "./wand_generation.js";

export const STATIC_PIXEL_SCENES = [
	{name: "pyramid/boss_limbs", x: 9726, y: -1024, required: true},
	{name: "snowcastle/altar_snowcastle_capsule", x: 143, y: 5112, required: true},
	{name: "snowcastle/forge", x: 1464, y: 5976},
	{name: "vault/altar_vault_capsule", x: 143, y: 8704, required: true},
	{name: "snowcave/altar_snowcave_capsule", x: 127, y: 3072, required: true},
	{name: "general/tower_start", x: 9676, y: 9086, required: true},
	{name: "general/the_end_shop", x: 0, y: 24576, required: true},
	{name: "general/the_end_shop", x: 0, y: -13954, required: true},
	{name: "general/greed_treasure", x: 9216, y: 4096},
	{name: "general/fishing_hut", x: -12600, y: 140},
	{name: "overworld/essence_altar", x: -6948, y: -270, inNGP: true},
	{name: "overworld/essence_altar_desert", x: 12519, y: -30, inNGP: true},
	{name: "overworld/essence_altar", x: -43300, y: -270},
	{name: "overworld/essence_altar_desert", x: -23833, y: -30},
	{name: "overworld/essence_altar", x: 29404, y: -270},
	{name: "overworld/essence_altar_desert", x: 48871, y: -30},
	{name: "general/bunker", x: -12603, y: 326},
	{name: "general/bunker2", x: -12953, y: 540},
	{name: "overworld/snowy_ruins_eye_pillar", x: -2446, y: -223},
	{name: "general/rainbow_cloud", x: -14059, y: -2851},
	{name: "overworld/cliff", x: -12400, y: -400},
	{name: "general/eyespot", x: -3408, y: 1712, required: true}, 
	{name: "general/eyespot", x: 5852, y: -4944}, // This one is in the art
	{name: "general/eyespot", x: 15024, y: 1712, required: true},
	{name: "general/eyespot", x: -1360, y: 9904, required: true},
	{name: "general/eyespot", x: 12976, y: 9904, required: true},
	{name: "overworld/desert_ruins_base_01", x: 5890, y: 0},
	{name: "overworld/music_machine_stand", x: 14650, y: -34},
	{name: "overworld/music_machine_stand", x: -1953, y: -1360},
	{name: "general/huussi", x: 9000, y: -1900},
	// `required` because the chunk this sits in is solid wall: the scene IS the
	// room, so dropping it leaves no room at all -- and since the room's
	// hand-drawn tile moved onto the scene (53d7013) dropping the scene drops
	// the art with it, where the old hardcoded blit drew it either way.
	{name: "general/cauldron", x: 7*512, y: 10*512, required: true},
	// entities...
];

export const STATIC_PIXEL_SCENES_NIGHTMARE = [
	{name: "pyramid/boss_limbs", x: 9726, y: -1024, required: true},
	{name: "general/clean_entrance", x: 128, y: 1535, required: true},
	{name: "general/clean_entrance", x: 128, y: 4095, required: true},
	{name: "general/clean_entrance", x: 128, y: 6655, required: true},
	{name: "general/clean_entrance", x: 128, y: 10751, required: true},
	{name: "snowcastle/altar_snowcastle_capsule", x: 143, y: 5112, required: true},
	{name: "vault/altar_vault_capsule", x: 143, y: 8704, required: true},
	{name: "snowcave/altar_snowcave_capsule", x: 127, y: 3072, required: true},
];

// Using 'required' for ones which look bad if they're missing
// I think all of these are replaced by the art overlay at this point
export const PIXEL_SCENE_BIOMES = {
	// Biome color: scene name
	0xff24888a: {biome: "excavationsite_cube_chamber", name: "cube_chamber"},
	0xff18a0d6: {biome: "snowcave_secret_chamber", name: "secret_chamber"},
	0xff18d6d6: {biome: "snowcastle_hourglass_chamber", name: "hourglass_chamber"},
	0xff364d24: {biome: "dragoncave", name: "dragoncave"},
	0xff9e4302: {biome: "robot_egg", name: "robot_egg"},
	0xffbaa345: {biome: "secret_lab", name: "secret_lab"},
	0xff804169: {biome: "wizardcave_entrance", name: "wizardcave_entrance"},
	0xff5f8fab: {biome: "teleroom", name: "teleportroom"}, // Renamed because I was having issues with another scene named the same way
	0xff157cb7: {biome: "mystery_teleport", name: "mystery_teleport"},
	0xff57cace: {biome: "ocarina", name: "ocarina"},
	0xff157cb0: {biome: "essenceroom", name: "essenceroom"},
	0xff157cb5: {biome: "essenceroom_hell", name: "essenceroom"},
	0xff157cb6: {biome: "essenceroom_alc", name: "essenceroom_submerged"},
	0xff157cb8: {biome: "essenceroom_air", name: "essenceroom"},
	0xffffd100: {biome: "orbroom_00", name: "orbroom"},
	0xffffd101: {biome: "orbroom_01", name: "orbroom"},
	0xffffd102: {biome: "orbroom_02", name: "orbroom"},
	0xffffd103: {biome: "orbroom_03", name: "orbroom"},
	0xffffd104: {biome: "orbroom_04", name: "orbroom"},
	0xffffd105: {biome: "orbroom_05", name: "orbroom"},
	0xffffd106: {biome: "orbroom_06", name: "orbroom"},
	0xffffd107: {biome: "orbroom_07", name: "orbroom"},
	0xffffd108: {biome: "orbroom_08", name: "orbroom"},
	0xffffd109: {biome: "orbroom_09", name: "orbroom"},
	0xffffd110: {biome: "orbroom_10", name: "orbroom"},
	0xffffd111: {biome: "orbroom_11", name: "orbroom"},
	0xff1f3b62: {biome: "mestari_secret", name: "secret_lab"},
	0xff1f3b64: {biome: "ghost_secret", name: "secret_lab"},
	0xff57dace: {biome: "alchemist_secret", name: "alchemist_secret"},
	0xff0a95a4: {biome: "funroom", name: "funroom"},
	0xff567cb0: {biome: "moon_room", name: "essenceroom"},
	0xff326655: {biome: "rock_room", name: "essenceroom"},
	0xffe17e32: {biome: "null_room", name: "null_room"},
	0xff39a760: {biome: "gun_room", name: "essenceroom"},
	0xff9d893d: {biome: "roboroom", name: "roboroom"},
	0xff796620: {biome: "meatroom", name: "meatroom"},
	0xffeba500: {biome: "scale", name: "scale", offsetX: 100, offsetY: 382}, 
	0xff9d99d1: {biome: "song_room", name: "alchemist_secret_music"},
	0xff968f5f: {biome: "pyramid_left", name: "left"},
	0xff968f96: {biome: "pyramid_right", name: "right"},
	0xffc88f5f: {biome: "pyramid_top", name: "top"},
	0xff967f5f: {biome: "pyramid_entrance", name: "entrance"},
	0xff167f5f: {biome: "pyramid_hallway", name: "hallway"},
	0xfff0d517: {biome: "roadblock", name: "roadblock"}, // TODO: I forgot what this was
	0xff93cb5a: {biome: "temple_altar_right_snowcastle", name: "altar_right_snowcastle", offsetY: 256},
	0xff93cb4f: {biome: "temple_altar_right_snowcave", name: "altar_right_snowcastle", offsetY: 256},
	0xff93cb4e: {biome: "temple_altar_right", name: "altar_right", offsetY: 256},
	0xff93cb4d: {biome: "temple_altar_left", name: "altar_left", offsetY: 256},
	0xff93cb4c: {biome: "temple_altar", name: "altar", offsetY: 256},
	// The mountain cells each paint a SET of scenes. Their init(x, y, w, h) in
	// data/scripts/biomes/mountain/*.lua is a straight run of LoadPixelScene
	// calls at fixed offsets from the cell origin, and most of them land in a
	// NEIGHBOURING cell -- the hall's own cell is just the top-left quarter of
	// the Holy Mountain room, and the four other quarters plus the two floor
	// slabs are painted from it. Offsets below are the lua's literals; every
	// one is confirmed against data/dumps/pixel_scenes.ndjson.gz (live capture,
	// seed 786433191), where the hall cell at (512, -512) yields hall and
	// hall_instructions at (512,-512), hall_b (512,0), hall_r (1024,-512),
	// hall_br (1024,0), hall_bottom (0,0) and hall_bottom_2 (1064,0).
	0xffC08082: {biome: "mountain_floating_island", name: "floating_island"},
	0xffC08080: {biome: "mountain_top", name: "top"},
	// mountain_right_stub.lua:9 -- the only mountain scene drawn off-grid.
	0xffE08080: {biome: "mountain_right_stub", name: "right_stub", offsetX: -38},
	// mountain_right.lua:9-10
	0xff408080: {biome: "mountain_right", scenes: [
		{name: "right_bottom", dx: 512 - 192, dy: 512},
		{name: "right"},
	]},
	// mountain_hall.lua:108-120
	0xff204060: {biome: "mountain_hall", scenes: [
		{name: "hall"},
		{name: "hall_instructions"},
		{name: "hall_b", dy: 512},
		{name: "hall_br", dx: 512, dy: 512},
		{name: "hall_r", dx: 512},
		{name: "hall_bottom", dx: -512, dy: 512},
		{name: "hall_bottom_2", dx: 552, dy: 512},
	]},
	// mountain_left_entrance.lua:206-213
	0xff208080: {biome: "mountain_left_entrance", scenes: [
		{name: "left_entrance_bottom", dy: 512},
		{name: "left_stub_edge", dy: 512},
		{name: "left_entrance"},
	]},
	// mountain_left_stub.lua:11-12
	0xff608080: {biome: "mountain_left_stub", scenes: [
		{name: "left_stub"},
		{name: "left_entrance_below", dx: 512},
	]},
	0xff50eed7: {biome: "boss_victoryroom", name: "boss_victoryroom"},
	0xff0da899: {biome: "boss_arena_top", name: "boss_arena_top"},
	0xff3d3e41: {biome: "solid_wall_tower_10", name: "essenceroom"},
	0xff4118d6: {biome: "lavalake_racing", name: "lavalake_racing"},
	// data/scripts/biomes/lavalake_pit.lua stamps every one of the four map cells
	// (3584, 1024/1536/2048/2560) and picks the variant from the cell's absolute y:
	// `if y > 2000 and y < 2400 then lavalake_pit_cracked else lavalake_pit`.
	// Two of the four used to be hardcoded in STATIC_PIXEL_SCENES, which left the
	// upper two cells bare.
	0xff3d5a4f: {biome: "lavalake_pit", name: "lavalake_pit",
		nameAtCell: (x, y) => (y > 2000 && y < 2400) ? "lavalake_pit_cracked" : "lavalake_pit"},

}

// Variable pixel scenes
/*
	0xff775ddb: {biome: "snowcastle_cavern", name: "side_cavern_left/right"},

	0xff42244d: {biome: "solid_wall_hidden_cavern", name: "solid_wall_hidden_cavern"}, // or nothing

	0xff3046c1: {biome: "watercave", name: "watercave_1-5"},

	0xff6db55a: {biome: "friend_1", name: "friendroom"},
	0xff6db55b: {biome: "friend_2", name: "friendroom"},
	0xff6db55c: {biome: "friend_3", name: "friendroom"},
	0xff6db55d: {biome: "friend_4", name: "friendroom"},
	0xff6db55e: {biome: "friend_5", name: "friendroom"},
	0xff6db55f: {biome: "friend_6", name: "friendroom"}, // cavern
*/

// I really don't care about this but whatever
// TODO: Skip cosmetic not used here but removes most things
export function addStaticPixelScenes(ws, ng, pwIndex, pwIndexVertical, biomeData, skipCosmeticPixelScenes=false, perks={}, isDaily=false, gameMode='normal') {
	//const t0 = performance.now();

	const isNightmare = (gameMode === 'nightmare');

	//const pixelSceneOption = document.getElementById('enable-static-pixel-scenes').value;
	const pixelSceneOption = appSettings.enableStaticPixelScenes;
	// TODO: Currently this makes the static PoIs also get skipped, which I don't really want...
	//if (pixelSceneOption === 'off') return [];
	let newPixelScenes = [];
	let newPois = [];
	const mapWidth = getWorldSize(ng > 0, gameMode);
	const pwOffsetX = pwIndex * mapWidth * 512;
	//const pwOffsetY = pwIndexVertical * 48 * 512;
	// Hardcoded position pixel scenes
	if (pixelSceneOption !== 'off') {
		const staticScenesToUse = isNightmare ? STATIC_PIXEL_SCENES_NIGHTMARE : STATIC_PIXEL_SCENES;
		for (const scene of staticScenesToUse) {
			if (!scene.inNGP && ng > 0) continue;
			if (pixelSceneOption === 'some' && !scene.required) continue;
			// Check PW position
			const targetPW = Math.floor((scene.x + 512 * getWorldCenter(ng > 0, gameMode))/(512*mapWidth));
			const targetPWVertical = Math.floor((scene.y + 512 * 14)/(512*48));
			if (targetPW !== pwIndex || targetPWVertical !== pwIndexVertical) continue;
			const biomeFolder = scene.name.split('/')[0];
			const sceneName = scene.name.split('/')[1];
			const pixelScene = loadPixelScene(biomeData, biomeFolder, sceneName, ws, ng, scene.x, scene.y, skipCosmeticPixelScenes, false, gameMode);
			if (pixelScene) {
				newPixelScenes.push(pixelScene);
			}
		}
		// Chunk based pixel scenes (none of these are in vertical PWs, at least not in NG... Though NG+3 does have the infinite orb room tower, TODO)
		if (pwIndexVertical === 0) {
			for (let x = 0; x < mapWidth; x++) {
				for (let y = 0; y < 48; y++) {
					const biomeColor = biomeData.pixels[y * mapWidth + x];
					// A `sceneOnly` room paints no terrain of its own, so its scene
					// is not decoration -- it is the entire contents of the chunk,
					// and without it the room reads as a hole in the world. Those
					// count as 'required' the way STATIC_PIXEL_SCENES' flagged
					// entries do; everything else still waits for 'all'.
					if (pixelSceneOption !== 'all' && !SCENE_ONLY_COLORS.has(biomeColor & 0xffffff)) continue;
					if (PIXEL_SCENE_BIOMES[biomeColor]) {
						const biomePixelSceneInfo = PIXEL_SCENE_BIOMES[biomeColor];
						const biomeName = biomePixelSceneInfo.biome;
						const offsetX = biomePixelSceneInfo.offsetX || 0;
						const offsetY = biomePixelSceneInfo.offsetY || 0;
						// The cell's world origin, which is exactly the (x, y) the
						// game hands the biome's init(x, y, w, h).
						const cellX = x * 512 - mapWidth * 256 + pwIndex * mapWidth * 512;
						const cellY = y * 512 - 14*512 + pwIndexVertical * 48 * 512;
						// A biome's init() may issue several LoadPixelScene calls at
						// fixed offsets from that origin, so an entry carries either
						// one scene or a `scenes` list, in the lua's call order.
						const sceneList = biomePixelSceneInfo.scenes ?? [{
							// A room whose scene depends on where the cell sits picks
							// per cell rather than per biome.
							name: biomePixelSceneInfo.nameAtCell
								? biomePixelSceneInfo.nameAtCell(cellX + offsetX, cellY + offsetY)
								: biomePixelSceneInfo.name,
						}];
						for (const part of sceneList) {
							const adjX = cellX + offsetX + (part.dx || 0);
							const adjY = cellY + offsetY + (part.dy || 0);
							const pixelScene = loadPixelScene(biomeData, biomeName, part.name, ws, ng, adjX, adjY, skipCosmeticPixelScenes, false, gameMode);
							if (pixelScene) {
								newPixelScenes.push(pixelScene);
							}
						}
					}
				}
			}
		}
	}

	// Something small: Scale based on unlocks?
	// Meh not too important, I'll just use the fully unlocked version
	// TODO But not a priority for me since the custom art is preferable anyway

	let hiisiHourglassPosition = null;

	// Special biomes (randomized)
	const prng = new NollaPrng(0);
	if (ng === 0 && pwIndexVertical === 0 && !isNightmare) {
		// Hiisi hourglass shop
		const is_right = prng.ProceduralRandom(ws, 0, 0) > 0.5;
		if (is_right) {
			hiisiHourglassPosition = 'right';
			if (pixelSceneOption === 'all') {
				const pixelScene = loadPixelScene(biomeData, "snowcastle_cavern", "side_cavern_right", ws, ng, 3*512 - 50, 10*512, skipCosmeticPixelScenes, false, gameMode);
				if (pixelScene) {
					newPixelScenes.push(pixelScene);
				}
			}
		}
		else {
			hiisiHourglassPosition = 'left';
			if (pixelSceneOption === 'all') {
				const pixelScene = loadPixelScene(biomeData, "snowcastle_cavern", "side_cavern_left", ws, ng, -5*512 + 50, 10*512, skipCosmeticPixelScenes, false, gameMode);
				if (pixelScene) {
					newPixelScenes.push(pixelScene);
				}
			}
		}

		// Friend rooms TODO: Forgetting about PWs?
		const friendRoomPositions = [
			{x: 6*512 + pwOffsetX, y: 11*512},
			{x: 8*512 + pwOffsetX, y: 19*512},
			{x: -10*512 + pwOffsetX, y: 9*512},
			{x: -21*512 + pwOffsetX, y: 8*512},
			{x: -22*512 + pwOffsetX, y: 22*512},
			{x: -10*512 + pwOffsetX, y: 25*512},
		];

		prng.SetRandomSeed(ws, 24, 32);
		const friendRoom = prng.Random(1, 6);
		for (let i = 1; i <= 6; i++) {
			// Note "cavern" is the one with the friends, and "friendroom" is the empty one, who decided this
			const pixelScene = loadPixelScene(biomeData, `friend_${i}`, i === friendRoom ? 'cavern' : 'friendroom', ws, ng, friendRoomPositions[i-1].x, friendRoomPositions[i-1].y, skipCosmeticPixelScenes, false, gameMode);
			if (pixelScene) {
				newPixelScenes.push(pixelScene);
			}
			if (i === friendRoom) {
				// Gourd
				newPois.push({type: 'item', item: 'gourd', x: friendRoomPositions[i-1].x + 256, y: friendRoomPositions[i-1].y + 350, biome: `friend_${i}`});
			}
		}

		// Hidden gold stash
		const stashLocations = [
			{x: -6*512 + pwOffsetX, y: 0},
			{x: -6*512 + pwOffsetX, y: 16*512},
			{x: 5*512 + pwOffsetX, y: 17*512},
			{x: -8*512 + pwOffsetX, y: 22*512},
		];
		const location = Math.floor(prng.ProceduralRandom(ws, 1240, -750)*4);
		const pixelScene = loadPixelScene(biomeData, "solid_wall_hidden_cavern", "solid_wall_hidden_cavern", ws, ng, stashLocations[location].x-30, stashLocations[location].y, skipCosmeticPixelScenes, false, gameMode);
		if (pixelScene) {
			newPixelScenes.push(pixelScene);
		}

		if (pwIndex === 0) {
			// Watercave
			const layout = 1 + Math.floor(prng.ProceduralRandom(ws, -2048, 515)*5);
			const waterCaveScene = loadPixelScene(biomeData, "watercave", `watercave_layout_${layout}`, ws, ng, -2048, 515, skipCosmeticPixelScenes, false, gameMode);
			if (waterCaveScene) {
				newPixelScenes.push(waterCaveScene);
			}
			// Add watercave PoIs based on layout
			const waterCavePois = {
				1: [{type: 'item', item: 'heart', x: -2048 + 184, y: 515 + 96, biome: 'watercave'}, {type: 'item', item: 'full_heal', x: -2048 + 142, y: 515 + 386, biome: 'watercave'}],
				2: [{type: 'item', item: 'heart', x: -2048 + 340, y: 515 + 329, biome: 'watercave'}, {type: 'item', item: 'full_heal', x: -2048 + 142, y: 515 + 386, biome: 'watercave'}],
				3: [{type: 'item', item: 'heart', x: -2048 + 144, y: 515 + 385, biome: 'watercave'}, {type: 'item', item: 'full_heal', x: -2048 + 182, y: 515 + 96, biome: 'watercave'}],
				4: [{type: 'item', item: 'heart', x: -2048 + 170, y: 515 + 384, biome: 'watercave'}, {type: 'item', item: 'full_heal', x: -2048 + 182, y: 515 + 96, biome: 'watercave'}],
				5: [{type: 'item', item: 'heart', x: -2048 + 184, y: 515 + 96, biome: 'watercave'}, {type: 'item', item: 'full_heal', x: -2048 + 142, y: 515 + 386, biome: 'watercave'}],
			};
			newPois.push(...waterCavePois[layout]);
		}
	}

	// Holy mountain basins (nightmare makes me think I should automate this better based on the biome map but eh)
	const holyMountainDepths = {'ng': [2, 5, 9, 12, 16, 20, 25], 'ngplus': [2, 5, 12, 20, 25], 'nightmare': [2, 7, 12, 20, 25]};
	const holyMountainStarts = {'ng': [-3, -4, -5, -4, -5, -6, -6], 'ngplus': [-4, -4, -4, -4, -6], 'nightmare': [-7, -7, -7, -7, -6]};
	const holyMountainWidths = {'ng': [7, 8, 10, 7, 9, 11, 9], 'ngplus': [7, 7, 7, 9, 9], 'nightmare': [14, 14, 13, 14, 9]};
	
	const ngpkey = ng === 0 ? (isNightmare ? 'nightmare' : 'ng') : 'ngplus';
	if (pwIndexVertical === 0) {
		for (let i = 0; i < holyMountainDepths[ngpkey].length; i++) {
			const depth = holyMountainDepths[ngpkey][i];
			const width = holyMountainWidths[ngpkey][i];
			const start = holyMountainStarts[ngpkey][i];
			for (let j = 0; j < width; j++) {
				// Check whether chunk is correct first
				const idx = ((depth + 14) * mapWidth) + start + j + mapWidth/2;
				const biomeColor = biomeData.pixels[idx] & 0xffffff;
				// Skip any chunk that is not holy mountain (HM chunks can get overwritten in NG+ and nightmare)
				if (!HOLY_MOUNTAIN_BASIN_COLORS.has(biomeColor)) continue;
				const basin = {x: 512 * (start + j) + pwIndex*mapWidth*512, y: 512 * depth};
				let material = '';
				if (basin.y > 12000) material = '_ending'; // boss_arena... is this the same?
				else {
					prng.SetRandomSeed(ws + ng, basin.x, basin.y);
					const randomTop = prng.Random(1, 50);
					if (randomTop === 5) material = '_water';
					else if (randomTop === 8) material = '_blood';
					else if (randomTop === 11) material = '_oil';
					else if (randomTop === 13) material = '_radioactive';
					else if (randomTop === 15) material = '_lava';
				}
				const pixelScene = loadPixelScene(biomeData, 'temple', `altar_top${material}`, ws, ng, basin.x, basin.y-40, skipCosmeticPixelScenes, false, gameMode);
				if (pixelScene) {
					newPixelScenes.push(pixelScene);
				}
			}
		}
	}

	// Static spliced pixel scenes (ew)
	// Just set biome as "spliced" and don't deal with this bs
	if (pixelSceneOption !== 'off') {
		const splicedScenes = [
			{name: "boss_arena", required: true, x: 3*512, y: 24*512, inNGP: true, inNightmare: true},
			{name: "gourd_room", required: true, x: -33*512, y: -14*512, inNGP: true},
			{name: "lake_statue", x: -29*512, y: 0, inNGP: true, inNightmare: true},
			{name: "lavalake_pit_bottom", x: 5*512, y: 6*512}, // TODO: Says this is in nightmare but it doesn't appear to be?
			{name: "lavalake2", required: true, x: 4*512, y: 0},
			{name: "moon", x: 0, y: -51*512, inNGP: true, required: true, inNightmare: true},
			{name: "moon_dark", x: 0, y: 73*512 + 136, inNGP: true, required: true},
			{name: "mountain_lake", x: 5*512, y: 0, inNightmare: true}, // TODO: Top of this changes in NG vs NGP, also it's flat and missing in PWs...
			{name: "skull", x: 29*512, y: 31*512 + 256}, // TODO: Looks weird with the default color
			{name: "skull_in_desert", x: 14*512 - 68, y: -100, inNGP: true, inNightmare: true},
			{name: "tree", x: -4*512, y: -3*512 + 212, inNGP: true, inNightmare: true},
			{name: "watercave", x: -4*512, y: 0, required: true}, // Just the top and bottom edges of the watercave
		];

		for (const splicedScene of splicedScenes) {
			if (splicedScene.name === 'moon' && appSettings.sunState) continue; // Skip moon if sun is enabled
			if (splicedScene.name === 'moon_dark' && appSettings.darksunState) continue; // Skip moon_dark if darksun is enabled
			if (!splicedScene.inNGP && ng > 0) continue;
			if (!splicedScene.inNightmare && isNightmare) continue;
			if (pixelSceneOption === 'some' && !splicedScene.required) continue;
			const pixelScene = loadPixelScene(biomeData, "spliced", splicedScene.name, ws, ng, splicedScene.x, splicedScene.y, skipCosmeticPixelScenes, false, gameMode);
			if (pixelScene) {
				newPixelScenes.push(pixelScene);
			}
		}
	}

	// Static PoIs (still only in NG main)
	if (ng === 0 && pwIndex === 0 && pwIndexVertical === 0 && !isNightmare) {
		// Eye
		newPois.push({type: 'item', item: 'paha_silma', x: -2434, y: -204, biome: 'winter'});
		// Rainbow cloud
		newPois.push({type: 'item', item: 'spell', spell: 'RAINBOW_TRAIL', x: -14001, y: -2851, biome: 'lake'});
		// Experimental wands?
		// Unfortunately, it looks like all the experimental wands and tower wands are generated based on frame count, so I can't predict exact values.
		// {name: "general/bunker", x: -12603, y: 326},
		// -12603 + 95, 326 + 83
		newPois.push({type: 'puzzle', materials: 'tablet', items: [
			generateExperimentalWand2(ws, -12603+95+64, 326+83-32),
			{type: 'item', item: 'spell', spell: 'COLOUR_RED', biome: 'lake', x: -12603+95+32, y: 326+83-8},
			{type: 'item', item: 'spell', spell: 'COLOUR_ORANGE', biome: 'lake', x: -12603+95+44, y: 326+83-9},
			{type: 'item', item: 'spell', spell: 'COLOUR_YELLOW', biome: 'lake', x: -12603+95+56, y: 326+83-10},
			{type: 'item', item: 'spell', spell: 'COLOUR_GREEN', biome: 'lake', x: -12603+95+68, y: 326+83-11},
			{type: 'item', item: 'spell', spell: 'COLOUR_BLUE', biome: 'lake', x: -12603+95+80, y: 326+83-12},
			{type: 'item', item: 'spell', spell: 'COLOUR_PURPLE', biome: 'lake', x: -12603+95+92, y: 326+83-13},
			{type: 'item', item: 'spell', spell: 'COLOUR_RAINBOW', biome: 'lake', x: -12603+95+104, y: 326+83-14},
			{type: 'item', item: 'spell', spell: 'COLOUR_INVIS', biome: 'lake', x: -12603+95+116, y: 326+83-15},
		], x: -12456, y: 392, biome: 'lake'}); // Approx position
		// {name: "general/bunker2", x: -12953, y: 540},
		newPois.push({type: 'puzzle', materials: 'reforged tablet', items: [
			generateExperimentalWand1(ws, -12953+95+64, 540+83-32),
			{type: 'item', item: 'spell', spell: 'IF_HALF', biome: 'lake', x: -12953+95+24, y: 540+83-8},
			{type: 'item', item: 'spell', spell: 'IF_HP', biome: 'lake', x: -12953+95+38, y: 540+83-9},
			{type: 'item', item: 'spell', spell: 'IF_PROJECTILE', biome: 'lake', x: -12953+95+52, y: 540+83-10},
			{type: 'item', item: 'spell', spell: 'IF_ENEMY', biome: 'lake', x: -12953+95+66, y: 540+83-11},
			{type: 'item', item: 'spell', spell: 'IF_ELSE', biome: 'lake', x: -12953+95+80, y: 540+83-12},
			{type: 'item', item: 'spell', spell: 'IF_ELSE', biome: 'lake', x: -12953+95+94, y: 540+83-13},
			{type: 'item', item: 'spell', spell: 'IF_END', biome: 'lake', x: -12953+95+108, y: 540+83-14},
			{type: 'item', item: 'spell', spell: 'IF_END', biome: 'lake', x: -12953+95+122, y: 540+83-15},
		], x: -12800, y: 610, biome: 'lake'}); // Approx position

		// Gourd
		// data/scripts/biomes/gourd_room.lua registers 0xff31d0b0 -> spawn_fruit, which
		// EntityLoads five gourds centred on that magic pixel. The spliced scene is stamped at
		// (-33*512, -14*512), which is exactly the splice origin in
		// data/biome_impl/spliced/_gourd.bat (-x -16896 -y -7168), and gourd_room.png contains
		// exactly one 0x31d0b0 pixel, at (711, 902) -- so the cluster centre is (-16185, -6266),
		// sitting on the floor of the room's air pocket. The shipped scene agrees independently:
		// gourd_room/4.plz (pos_x -16384, pos_y -6656) carries the same lone pixel at local
		// (199, 390), which resolves to the same world point.
		newPois.push({type: 'item', item: 'gourd', x: -33*512 + 711, y: -14*512 + 902, biome: 'gourd_room'});

		// Tower treasure
		newPois.push({type: 'item', item: 'treasure', x: 9472, y: 4347, biome: 'hills'});
	}

	// This one is in nightmare though
	if (ng === 0 && pwIndex === 0 && pwIndexVertical === 0) {
		// Kantele
		newPois.push(generateWandKantele(-1633, -783));
		newPois.push({type: 'shop', biome: 'mountain_tree', x: -1628, y: -736, items: [
			{type: 'item', item: 'spell', spell: 'KANTELE_A', biome: 'mountain_tree', x: -1663, y: -760},
			{type: 'item', item: 'spell', spell: 'KANTELE_A', biome: 'mountain_tree', x: -1663, y: -740},
			{type: 'item', item: 'spell', spell: 'KANTELE_D', biome: 'mountain_tree', x: -1643, y: -760},
			{type: 'item', item: 'spell', spell: 'KANTELE_D', biome: 'mountain_tree', x: -1643, y: -740},
			{type: 'item', item: 'spell', spell: 'KANTELE_DIS', biome: 'mountain_tree', x: -1623, y: -760},
			{type: 'item', item: 'spell', spell: 'KANTELE_DIS', biome: 'mountain_tree', x: -1623, y: -740},
			{type: 'item', item: 'spell', spell: 'KANTELE_E', biome: 'mountain_tree', x: -1603, y: -760},
			{type: 'item', item: 'spell', spell: 'KANTELE_E', biome: 'mountain_tree', x: -1603, y: -740},
			{type: 'item', item: 'spell', spell: 'KANTELE_G', biome: 'mountain_tree', x: -1583, y: -760},
			{type: 'item', item: 'spell', spell: 'KANTELE_G', biome: 'mountain_tree', x: -1583, y: -740},
		]});
	}

	if (ng === 0 && pwIndexVertical === 0 && !isNightmare) {
		// Chaingun
		newPois.push(generateExperimentalWand3(16120 + pwOffsetX, 9996));
		// Saha
		newPois.push(generateExperimentalWand4(13*512+256 + pwOffsetX, 16*512+256)); // Approx position, also this is a boss drop but I'm just treating it as a wand

		// Tower wands (spaced out a bit from their actual positions just to make interaction easier in with the PoIs)
		newPois.push(generateGoodWand1(9884 + pwOffsetX, 4360));
		newPois.push(generateGoodWand2(9984 + pwOffsetX, 4360));
		newPois.push(generateGoodWand3(10084 + pwOffsetX, 4360));
	}

	if (pwIndexVertical === 0) {
		// Ocarina / Flute / Huilu
		newPois.push(generateWandHuilu(-9985 + pwOffsetX, -6472));
		newPois.push({type: 'shop', biome: 'ocarina', x: -9987 + pwOffsetX, y: -6400, items: [
			{type: 'item', item: 'spell', spell: 'OCARINA_A', biome: 'ocarina', x: -10055 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_A', biome: 'ocarina', x: -10055 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_B', biome: 'ocarina', x: -10035 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_B', biome: 'ocarina', x: -10035 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_C', biome: 'ocarina', x: -10015 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_C', biome: 'ocarina', x: -10015 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_D', biome: 'ocarina', x: -9995 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_D', biome: 'ocarina', x: -9995 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_E', biome: 'ocarina', x: -9975 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_E', biome: 'ocarina', x: -9975 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_F', biome: 'ocarina', x: -9955 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_F', biome: 'ocarina', x: -9955 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_GSHARP', biome: 'ocarina', x: -9935 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_GSHARP', biome: 'ocarina', x: -9935 + pwOffsetX, y: -6418},
			{type: 'item', item: 'spell', spell: 'OCARINA_A2', biome: 'ocarina', x: -9915 + pwOffsetX, y: -6466},
			{type: 'item', item: 'spell', spell: 'OCARINA_A2', biome: 'ocarina', x: -9915 + pwOffsetX, y: -6418},
		]});
	}

	// Tiny
	if (pwIndex === 0 && pwIndexVertical === 0 && !isNightmare) {
		newPois.push(getTinyDrops(ws, ng, 'meat', 14941, 16454, perks));
	}
	// Orbs and other stuff: TODO: Doesn't seem that important compared to NG+ which already works

	// Three eggs
	if (pwIndex === 0 && pwIndexVertical === 0) {
		const baseX = -4*512;
		const baseY = -3*512 + 212;
		const egg_positions = [
			{x: 999, y: 845}, // -> -1047, -477
			{x: 914, y: 301},
			{x: 904, y: 302}
		];
		for (const pos of egg_positions) {
			prng.SetRandomSeed(ws + ng, baseX + pos.x, baseY + pos.y);
			let r = prng.Next() * 0.42;
			let eggType = 'egg_worm';
			if (r >= 0.4) {
				eggType = 'egg_purple'; // Hamis!
			}
			newPois.push({type: 'item', item: eggType, x: baseX + pos.x + 2, y: baseY + pos.y + 2, biome: 'mountain_tree'});
		}
	}

	// Starting loadout
	if (ng === 0) {
		const startingLoadout = getStartingLoadout(ws, isDaily, gameMode);
		//console.log("Starting Loadout:", startingLoadout);
		// Add as PoI at spawn
		newPois.push(startingLoadout);
	}

	// Starting wands in Nightmare
	if (isNightmare && ng === 0 && pwIndexVertical === 0) {
		const nightmareWands = getNightmareStartingWands(ws, pwIndex);
		newPois.push(...nightmareWands);
	}

	/*
	const t1 = performance.now();
	if (Math.abs(pwIndex) <= 1 && pwIndexVertical === 0) {
		// This is indeed a waste of time for main
		console.log(`Adding static pixel scenes took ${t1 - t0} ms.`);
	}
	*/
	return {
		pixelScenes: newPixelScenes,
		pois: newPois,
		hiisiHourglassPosition
	};
}

function getNightmareStartingWands(ws, pwIndex) {
	const prng = new NollaPrng(0);
	prng.SetRandomSeed(ws, 703 + pwIndex * 64 * 512, -94); // Chunk 1, -1, pos 191, 418
	const wands = [];
	const opts = ["wand_level_02", "wand_level_02_better", "wand_level_03", "wand_unshuffle_01", "wand_unshuffle_02", "wand_unshuffle_03"];
	for (let i = 0; i < 3; i++) {
		const wandChoice = 0; //prng.Random(1, opts.length) - 1;
		const x = Math.fround(703 + i*132/3);
		const y = -94;
		const wand = generateWand(ws, 0, x, y, opts[wandChoice]);
		wand['biome'] = 'mountain_hall';
		wands.push(wand);
	}
	return wands;
}

// TODO: Add sprite length stats, need to go find them in the xml
function generateExperimentalWand1(x, y) {
	return {type: 'wand', item: 'wand', biome: 'lake', x: x, y: y,
		name: 'IfElse Experimental Wand',
		sprite: 'custom/experimental_wand_1',
		tip: {x:9,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 14,
		actions_per_round: 1,
		reload_time: '0.5 - 0.67', // 30 - 40f
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 5,
		spread_degrees: 0,
		speed_multiplier: 1.0,
		mana_charge_speed: '200 - 300',
		mana_max: '500 - 600',
		is_rare: false,
		always_casts: [],
		cards: ['BLOODLUST', 'IF_HALF', 'ROCKET_TIER_3', 'IF_ELSE', 'GRENADE_TIER_3', 'IF_END'],
	};
}

// Turns out this RNG is based on frame count
function generateExperimentalWand2(x, y) {
	return {type: 'wand', item: 'wand', biome: 'lake', x: x, y: y,
		name: 'Colour Experimental Wand',
		sprite: 'custom/experimental_wand_2',
		tip: {x:12,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 10,
		actions_per_round: 1,
		reload_time: '0.67 - 1.0', // 40 - 60f
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 20,
		spread_degrees: 0,
		speed_multiplier: 1.0,
		mana_charge_speed: '100 - 200',
		mana_max: '500 - 600',
		is_rare: false,
		always_casts: [],
		cards: ['UNIDENTIFIED', 'SPITTER_TIER_3', 'UNIDENTIFIED', 'SPITTER_TIER_3', 'UNIDENTIFIED', 'SPITTER_TIER_3', 'COLOUR_INVIS', 'SPITTER_TIER_3', 'COLOUR_RAINBOW', 'SPITTER_TIER_3'],
		// TODO: It would be cool to use a gif for random color but meh
		//cards: ['RANDOM_COLOUR', 'SPITTER_TIER_3', 'RANDOM_COLOUR', 'SPITTER_TIER_3', 'RANDOM_COLOUR', 'SPITTER_TIER_3', 'COLOUR_INVIS', 'SPITTER_TIER_3', 'COLOUR_RAINBOW', 'SPITTER_TIER_3'],
	};
}

function generateExperimentalWand3(x, y) {
	return {type: 'wand', item: 'wand', biome: 'gun_room', x: x, y: y,
		name: "It's a wand, ok? Experimental Wand",
		sprite: "custom/actual_wand_honest",
		tip: {x:15,y:1},
		grip: {x:0,y:0},
		deck_capacity: 2,
		actions_per_round: 1,
		reload_time: 3,
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 3,
		spread_degrees: 10,
		speed_multiplier: 2.0,
		mana_charge_speed: 500,
		mana_max: '1200 - 1500',
		is_rare: false,
		always_casts: ['FUNKY_SPELL'],
		cards: [],
	};
}

function generateExperimentalWand4(x, y) {
	return {type: 'wand', item: 'wand', biome: 'meatroom', x: x, y: y,
		name: "Saha Experimental Wand",
		sprite: "custom/chainsaw",
		tip: {x:8,y:1},
		grip: {x:0,y:0},
		deck_capacity: 1,
		actions_per_round: 1,
		reload_time: 1,
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 1,
		spread_degrees: 30,
		speed_multiplier: 4.0,
		mana_charge_speed: '200 - 300',
		mana_max: '800 - 900',
		is_rare: false,
		always_casts: ['RECOIL_DAMPER', 'BLOODLUST', 'CHAINSAW'],
		cards: [],
	};
}

function generateGoodWand1(x, y) {
	return {type: 'wand', item: 'wand', biome: 'solid_wall_tower_10', x: x, y: y,
		name: 'Wand of Swiftness',
		sprite: 'custom/good_01',
		tip: {x:15,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 19,
		actions_per_round: 1,
		reload_time: '0.0 - 0.08', // 0 - 5f
		shuffle_deck_when_empty: 0,
		fire_rate_wait: -20,
		spread_degrees: 0,
		speed_multiplier: 1.25,
		mana_charge_speed: '600 - 700',
		mana_max: '800 - 1000',
		is_rare: false,
		always_casts: [],
		cards: ['UNIDENTIFIED'],
	};
}

function generateGoodWand2(x, y) {
	return {type: 'wand', item: 'wand', biome: 'solid_wall_tower_10', x: x, y: y,
		name: 'Wand of Destruction',
		sprite: 'custom/good_02',
		tip: {x:15,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 25,
		actions_per_round: 1,
		reload_time: -2280,
		shuffle_deck_when_empty: 0,
		fire_rate_wait: '0.33 - 0.83', // 20 - 50f
		spread_degrees: 0,
		speed_multiplier: 1.33,
		mana_charge_speed: 800,
		mana_max: '1100 - 1500',
		is_rare: false,
		always_casts: ['NUKE'],
		cards: ['ROCKET_TIER_3'],
	};
}

function generateGoodWand3(x, y) {
	return {type: 'wand', item: 'wand', biome: 'solid_wall_tower_10', x: x, y: y,
		name: 'Wand of Multitudes',
		sprite: 'custom/good_03',
		tip: {x:15,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 26,
		actions_per_round: 26,
		reload_time: '0.4 - 0.63', // 24 - 38f
		shuffle_deck_when_empty: 0,
		fire_rate_wait: '0.08 - 0.17', // 5 - 10f
		spread_degrees: '3 - 8',
		speed_multiplier: 1.5,
		mana_charge_speed: '300 - 500',
		mana_max: '1200 - 1500',
		is_rare: false,
		always_casts: [],
		cards: ['UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED','UNIDENTIFIED'],
	};
}

function generateWandKantele(x, y) {
	return {type: 'wand', item: 'wand', biome: 'mountain_tree', x: x, y: y,
		name: 'Kantele',
		sprite: 'custom/kantele',
		tip: {x:10,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 20,
		actions_per_round: 1,
		reload_time: 1,
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 2,
		spread_degrees: -2,
		speed_multiplier: 1.0,
		mana_charge_speed: 30,
		mana_max: 2,
		is_rare: false,
		always_casts: [],
		cards: [],
	};
}

function generateWandHuilu(x, y) {
	return {type: 'wand', item: 'wand', biome: 'ocarina', x: x, y: y,
		name: 'Huilu',
		sprite: 'custom/flute',
		tip: {x:10,y:-0.5},
		grip: {x:0,y:0},
		deck_capacity: 20,
		actions_per_round: 1,
		reload_time: 1,
		shuffle_deck_when_empty: 0,
		fire_rate_wait: 2,
		spread_degrees: -2,
		speed_multiplier: 1.0,
		mana_charge_speed: 30,
		mana_max: 2,
		is_rare: false,
		always_casts: [],
		cards: [],
	};
}