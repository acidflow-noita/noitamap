import { MaterialClassification as M, type CompleteMaterialResolver } from "../complete-materials/index.ts";
import { materialRGBA, type NativeMaterialAtlas } from "./atlas.ts";
import type { LegacyColorResolver } from "./legacy.ts";

export const ForegroundClassification = {
  material: 0, outsideOwnership: 1, legacyColor: 2, legacyAir: 3, unresolved: 255,
} as const;
export interface BaseForegroundInputs {
  materials: CompleteMaterialResolver;
  atlas: NativeMaterialAtlas;
  /** Required explicit source ownership. Static captures/absent input regions
   * must follow the cooker's actual ownership/mask policy. */
  ownsTerrain(x: number, worldY: number): boolean;
  legacy?: LegacyColorResolver;
}
export interface BaseForegroundRectangle {
  x: number; y: number; width: number; height: number;
  pixels: Uint8ClampedArray;
  classifications: Uint8Array;
  materialClassifications: Uint8Array;
  materials: Int32Array;
  unresolvedCount: number;
}
export function createBaseForegroundPainter(input: BaseForegroundInputs) {
  if (typeof input.ownsTerrain !== "function") throw new Error("Explicit terrain ownership is required");
  return {
    paintRect(x: number, y: number, width: number, height: number): BaseForegroundRectangle {
      const batch = input.materials.resolve(x, y, width, height), length = width * height;
      const pixels = new Uint8ClampedArray(length * 4), classifications = new Uint8Array(length);
      let unresolvedCount = 0;
      for (let row = 0, i = 0; row < height; row++) for (let col = 0; col < width; col++, i++) {
        const wx = x + col, wy = y + row, status = batch.classifications[i];
        if (!input.ownsTerrain(wx, wy)) { classifications[i] = ForegroundClassification.outsideOwnership; continue; }
        let rgba = 0;
        if (status <= M.forceAir) {
          rgba = materialRGBA(input.atlas, batch.materials[i], wx, wy);
          classifications[i] = ForegroundClassification.material;
        } else if (status <= M.unsupportedTopology && input.legacy) {
          rgba = input.legacy.colorAt(wx, wy);
          classifications[i] = rgba ? ForegroundClassification.legacyColor : ForegroundClassification.legacyAir;
        } else {
          classifications[i] = ForegroundClassification.unresolved;
          unresolvedCount++;
          continue;
        }
        const p = i * 4;
        pixels[p] = (rgba >>> 16) & 255; pixels[p + 1] = (rgba >>> 8) & 255;
        pixels[p + 2] = rgba & 255; pixels[p + 3] = rgba >>> 24;
      }
      return { x, y, width, height, pixels, classifications, materialClassifications: batch.classifications.slice(), materials: batch.materials.slice(), unresolvedCount };
    },
  };
}
