import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Prefer the private checkout inside this workspace; retain the sibling layout. */
export function resolveLocalPro(noitamapRoot: string) {
  const root = [
    resolve(noitamapRoot, "task/noitamap-pro"),
    resolve(noitamapRoot, "../noitamap-pro"),
  ].find((candidate) => existsSync(resolve(candidate, "src/pro-entry.ts")));

  return {
    root,
    available: root !== undefined,
    aliases: {
      "virtual:noitamap-pro": root
        ? resolve(root, "src/pro-entry.ts")
        : resolve(noitamapRoot, "src/pro-unavailable.ts"),
      "virtual:noitamap-public-report": root
        ? resolve(root, "src/public-report-entry.ts")
        : resolve(noitamapRoot, "src/public-report-unavailable.ts"),
      "noitamap/data_sources/tile_data": resolve(
        noitamapRoot,
        "src/data_sources/tile_data.ts",
      ),
      "noitamap/data_sources/map_definitions": resolve(
        noitamapRoot,
        "src/data_sources/map_definitions.ts",
      ),
      "noitamap/data_sources/param-mappings": resolve(
        noitamapRoot,
        "src/data_sources/param-mappings.ts",
      ),
      "noitamap/data_sources/overlays": resolve(
        noitamapRoot,
        "src/data_sources/overlays.ts",
      ),
      "noitamap/data-archive": resolve(noitamapRoot, "src/data-archive.ts"),
      "noitamap/data/spells.json": resolve(
        noitamapRoot,
        "src/data/spells.json",
      ),
    },
  };
}
