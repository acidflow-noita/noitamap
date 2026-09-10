/** Deferred entry for scene textures. Keep the scene generator's import of
 * this module dynamic: the atlas depends on asynchronously loaded materials.
 * A static scene-generator -> atlas edge creates a top-level-await cycle. */
// @ts-ignore — pinned full-pixel telescope module, resolved by Vite.
export * from "noita-telescope-full-pixels/gl/material_atlas.js";
