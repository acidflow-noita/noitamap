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
export function reconcileTempleCrystals<T extends Rooms>(input: T, changes?: CrystalPoint[]): T {
  if (input.isNGP || (input.ngPlus ?? 0) !== 0) return input;
  let poisByPW = input.poisByPW;
  for (const [key, pois] of Object.entries(input.poisByPW)) {
    const [pw, plane] = key.split(",").map(Number);
    const scenes = input.pixelScenesByPW?.[key];
    if (plane !== 0 || !Array.isArray(scenes)) continue;
    const expected = new Map(templeCrystals(scenes, pw).map(p => [identity(p), p]));
    const kept = pois.filter(p => {
      if (!isTempleCrystal(p) || expected.delete(identity(p))) return true;
      changes?.push({ x: p.x, y: p.y });
      return false;
    });
    if (kept.length === pois.length && !expected.size) continue;
    if (poisByPW === input.poisByPW) poisByPW = { ...poisByPW };
    for (const p of expected.values()) changes?.push({ x: p.x, y: p.y });
    poisByPW[key] = kept.concat([...expected.values()]);
  }
  return poisByPW === input.poisByPW ? input : { ...input, poisByPW };
}

export function lookingAtCrystalChange(viewer: any, points: CrystalPoint[]): boolean {
  if (!points.length) return false;
  const osd = viewer.viewer ?? viewer, viewport = osd.viewport;
  const visible = viewport?.getBounds?.(true);
  const bounds = visible?.getBoundingBox?.() ?? visible;
  const screenWidth = viewport?.getContainerSize?.()?.x ?? osd.container?.clientWidth;
  // Both crystal sprites are 8 × 14 world pixels. Keep the baked overview while
  // their width is below a display pixel; include their extents at the viewport edge.
  if (!bounds || !(screenWidth > 0) || bounds.width > 8 * screenWidth) return false;
  return points.some(p => p.x + 4 >= bounds.x && p.x - 4 <= bounds.x + bounds.width &&
    p.y + 7 >= bounds.y && p.y - 7 <= bounds.y + bounds.height);
}

// Positions stamped by the previous baker. These are only used to recognize stale pixels.
function oldCrystalPair(pw: number, width: number, altarY: number): [POI, POI] {
  const x = pw * width * 512 + (altarY === 13181 ? 2560 : -32);
  return [{ ...worm, x: x - 280, y: altarY + 45 }, { ...greed, x: x - 730, y: altarY - 73 }];
}

/** These ghosts can be identified before loading generation.json. Avoid even a first
 * paint of the invalid ending-room pair when following a link directly to it. */
export function lookingAtLegacyFinalCrystals(viewer: any, gameMode: string, light: boolean): boolean {
  const width = gameMode === "nightmare" ? 64 : 70;
  const points = (light ? [0] : [-1, 0, 1]).flatMap(pw => {
    const [deflector, statue] = oldCrystalPair(pw, width, 13181);
    return pw === 0 ? [statue] : [deflector, statue];
  });
  return lookingAtCrystalChange(viewer, points);
}

/** Older decorated WebPs painted seven fixed pairs in every world. Compare their pixels'
 * positions with the actual rooms so only inspection of an affected area needs live terrain. */
export function legacyCrystalChanges(result: GenerationResult): CrystalPoint[] {
  if (result.isNGP || result.ngPlus !== 0 || !result.worldSize) return [];
  const changes: CrystalPoint[] = [];
  for (const pw of result.parallelWorlds ?? []) {
    // The narrow strips of PW ±2 never contain the old markers at their world's center.
    if (Math.abs(pw) > 1) continue;
    const scenes = result.pixelScenesByPW?.[pw + ",0"];
    if (!Array.isArray(scenes)) continue;
    const actual = new Map(templeCrystals(scenes, pw).map(p => [identity(p), p]));
    for (const y of [1410, 2946, 4994, 6530, 8578, 10626, 13181]) {
      for (const old of oldCrystalPair(pw, result.worldSize, y)) {
        if (!actual.delete(identity(old))) changes.push({ x: old.x, y: old.y });
      }
    }
    for (const p of actual.values()) changes.push({ x: p.x, y: p.y });
  }
  return changes;
}
