import terrainPack from "../../lib/noita-telescope-vm/data/packs/terrain.pack?url";
import scenePack from "../../lib/noita-telescope-vm/data/packs/pixel_scenes.pack?url";
import backgroundPack from "../../lib/noita-telescope-vm/data/packs/backgrounds.pack?url";
import biomePack from "../../lib/noita-telescope-vm/data/packs/biome_maps.pack?url";
import sceneMeta from "../../lib/noita-telescope-vm/data/pixel_scene_meta.json?url";
import wandRates from "../../lib/noita-telescope-vm/data/sprite_distributions/wand_sprite_rates.json?url";
import edges from "../../lib/noita-telescope-vm/data/edge_atlas.bin?url";
import atlas from "../../lib/noita-telescope-vm/data/material_atlas.bin?url";
import layout from "../../lib/noita-telescope-vm/data/material_atlas.json?url";
import flags from "../../lib/noita-telescope-vm/data/biome_flags.json?url";
import materials from "../../lib/noita-telescope-vm/data/material_data.json?url";

const assets: Record<string, string> = {
  "packs/terrain.pack": terrainPack,
  "packs/pixel_scenes.pack": scenePack,
  "packs/backgrounds.pack": backgroundPack,
  "packs/biome_maps.pack": biomePack,
  "pixel_scene_meta.json": sceneMeta,
  "sprite_distributions/wand_sprite_rates.json": wandRates,
  "material_atlas.bin": atlas,
  "edge_atlas.bin": edges,
  "material_atlas.json": layout,
  "biome_flags.json": flags,
  "material_data.json": materials,
};

export function fullPixelDataUrl(url: string): string | undefined {
  const name = url.match(/(?:^|\/)data\/([^?#]+)(?:[?#].*)?$/)?.[1];
  return name ? assets[name] : undefined;
}
