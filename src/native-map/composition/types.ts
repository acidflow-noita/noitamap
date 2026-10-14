import type { EdgeScene } from "../edges/types";

export type PixelBytes = Uint8Array | Uint8ClampedArray;
export interface PixelImage {
  width: number;
  height: number;
  data: PixelBytes;
}

/** Fully resolved at this placement, including ordered substitutions, density,
 * atlas phase, force-air and visual art. Array order is the original paint order.
 * Neither colors nor final alpha can substitute for the signed material grid. */
export interface PreparedScene {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: PixelBytes;
  /** RGBA instruction mask: a nonzero alpha erases old foreground first. */
  eraseMask: PixelBytes | null;
  /** One byte per original source pixel, before any material/color painting. */
  sourceAlpha: Uint8Array;
  /** Top-left anchored art may extend past the material scene's bounds. */
  backgroundArt: PixelImage | null;
  /** Full scene, including cells outside this page/halo. Art bits are MSB first.
   * -2 is untouched, 0 air, 0x7ffe unknown; positive IDs are actual materials.
   * edgeEligible, when present, is the WHOLE-scene predicate, not a tile crop. */
  edge: EdgeScene;
}

export interface StaticMask {
  x: number;
  y: number;
  width: number;
  height: number;
  /** One LSB-first bit per authored ordinary cell. */
  bits: Uint8Array;
  /** Separate LSB-first force-air bits, cleared before background composition. */
  airBits?: Uint8Array;
}

/** Global, already-connected lattice run. Coordinates are in the central world;
 * the painter repeats horizontally by worldWidth. Keep original sourceY. */
export interface LiquidSurface {
  left: number;
  right: number;
  y: number;
  material: number;
  sourceY?: number;
}

export interface MaterialRectTarget {
  data: Int16Array;
  stride: number;
  offset?: number;
}
export type ReadMaterialRect = (
  x: number,
  y: number,
  width: number,
  height: number,
  target: MaterialRectTarget,
) => void;

export interface EdgePaintOptions {
  chunkShiftX: number;
  chunkShiftY: number;
  inset: number;
  scenes: readonly EdgeScene[];
  /** Integer shifted chunk indices, not pixel coordinates. Must resolve the
   * source's center-biome seam policy even for chunks outside this page. */
  skipSeamAt: (chunkX: number, chunkY: number) => boolean;
}
export interface CompositionEdgeStamper {
  /** Exact maximum sprite reach including stripe displacement. */
  stampReach: number;
  stamp(
    materials: Int16Array,
    width: number,
    height: number,
    x: number,
    y: number,
    seed: number,
    options: EdgePaintOptions,
  ): Uint8ClampedArray;
}

export interface PageCompositionInputs {
  seed: number;
  worldWidth: number;
  scenes: readonly PreparedScene[];
  staticMasks: readonly StaticMask[];
  liquidSurfaces: readonly LiquidSurface[];
  /** Original material field, before scene, liquid or static-mask changes.
   * Liquid bottom probes can be outside the page and edge material halo. */
  materialAt: (x: number, worldY: number) => number;
  readMaterials?: ReadMaterialRect;
  ownsTerrain: (x: number, worldY: number) => boolean;
  /** Packed 0xAARRGGBB, using absolute texture phase and background ownership. */
  backgroundAt: (x: number, worldY: number) => number;
  liquidColor: (material: number, x: number, worldY: number) => number;
  /** Explicit scene air background policy; return 0 when there is none. */
  sceneAirBackground: (
    scene: PreparedScene,
    x: number,
    worldY: number,
  ) => number;
  edgeStamper: CompositionEdgeStamper;
  chunkShiftX: number;
  chunkShiftY: number;
  skipSeamAt: EdgePaintOptions["skipSeamAt"];
}

export interface CompositionPage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Raw foreground only, before background composition or finishing. */
  foreground: PixelBytes;
  /** Optional separate raw background carrier, before scene backgrounds. */
  background?: PixelBytes;
}
