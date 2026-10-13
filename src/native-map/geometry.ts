import { BIOME_CONFIG, generateBiomeData } from "./biomes.js";
import { createTileGenerator } from "./tiles.js";
import { usesMinesTemplate } from "./pathfinding.js";

export { BIOME_CONFIG };

export interface GeometryImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface GeometryBiome {
  color: number;
  enabled?: boolean;
  wangFile?: string;
  wangData?: GeometryImage;
  offsetY?: number;
  extraRerolls?: number;
  randomColors?: Record<string, number[]>;
  fillMaterial?: string;
  sceneOnly?: boolean;
  [key: string]: unknown;
}

export interface TileGeometryInputs {
  biomes: Record<string, GeometryBiome>;
  /** Required when generating a non-Nightmare Mines-template region. */
  minesOverlay?: GeometryImage | null;
  blockedRoomColors: readonly number[];
  /** Keep the current HD renderer's bufferless constant-material layers. */
  fillLayers?: boolean;
}

export interface GeometryInputs extends TileGeometryInputs {
  biomeMaps: {
    ng0: Uint8Array | Uint8ClampedArray;
    ngp: Uint8Array | Uint8ClampedArray;
    nightmare: Uint8Array | Uint8ClampedArray | null;
  };
  /** Compatibility with the existing HD path's Nightmare+ cave clamp order.
   * Lymm uses false. This preserves a path, not a claim of game fidelity. */
  nightmarePlusPainter?: boolean;
}

export interface GeometryOptions {
  seed: number;
  ngPlus?: number;
  gameMode?: string;
  signal?: AbortSignal;
  yieldControl?: () => Promise<void> | void;
}

export interface TileGeometryOptions extends GeometryOptions {
  pixels: Uint32Array;
  width: number;
  height: number;
  extraRerolls?: number;
}

function snapshotImage(image: GeometryImage, label: string): GeometryImage {
  if (
    !Number.isInteger(image.width) ||
    image.width <= 0 ||
    !Number.isInteger(image.height) ||
    image.height <= 0 ||
    image.data?.length !== image.width * image.height * 4
  )
    throw new Error(`Invalid decoded geometry image: ${label}`);
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data),
  };
}

/** Own decoded inputs and algorithm workspace, with no DOM, fetch, archive or
 * application state. Source configuration order is significant for RNG output. */
export function createTerrainTileGenerator(inputs: TileGeometryInputs) {
  const images = new Map<GeometryImage, GeometryImage>();
  const biomes = Object.fromEntries(
    Object.entries(inputs.biomes).map(([name, biome]) => {
      let wangData = biome.wangData && images.get(biome.wangData);
      if (biome.wangData && !wangData) {
        wangData = snapshotImage(biome.wangData, name);
        images.set(biome.wangData, wangData);
      }
      if (biome.enabled && biome.wangFile && !wangData)
        throw new Error(`Missing decoded Wang template: ${name}`);
      return [
        name,
        {
          ...biome,
          wangData,
          ...(biome.randomColors
            ? {
                randomColors: Object.fromEntries(
                  Object.entries(biome.randomColors).map(([color, choices]) => [
                    color,
                    [...choices],
                  ]),
                ),
              }
            : {}),
        },
      ];
    }),
  );
  const minesOverlay = inputs.minesOverlay
    ? snapshotImage(inputs.minesOverlay, "Mines overlay")
    : null;
  const minesColors = new Set(
    Object.values(biomes)
      .filter((biome) => biome.enabled && usesMinesTemplate(biome.wangFile))
      .map((biome) => biome.color),
  );
  const generate = createTileGenerator({
    minesOverlay,
    blockedRoomColors: [...inputs.blockedRoomColors],
    fillLayers: inputs.fillLayers ?? false,
  });
  return async function generateTiles(options: TileGeometryOptions) {
    const {
      pixels,
      width,
      height,
      seed,
      ngPlus = 0,
      gameMode = "normal",
      signal,
      yieldControl,
      extraRerolls = 0,
    } = options;
    signal?.throwIfAborted();
    if (pixels.length !== width * height)
      throw new Error("Biome dimensions do not match the geometry input");
    if (
      !minesOverlay &&
      gameMode !== "nightmare" &&
      pixels.some((color) => minesColors.has(color))
    )
      throw new Error("Decoded Mines overlay is required for this template");
    const checkpoint =
      signal || yieldControl
        ? () => {
            signal?.throwIfAborted();
            const pending = yieldControl?.();
            if (!pending) signal?.throwIfAborted();
            return pending?.then(() => {
              signal?.throwIfAborted();
            });
          }
        : undefined;
    return generate(
      pixels,
      width,
      height,
      biomes,
      seed,
      ngPlus,
      extraRerolls,
      gameMode,
      checkpoint,
    );
  };
}

/** Geometry-only entrypoint. Scene selection, spawn scans and rendering remain
 * host stages and receive exactly the existing biome arrays and RGB layers. */
export function createGeometryGenerator(inputs: GeometryInputs) {
  const maps = {
    ng0: new Uint8Array(inputs.biomeMaps.ng0),
    ngp: new Uint8Array(inputs.biomeMaps.ngp),
    nightmare: inputs.biomeMaps.nightmare
      ? new Uint8Array(inputs.biomeMaps.nightmare)
      : null,
  };
  const nightmarePlusPainter = inputs.nightmarePlusPainter ?? false;
  const generateTiles = createTerrainTileGenerator(inputs);
  return {
    generateBiome(options: GeometryOptions) {
      options.signal?.throwIfAborted();
      const { seed, ngPlus = 0, gameMode = "normal" } = options;
      const width =
        ngPlus > 0 || gameMode === "nightmare"
          ? BIOME_CONFIG.W_NGP
          : BIOME_CONFIG.W_NG0;
      const height = BIOME_CONFIG.H_NG0;
      const base =
        ngPlus > 0
          ? maps.ngp
          : gameMode === "nightmare"
            ? maps.nightmare
            : maps.ng0;
      if (!base || base.length !== width * height * 4)
        throw new Error(
          `Missing or invalid decoded biome map: ${gameMode}, NG+${ngPlus}`,
        );
      return generateBiomeData(
        seed,
        ngPlus,
        gameMode,
        base,
        width,
        height,
        nightmarePlusPainter,
      );
    },
    generateTiles,
  };
}

export type GeometryGenerator = ReturnType<typeof createGeometryGenerator>;
