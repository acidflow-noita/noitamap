import { installTelescopeShim } from "./telescope-dom-shim";
import { installFetchInterceptor, installImageSrcInterceptor } from "./telescope-data-bridge";

// Setup fake DOM and Window for telescope exports
if (typeof document === "undefined") {
  (globalThis as any).document = {
    createElement: (tag: string) => {
      const el: any = { style: {}, children: [] };
      el.appendChild = (child: any) => el.children.push(child);
      el.setAttribute = () => {};
      el.remove = () => {};
      return el;
    },
    getElementById: () => null,
    body: {
      appendChild: () => {}
    }
  };
}
if (typeof window === "undefined") {
  (globalThis as any).window = self;
}

// We MUST install shims synchronously BEFORE any dynamic imports hit top-level await!
installTelescopeShim();
installFetchInterceptor();
installImageSrcInterceptor();

self.onmessage = async (e) => {
  try {
    const { biomeData, tileSpawns, seed, ngPlus, pw, gameMode, perks, skipCosmeticScenes } = e.data;

    // Dynamically import AFTER shims are correctly established
    const { scanSpawnFunctions, getSpecialPoIs } = await import("../../lib/noita-telescope/js/poi_scanner.js");
    const { addStaticPixelScenes } = await import("../../lib/noita-telescope/js/static_spawns.js");
    const { updateSettings } = await import("../../lib/noita-telescope/js/settings.js");
    const { loadPixelSceneData } = await import("../../lib/noita-telescope/js/pixel_scene_generation.js");

    // Initialize required telescope settings
    updateSettings({
      gameMode,
      skipCosmeticScenes,
    });

    // Populate worker's pixel scene cache before performing generation
    await loadPixelSceneData();

    // 1. Scan spawns
    const scanResults = scanSpawnFunctions(biomeData, tileSpawns, seed, ngPlus, pw, 0, skipCosmeticScenes, perks, gameMode);
    
    // 2. Special POIs
    const specialPOIs = getSpecialPoIs(biomeData, seed, ngPlus, pw, 0, perks, gameMode);
    
    // 3. Static Pixel Scenes
    const staticResults = addStaticPixelScenes(seed, ngPlus, pw, 0, biomeData, false, perks, false, gameMode);

    let combinedPois = scanResults.generatedSpawns.concat(specialPOIs);
    let pixelScenes = scanResults.finalPixelScenes;

    if (staticResults && staticResults.pois) {
      combinedPois.push(...staticResults.pois);
    }
    if (staticResults && staticResults.pixelScenes) {
      pixelScenes = pixelScenes.concat(staticResults.pixelScenes);
    }

    // 4. Vertical PWs
    const verticalPois = [];
    for (const pvt of [-1, 1]) {
      const vtResults = addStaticPixelScenes(seed, ngPlus, pw, pvt, biomeData, false, perks, false, gameMode);
      if (vtResults && vtResults.pois) {
        verticalPois.push(...vtResults.pois);
      }
      if (vtResults && vtResults.pixelScenes) {
        pixelScenes = pixelScenes.concat(vtResults.pixelScenes);
      }
    }
    if (verticalPois.length > 0) {
      combinedPois.push(...verticalPois);
    }

    // Return the payload back to main thread to apply Wand patching and boss patching
    self.postMessage({
      success: true,
      pw,
      pois: combinedPois,
      pixelScenes: pixelScenes
    });
  } catch (error) {
    self.postMessage({ success: false, error: (error as Error).message });
  }
};
