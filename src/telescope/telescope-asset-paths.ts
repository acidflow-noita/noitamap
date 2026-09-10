/** One path policy for direct PNG loads, fetch(), and Image.src. Scene material
 * masks must keep using the prepared scene archive, not arbitrary game PNGs. */
export type TelescopeArchive = "main" | "pixel_scenes" | "wang_tiles";
export interface TelescopeAssetCandidate {
  archive: TelescopeArchive;
  path: string;
}

export function normalizeTelescopePath(url: string): string | null {
  try {
    const path = decodeURIComponent(
      new URL(url, "https://telescope.invalid/").pathname,
    );
    const start = path.indexOf("/data/");
    return start < 0 ? null : path.slice(start + 1);
  } catch {
    return null;
  }
}

export function telescopePathToZipPath(url: string): string {
  return (normalizeTelescopePath(url) ?? url.replace(/^\.\//, "")).replace(
    /^data\/biome_maps\//,
    "data/biome_impl/",
  );
}

const SCENE_ALIASES: Record<string, string> = {
  "snowcave/altar_snowcave_capsule.png": "temple/altar_snowcave_capsule.png",
  "snowcastle/altar_snowcastle_capsule.png":
    "temple/altar_snowcastle_capsule.png",
  "vault/altar_vault_capsule.png": "temple/altar_vault_capsule.png",
  "snowcave/acidtank_visual.png": "general/acidtank_visual.png",
  "snowcave/acidtank_2_visual.png": "general/acidtank_2_visual.png",
  "general/scale.png": "overworld/scale.png",
  "general/scale_old.png": "overworld/scale_old.png",
};

function mainPaths(path: string): string[] {
  return [
    ...new Set([
      path,
      path.replace("data/pixel_scenes/general/", "data/biome_impl/"),
      path.replace("data/pixel_scenes/general/", "data/biome_impl/the_end/"),
      path.replace(
        "data/pixel_scenes/general/teleportroom",
        "data/biome_impl/mystery_teleport",
      ),
      path.replace(
        "data/pixel_scenes/general/cauldron",
        "data/biome_impl/cauldron",
      ),
      path.replace("data/pixel_scenes/spliced/", "data/biome_impl/"),
      ...(path.endsWith("_visual.png")
        ? [path.replace("data/pixel_scenes/", "data/biome_impl/")]
        : []),
      path.replace("data/backgrounds/", "data/"),
    ]),
  ];
}

export function telescopeAssetCandidates(
  url: string,
): TelescopeAssetCandidate[] {
  if (!normalizeTelescopePath(url)) return [];
  const path = telescopePathToZipPath(url);
  const candidates: TelescopeAssetCandidate[] = mainPaths(path).map((path) => ({
    archive: "main",
    path,
  }));
  for (const archive of ["pixel_scenes", "wang_tiles"] as const) {
    const prefix = `data/${archive}/`;
    if (path.startsWith(prefix))
      candidates.push({ archive, path: path.slice(prefix.length) });
  }
  const scene = path.replace(/^data\/pixel_scenes\//, "");
  const alias = SCENE_ALIASES[scene];
  if (alias) {
    // Prepared material masks win over the original, unprocessed game copy.
    candidates.push({ archive: "pixel_scenes", path: alias });
    candidates.push(
      ...mainPaths(`data/pixel_scenes/${alias}`).map((path) => ({
        archive: "main" as const,
        path,
      })),
    );
  }
  return candidates;
}
