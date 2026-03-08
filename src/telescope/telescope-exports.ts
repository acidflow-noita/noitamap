/**
 * telescope-exports.ts
 *
 * This file serves as a single "barrel" entry point to ALL noita-telescope internal files.
 * By statically importing the library here, and then dynamically importing THIS FILE
 * where needed in noitamap (like telescope-adapter.ts and telescope-osd-bridge.ts), we
 * guarantee that Rollup/Vite only sees ONE dynamic branch pointing to the telescope codebase.
 * This completely resolves the "dynamic import will not move module into another chunk" warnings.
 */

// @ts-ignore
export * as biomeGenMod from "noita-telescope/biome_generator.js";
// @ts-ignore
export * as tileGenMod from "noita-telescope/tile_generator.js";
// @ts-ignore
export * as poiScannerMod from "noita-telescope/poi_scanner.js";
// @ts-ignore
export * as pixelSceneMod from "noita-telescope/pixel_scene_generation.js";
// @ts-ignore
export * as genConfigMod from "noita-telescope/generator_config.js";
// @ts-ignore
export * as unlocksMod from "noita-telescope/unlocks.js";
// @ts-ignore
export * as utilsMod from "noita-telescope/utils.js";
// @ts-ignore
export * as translationsMod from "noita-telescope/translations.js";
// @ts-ignore
export * as eyeMessagesMod from "noita-telescope/eye_messages.js";
// @ts-ignore
export * as imageProcessingMod from "noita-telescope/image_processing.js";
// @ts-ignore
export * as staticSpawnsMod from "noita-telescope/static_spawns.js";
// @ts-ignore
export * as appMod from "noita-telescope/app.js";
// @ts-ignore
export * as nollaPrngMod from "noita-telescope/nolla_prng.js";
// @ts-ignore
export * as wandConfigMod from "noita-telescope/wand_config.js";
// @ts-ignore
export * as constantsMod from "noita-telescope/constants.js";
// @ts-ignore
export * as tooltipGenMod from "noita-telescope/tooltip_generator.js";
// @ts-ignore
export * as pngSanitizerMod from "noita-telescope/png_sanitizer.js";
