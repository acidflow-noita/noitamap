/**
 * material-hover.ts
 *
 * Resolves the material (and biome) under a world coordinate for the cursor
 * readout. Dynamic-map only: it reads telescope's in-memory per-pixel material
 * buffers (tileLayers[].buffer) via getMaterialAtWorldCoordinates. Baked seeds
 * ship no tileLayers and never init telescope, so this returns null there and
 * the cursor line simply omits the material.
 */

import { getLastGenerationResult } from "./dynamic-map";
import { gameTranslator } from "./game-translations/translator";

type UtilsMod = {
  getMaterialAtWorldCoordinates: (
    tileLayers: any[],
    pixelScenes: any[],
    worldX: number,
    worldY: number,
    pwIndex: number,
    pwIndexVertical: number,
    isNGP: boolean,
    gameMode?: string,
  ) => string | null;
};

let _utils: UtilsMod | null = null;

/** Kick off the telescope utils import so the move handler stays synchronous. */
export function primeMaterialHover(): void {
  if (_utils) return;
  import("./telescope/telescope-exports")
    .then((t) => {
      _utils = (t as any).utilsMod;
    })
    .catch(() => {});
}

/**
 * Translated material name at the given in-game world coordinate, or null when
 * unavailable (baked seed, no terrain data loaded, or empty space).
 */
export function materialAtWorld(worldX: number, worldY: number): string | null {
  const result = getLastGenerationResult();
  if (!result || !result.tileLayers || result.tileLayers.length === 0) return null;
  if (!_utils) {
    primeMaterialHover();
    return null;
  }

  // PW 0 is centered at worldX 0; each PW spans worldSize*512 px centered on a
  // multiple of that. Round to the nearest PW center to pick the world the
  // cursor is over. Vertical is always 0 in noitamap (heaven/hell are baked
  // into the same key's y range; those fall back to pixel-scene lookup).
  const worldSizePx = result.worldSize * 512;
  const pwIndex = Math.round(worldX / worldSizePx);
  const pixelScenes = result.pixelScenesByPW[`${pwIndex},0`] || [];

  let material: string | null = null;
  try {
    material = _utils.getMaterialAtWorldCoordinates(
      result.tileLayers,
      pixelScenes,
      worldX,
      worldY,
      pwIndex,
      0,
      result.isNGP,
      "normal",
    );
  } catch {
    return null;
  }
  if (!material) return null;
  return gameTranslator.translateMaterial(material);
}
