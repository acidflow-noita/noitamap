import edges from "../../lib/noita-telescope-vm/data/edge_atlas.bin?url";
import atlas from "../../lib/noita-telescope-vm/data/material_atlas.bin?url";
import layout from "../../lib/noita-telescope-vm/data/material_atlas.json?url";
import flags from "../../lib/noita-telescope-vm/data/biome_flags.json?url";
import materials from "../../lib/noita-telescope-vm/data/material_data.json?url";

const assets: Record<string, string> = {
  "material_atlas.bin": atlas,
  "edge_atlas.bin": edges,
  "material_atlas.json": layout,
  "biome_flags.json": flags,
  "material_data.json": materials,
};

export function fullPixelDataUrl(url: string): string | undefined {
  const name = url.match(/(?:^|\/)data\/([^/?#]+)(?:[?#].*)?$/)?.[1];
  return name ? assets[name] : undefined;
}
