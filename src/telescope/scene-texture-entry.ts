/** Scene textures need both modules. Keep this entry deferred: the atlas
 * reads asynchronously initialized materials, while other terrain callers
 * already use the band selector synchronously. Neither belongs in a static
 * dependency of the scene generator. */
// @ts-ignore — pinned full-pixel telescope module, resolved by Vite.
export * as atlas from "noita-telescope-full-pixels/gl/material_atlas.js";
// @ts-ignore — pinned full-pixel telescope module, resolved by Vite.
export * as bands from "noita-telescope-full-pixels/engine_resolve/band_select.js";
