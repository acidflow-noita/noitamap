// Current host scene policy, copied from telescope-osd-bridge.ts. No host imports.
import type { NativeScenePlacement } from '../composition/prepare-scenes';
import type { WorldRegion } from '../world';
export type SceneDisposition = 'render' | 'static-mask' | 'skip';
export interface SceneLayers { background: boolean; mid: boolean; visual: boolean }
export interface CompleteWorldScenePolicy {
  classify(scene: NativeScenePlacement, region: WorldRegion): SceneDisposition;
  layers(scene: NativeScenePlacement): SceneLayers;
}
const defaultSkipNames = new Set([
    // Player rooms — not relevant for map
    'essence_altar',
    'essence_altar_desert',
    'fishing_hut',
    'scale',
    'meatroom',
    'roboroom',
    'gourd_room',
    'ocarina',
    'funroom',
    'lavalake_racing',
    'secret_lab',
    'altar_top',
    'altar_top_ending',
    'hourglass_chamber',
    'watercave',
    'altar_top_water',
    'altar_top_lava',
    'altar_top_blood',
    'altar_top_oil',
    'altar_top_radioactive',
    // Holy-mountain altars are fully rendered into the prebaked background map;
    // the pixel scene would repaint slab + art on top. Same names cover both the
    // spawn-function ("temple/altar*") and biome-color ("temple_altar*/altar*")
    // sources. No collision: coalmine/snowcave altars use distinct *_capsule names.
    'altar',
    'altar_left',
    'altar_right',
    'altar_right_snowcastle',
    'teleportroom',
    'mystery_teleport',
    'robot_egg',
    'secret_chamber',
    'cube_chamber',
    'alchemist_secret',
    'alchemist_secret_music',
    'null_room',
    'eyespot',
    'orbroom',
    'yourroom',
    'yourroom_entrance',
    'yourroom_npc',
    'yourroom_coffin',
    'yourroom_coffin_entrance',
    'yourroom_coffin_npc',
    // Boss/special scenes — misplaced if duplicated from scanner
    'boss_arena',
    'boss_arena_top',
    'boss_victoryroom',
    // Spliced scenes prebaked in map capture
    'tree',
    'mountain_lake',
    'lavalake2',
    'lavalake_pit_bottom',
    'skull',
    'skull_in_desert',
    'lake_statue',
    // Static scenes prebaked in map capture
    'lavalake_pit',
    'lavalake_pit_cracked',
    'cauldron',
    'cliff',
    'rainbow_cloud',
    'huussi',
    'snowy_ruins_eye_pillar',
    'desert_ruins_base_01',
    'music_machine_stand',
    'bunker',
    'bunker2',
    'greed_treasure',
    // Biome color scenes prebaked in map capture
    'dragoncave',
    'roadblock',
    'wizardcave_entrance',
    // Pyramid scenes - prebaked in map art
    'left',
    'right',
  ]);
  /** Skip lists by biome prefix in scene key */
const defaultSkipBiomes = new Set([
    'dragoncave', // prebaked in static map art
    'mountain', // mountain scenes are prebaked in map capture
    'pyramid', // pyramid scenes are prebaked in map capture
  ]);

export interface CurrentScenePolicyOptions {
  /** Explicit choice: the dynamic layer never invents the captured base art. */
  capturedGold: 'static-capture' | 'generated';
  mapWidth: number;
  enabled?: boolean;
  skipNames?: ReadonlySet<string>;
  skipBiomes?: ReadonlySet<string>;
  categories?: Readonly<Record<string, boolean>>;
  skip?: (scene: NativeScenePlacement) => boolean;
  layers?: Partial<SceneLayers>;
  layerOverrides?: Readonly<Record<string, Partial<SceneLayers>>>;
}
function category(scene: NativeScenePlacement): string {
  const biome = scene.key.split('/')[0], name = scene.name;
  if (biome === 'spliced') return 'spliced';
  if (biome.includes('temple')) return 'temple';
  if (name === 'friendroom' || name === 'cavern') return 'friendRoom';
  if (name.startsWith('watercave_layout')) return 'watercave';
  if (name === 'side_cavern_left' || name === 'side_cavern_right') return 'snowcastle';
  if (biome.startsWith('friend_')) return 'friendRoom';
  if (biome === 'snowcastle_cavern' || biome === 'sandcave') return 'snowcastle';
  return 'spawned';
}
export function createCurrentMapScenePolicy(options: CurrentScenePolicyOptions): CompleteWorldScenePolicy {
  if (!['static-capture', 'generated'].includes(options.capturedGold) || ![64, 70].includes(options.mapWidth))
    throw new Error('Explicit captured-gold/map policy is required');
  const names = new Set(options.skipNames ?? defaultSkipNames), biomes = new Set(options.skipBiomes ?? defaultSkipBiomes);
  const categories: Record<string, boolean> = { static:true, biomeChunk:true, spawned:true, spliced:true, temple:true, friendRoom:true, watercave:true, snowcastle:true, ...options.categories };
  const layers = { background:true, mid:true, visual:true, ...options.layers };
  const overrides = Object.fromEntries(Object.entries(options.layerOverrides ?? {}).map(([key, value]) => [key, { ...value }]));
  const enabled = options.enabled !== false, width = options.mapWidth, captured = options.capturedGold === 'static-capture';
  const skip = options.skip ?? ((scene: NativeScenePlacement) => scene.name === 'essenceroom' && scene.x < 0);
  return {
    classify(scene) {
      // Coarse/static image proxies have no material instructions in this catalog.
      if (scene.key.startsWith('static_tile/')) return 'skip';
      if ((captured && width === 70 && scene.key === 'general/solid_wall_hidden_cavern' && scene.y === 0 &&
           Number.isInteger((scene.x - (-6 * 512 - 30)) / 35840)) || names.has(scene.name) || biomes.has(scene.key.split('/')[0]))
        return 'static-mask';
      if (!enabled || scene.width <= 0 || scene.height <= 0 || !categories[category(scene)] || skip(scene)) return 'skip';
      return 'render';
    },
    layers(scene) { return { ...layers, ...(overrides[scene.name] ?? overrides[scene.key]) }; },
  };
}
