import type { GenerationResult, POI } from "./telescope-adapter";

export const TEMPLE_CRYSTAL_VERSION = 1;
type Scene = { key: string; x: number; y: number; variantKey?: string };
export type CrystalPoint = { x: number; y: number };
type Rooms = Pick<GenerationResult, "poisByPW" | "pixelScenesByPW"> & Partial<Pick<GenerationResult, "ngPlus" | "isNGP">>;

const worm = { type: "item", item: "worm_crystal", nameKey: "building_worm_deflector", name: "Worm crystal", biome: "temple_altar" };
const greed = { type: "item", item: "greed_crystal", nameKey: "item_greed_crystal", name: "Greed-Cursed Crystal", biome: "temple_altar" };
const identity = (p: POI) => [p.item, p.x, p.y].join(":");
const isTempleCrystal = (p: POI) => p.type === "item" && p.biome === "temple_altar" &&
  (p.item === "worm_crystal" || p.item === "greed_crystal");

/** Read absolute room placements. Sprite anchors preserve the alignment of the original
 * regular-map markers. The game's altar.png deflector pixel is (200,175) and
 * altar_left.png has its curse-dependent statue at (266,114). */
export function templeCrystals(scenes: readonly Scene[], pw: number): POI[] {
  const found = new Map<string, POI>();
  for (const scene of scenes) {
    if (!Number.isFinite(scene.x) || !Number.isFinite(scene.y)) continue;
    let poi: POI;
    switch (scene.key) {
      case "temple/altar":
      case "temple_altar/altar":
      case "temple/altar_empty":
      case "temple_altar_empty/altar_empty":
        poi = { ...worm, x: scene.x + 200, y: scene.y + 175 };
        break;
      case "temple/altar_left":
      case "temple_altar_left/altar_left":
        // The empty left altar uses the same artwork but only loads an ordinary statue.
        if (scene.variantKey?.includes("temple_altar_left_empty")) continue;
        poi = { ...greed, x: scene.x + 262, y: scene.y + 57 };
        break;
      case "general/boss_arena":
      case "spliced/boss_arena":
        // Telescope can list this main-world splice in multiple PW/vertical buckets.
        // Its material image has a deflector at (744,942) and no greed-statue pixel.
        if (pw !== 0) continue;
        poi = { ...worm, x: scene.x + 744, y: scene.y + 938 };
        break;
      default:
        continue;
    }
    found.set(identity(poi), poi);
  }
  return [...found.values()].sort((a, b) => Math.floor(a.y / 512) - Math.floor(b.y / 512) || b.x - a.x);
}

/** Repair older generation records for searches, interactions and decoration exports.
 * Keep existing IDs and ordering for legitimate crystals and all other items. */
export function reconcileTempleCrystals<T extends Rooms>(input: T): T {
  if (input.isNGP || (input.ngPlus ?? 0) !== 0) return input;
  let poisByPW = input.poisByPW;
  for (const [key, pois] of Object.entries(input.poisByPW)) {
    const [pw, plane] = key.split(",").map(Number);
    const scenes = input.pixelScenesByPW?.[key];
    if (plane !== 0 || !Array.isArray(scenes)) continue;
    const expected = new Map(templeCrystals(scenes, pw).map(p => [identity(p), p]));
    const kept = pois.filter(p => !isTempleCrystal(p) || expected.delete(identity(p)));
    if (kept.length === pois.length && !expected.size) continue;
    if (poisByPW === input.poisByPW) poisByPW = { ...poisByPW };
    poisByPW[key] = kept.concat([...expected.values()]);
  }
  return poisByPW === input.poisByPW ? input : { ...input, poisByPW };
}

/** The old baker stamped both final-altar sprites in every world. Only the main
 * boss arena contains a deflector. All five obsolete footprints are transparent
 * in the regular baked overlay, revealing the captured background beneath it. */
export function legacyFinalCrystalGhosts(pw: number, width: number): CrystalPoint[] {
  const worldX = pw * width * 512;
  const statue = { x: worldX + 1830, y: 13108 };
  return pw === 0 ? [statue] : [{ x: worldX + 2280, y: 13226 }, statue];
}
