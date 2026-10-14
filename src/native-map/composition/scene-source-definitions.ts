// Adapted from the owned rules/pixel_scene_generation.js catalog boundary.
// See NOTICE.txt and ../rules/NOTICE.txt for source attribution.
import {
  GENERAL_SCENES,
  PIXEL_SCENE_BIOME_MAP,
} from "../rules/pixel_scene_config.js";
import { GENERATOR_CONFIG } from "../rules/generator_config.js";
import { VISUAL_OVERLAY_SCENES } from "../rules/pixel_scene_visuals.js";
import { SCENE_BACKGROUNDS } from "../rules/pixel_scene_backgrounds.js";
import { SKIP_EDGE_TEXTURE_SCENES } from "../rules/pixel_scene_edge_flags.js";

export interface NativeSceneSourceDefinition {
  key: string;
  name: string;
  sourceBiome: string;
  directory: string;
  materialPath: string;
  visualPath: string | null;
  backgroundPath: string | null;
  skipEdgeTextures: boolean;
}

const COLORS_FILE_ALIASES: Readonly<Record<string, string>> = {
  "coalmine/physics_01_alt": "physics_01_visual",
  "coalmine/physics_02_alt": "physics_02_visual",
  "coalmine/shop_alt": "shop_visual",
  "coalmine/shrine01_alt": "shrine01_visual",
  "coalmine/shrine02_alt": "shrine02_visual",
  "coalmine/swarm_alt": "swarm_visual",
  "coalmine/wandtrap_h_07": "wandtrap_h_06_visual",
  "crypt/room_gate_drop_b": "room_gate_drop_visual",
  "crypt/room_liquid_funnel_b": "room_liquid_funnel_visual",
  "crypt/shop_b": "shop_visual",
  "excavationsite/machine_1_alt": "machine_1_visual",
  "excavationsite/machine_2_alt": "machine_2_visual",
  "excavationsite/machine_3b_alt": "machine_3b_visual",
  "excavationsite/machine_4_alt": "machine_4_visual",
  "excavationsite/machine_5_alt": "machine_5_visual",
  "excavationsite/machine_6_alt": "machine_6_visual",
  "excavationsite/machine_7": "machine_5_visual",
  "excavationsite/machine_7_alt": "machine_5_visual",
  "excavationsite/shop_alt": "shop_visual",
  "general/bunker2": "bunker_visual",
  "general/cauldron": "cauldron_fg",
  "general/essenceroom_submerged": "essenceroom_visual",
  "pyramid/boss_limbs": "reward_visual",
  "snowcave/pipe_alt": "pipe_visual",
  "snowcave/verticalobservatory2_alt": "verticalobservatory2_visual",
  "snowcave/verticalobservatory_alt": "verticalobservatory_visual",
  "temple/altar_right_snowcastle": "altar_right_visual",
  "temple/altar_top_blood": "altar_top_visual",
  "temple/altar_top_ending": "altar_top_visual",
  "temple/altar_top_lava": "altar_top_visual",
  "temple/altar_top_oil": "altar_top_visual",
  "temple/altar_top_radioactive": "altar_top_visual",
  "temple/altar_top_water": "altar_top_visual",
};
function biomeAlias(name: string) {
  if (name === "coalmine_alt") return "coalmine";
  if (name === "excavationsite_cube_chamber") return "excavationsite";
  if (name === "snowcave_secret_chamber") return "snowcave";
  if (
    ["sandcave", "snowcastle_cavern", "snowcastle_hourglass_chamber"].includes(
      name,
    )
  )
    return "snowcastle";
  if (name === "rainforest_open" || name === "rainforest_dark")
    return "rainforest";
  if (name === "vault_frozen") return "vault";
  if (name === "the_end" || name === "the_sky") return "crypt";
  if (name === "scale") return "overworld";
  if (name.includes("temple")) return "temple";
  if (name.includes("pyramid")) return "pyramid";
  if (name.includes("mountain")) return "mountain";
  return name;
}

/** Catalog only: no host rendering, captured-art, category or skip-name policy.
 * Keep original object iteration and first-key-wins behavior because metadata
 * spawn indices belong to the first source biome that defines a shared key. */
export function nativeSceneSourceDefinitions(): ReadonlyMap<
  string,
  NativeSceneSourceDefinition
> {
  const out = new Map<string, NativeSceneSourceDefinition>();
  const general = new Set(GENERAL_SCENES.extras.map((s) => s.name));
  const config = GENERATOR_CONFIG as Record<string, unknown>;
  for (const [biome, groups] of Object.entries(PIXEL_SCENE_BIOME_MAP))
    for (const scenes of Object.values(groups) as Array<
      Array<{ name: string; dir?: string }>
    >)
      for (const scene of scenes) {
        if (!scene.name) continue;
        const family = biome.includes("temple")
          ? "temple"
          : biome.includes("pyramid")
            ? "pyramid"
            : biome.includes("mountain")
              ? "mountain"
              : !biome || general.has(scene.name) || !config[biome]
                ? "general"
                : biome;
        const key = `${family}/${scene.name}`;
        if (out.has(key)) continue;
        const directory = scene.dir ?? biomeAlias(biome),
          fileKey = `${directory}/${scene.name}`;
        const artName =
          COLORS_FILE_ALIASES[fileKey] ??
          (VISUAL_OVERLAY_SCENES.has(fileKey) ? `${scene.name}_visual` : null);
        out.set(
          key,
          Object.freeze({
            key,
            name: scene.name,
            sourceBiome: biome,
            directory,
            materialPath: `data/pixel_scenes/${directory}/${scene.name}.png`,
            visualPath: artName
              ? `data/pixel_scenes/${directory}/${artName}.png`
              : null,
            backgroundPath:
              (SCENE_BACKGROUNDS as Record<string, string>)[fileKey] ?? null,
            skipEdgeTextures: SKIP_EDGE_TEXTURE_SCENES.has(fileKey),
          }),
        );
      }
  return out;
}
