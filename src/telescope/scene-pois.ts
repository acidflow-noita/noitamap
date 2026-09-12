import type { POI } from "./telescope-adapter";

type Scene = { name: string; x: number; y: number; width: number; height: number };
type ScenePOIs = {
  poisByPW: Record<string, POI[]>;
  pixelScenesByPW?: Record<string, Scene[]>;
};

/** Normalize scene-backed interaction targets at generation/cache boundaries.
 * The pixel scene owns the visible art; its POI owns clicks/search only.
 * This is also applied to old cached/baked metadata, without mutating it.
 */
export function normalizeScenePOIs<T extends ScenePOIs>(result: T): T {
  let poisByPW = result.poisByPW;
  for (const [pw, pois] of Object.entries(result.poisByPW)) {
    const scenes = result.pixelScenesByPW?.[pw]?.filter((scene) =>
      scene.name === "meditation_cube_visual" && Number.isFinite(scene.x) && Number.isFinite(scene.y)
      && scene.width > 0 && scene.height > 0,
    );
    if (!scenes?.length) continue;
    let changed = false;
    const normalized = pois.map((poi) => {
      if (poi.type !== "item" || poi.item !== "meditation_cube") return poi;
      // Both Telescope forks emit this item at (scene.x+20, scene.y+29-70),
      // deliberately targeting the portal rather than the cube. Accept that
      // legacy anchor, the cube's spawn anchor, and our already-normalized
      // scene center. Never attach an unrelated cube to an arbitrary scene.
      const scene = scenes.find((scene) =>
        (poi.x === scene.x + 20 && (poi.y === scene.y + 29 - 70 || poi.y === scene.y + 29))
        || (poi.x === scene.x + scene.width / 2 && poi.y === scene.y + scene.height / 2),
      );
      if (!scene) return poi; // no corresponding painted scene: keep the sprite fallback
      const x = scene.x + scene.width / 2, y = scene.y + scene.height / 2;
      if (poi.x === x && poi.y === y && poi.clickOnly) return poi;
      changed = true;
      return { ...poi, x, y, clickOnly: true };
    });
    if (changed) {
      if (poisByPW === result.poisByPW) poisByPW = { ...poisByPW };
      poisByPW[pw] = normalized;
    }
  }
  return poisByPW === result.poisByPW ? result : { ...result, poisByPW };
}
