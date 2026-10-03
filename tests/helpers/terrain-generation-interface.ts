export { generateFullPixelWorld } from "../../src/telescope/terrain-generation";
// @ts-ignore — selected upstream interface
export { loadTerrainAssets, generateTerrainWorld } from "noita-telescope-full-pixels/terrain_world.js";

export { generateDynamicMap } from "../../src/telescope/telescope-adapter";
export { setGLTerrain } from "../../src/renderer_settings";
export { loadSceneBackground } from "../../src/telescope/scene-background";
// @ts-ignore — include every upstream scene background in the regression check.
export { SCENE_BACKGROUNDS, SCENE_BACKGROUNDS_BY_BIOME } from "noita-telescope-full-pixels/pixel_scene_backgrounds.js";
export { decodePngToRgba } from "../../src/telescope/png-decode";
