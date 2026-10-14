import type { NativeAssets } from "../asset-host";
import type { NativeTerrainDescription } from "../world";
import type {
  CookGeneratorConfig,
  PreparedMaterialInputs,
  VerticalPlane,
} from "../cook-inputs/materials";
import { MATERIAL_NAMES_BY_ID } from "../complete-materials/engine-data.mjs";
import { GENERATOR_CONFIG } from "../rules/generator_config.js";
import { SKIP_SEAM_EDGE_BIOMES } from "../rules/pixel_scene_edge_flags.js";
import { decodePngToRgba } from "../png";
import { buildEdgeTablesAsync, EDGE_ATLAS_WIDTH } from "./edge-tables";
import { createStrictEdgeStamper } from "./strict-edges";
import { findLiquidSurfaces, liquidMaterialIds } from "./liquid-inputs";
import {
  BIOME_BACKGROUND_MAP,
  createBackgroundOwnership,
  createPlaneOwnership,
  sceneBiomeNames,
  WORLD_HEIGHT,
  type TerrainOwnership,
} from "./world-policy";
import type { PixelBytes, PixelImage, PreparedScene } from "./types";
import type { NativeScenePlacement } from "./prepare-scenes";

export interface WorldCompositionResourceOptions {
  edgeModule: BufferSource | WebAssembly.Module;
  scenes: readonly Pick<NativeScenePlacement, "key" | "variantKey">[];
  generatorConfig?: CookGeneratorConfig;
  /** Otherwise read the explicit data/materials.xml asset, including inheritance. */
  liquidMaterialIds?: ReadonlySet<number>;
  /** Optional explicit policy edits before background ownership is derived. */
  ownershipPolicy?: (ownership: TerrainOwnership, plane: VerticalPlane) => void;
}
const mod = (value: number, size: number) => ((value % size) + size) % size;
function textureColor(texture: PixelImage, x: number, y: number) {
  const p =
      (mod(y, texture.height) * texture.width + mod(x, texture.width)) * 4,
    a = texture.data;
  return ((a[p + 3] << 24) | (a[p] << 16) | (a[p + 1] << 8) | a[p + 2]) >>> 0;
}

/** Scene fill/air colors are named biome-map lookups, distinct from legacy
 * terrain's numeric-color override map. Preserve last source-pixel wins. */
export async function loadSceneBiomeColors(
  assets: NativeAssets,
  config: CookGeneratorConfig = GENERATOR_CONFIG,
) {
  // These are the deployed game images. The fork's convenience biome_maps
  // copies differ (notably Water Cave) and are not interchangeable inputs.
  const paths = [
    "data/biome_impl/biome_map.png",
    "data/biome_impl/biome_map_background.png",
    "data/biome_impl/biome_map_foreground.png",
  ];
  const [base, background, foreground] = await Promise.all(
    paths.map(async (path) =>
      decodePngToRgba(Uint8Array.from(await assets.read(path)).buffer),
    ),
  );
  if (
    [background, foreground].some(
      (image) => image.width !== base.width || image.height !== base.height,
    )
  )
    throw new Error("Scene biome color-map dimensions differ");
  const names = new Map(
    Object.entries(config).map(([name, value]) => [
      value.color & 0xffffff,
      name,
    ]),
  );
  const lookup = (image: PixelImage) => {
    const out: Record<string, number> = {};
    for (let i = 0; i < base.data.length; i += 4) {
      const name = names.get(
        (base.data[i] << 16) | (base.data[i + 1] << 8) | base.data[i + 2],
      );
      if (name)
        out[name] =
          (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    }
    out.temple_altar_right_snowcave = 0x4e4132;
    out.temple_altar_right_snowcastle = 0x4e4133;
    return out;
  };
  return {
    biomeBackgroundColors: lookup(background),
    biomeForegroundColors: lookup(foreground),
  };
}

/** LSB-first source ownership bits; caller decides which placements are static. */
export function staticSceneBits(
  data: PixelBytes,
  forceAir = false,
): Uint8Array {
  if (data.length % 4) throw new Error("Invalid static scene RGBA length");
  const bits = new Uint8Array(Math.ceil(data.length / 4 / 8));
  for (let p = 0; p < data.length / 4; p++) {
    const i = p * 4,
      air = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 66;
    if (
      data[i + 3] &&
      (data[i] || data[i + 1] || data[i + 2]) &&
      air === forceAir
    )
      bits[p >> 3] |= 1 << (p & 7);
  }
  return bits;
}

/** The canonical chunk center always has subX=subY=256 in the source resolver:
 * centerX=cx*512-(mapWidth*256)%512+256 and centerY=cy*512+256.
 * It therefore returns before all biome-edge noise probes. This direct lookup
 * preserves its wrapped column and clamped ABSOLUTE row, including all planes. */
export function createSeamPolicy(pixels: ArrayLike<number>, mapWidth: number) {
  if (
    !Number.isSafeInteger(mapWidth) ||
    mapWidth <= 0 ||
    pixels.length !== mapWidth * 48
  )
    throw new Error("Invalid seam-policy biome map");
  return (cx: number, cy: number): boolean => {
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy))
      throw new Error("Invalid seam chunk coordinates");
    const column = mod(cx + Math.floor(mapWidth / 2), mapWidth),
      row = Math.max(0, Math.min(47, cy + 14));
    return SKIP_SEAM_EDGE_BIOMES.has(
      (pixels[row * mapWidth + column] ?? 0) & 0xffffff,
    );
  };
}

/** Complete shared composition setup from owned world geometry and explicit
 * assets. No Telescope runtime, reference policy callbacks or DOM are needed. */
export async function createWorldCompositionResources(
  world: NativeTerrainDescription,
  materials: PreparedMaterialInputs,
  assets: NativeAssets,
  options: WorldCompositionResourceOptions,
) {
  const width = materials.mapWidth,
    config = options.generatorConfig ?? GENERATOR_CONFIG;
  if (
    world.worldSize !== width ||
    materials.sourceBiomePixels.length !== width * 48
  )
    throw new Error("Composition/world material geometry differs");
  const [atlas, tables, colors, liquids] = await Promise.all([
    assets.read("data/edge_atlas.bin"),
    buildEdgeTablesAsync(),
    loadSceneBiomeColors(assets, config),
    options.liquidMaterialIds
      ? Promise.resolve(options.liquidMaterialIds)
      : assets
          .read("data/materials.xml")
          .then((bytes) =>
            liquidMaterialIds(
              new TextDecoder().decode(bytes),
              MATERIAL_NAMES_BY_ID,
            ),
          ),
  ]);
  const edgeStamper = await createStrictEdgeStamper(options.edgeModule, {
    tables,
    atlas,
    atlasWidth: EDGE_ATLAS_WIDTH,
  });
  const planes = new Map<
    VerticalPlane,
    {
      ownership: TerrainOwnership;
      backgroundOwnership: TerrainOwnership;
      pixels: ArrayLike<number>;
    }
  >();
  const names = new Set<string>();
  for (const plane of [-1, 0, 1] as const) {
    const pixels = materials.forPlane(plane).biomePixels;
    if (!(pixels instanceof Uint32Array))
      throw new Error("Composition needs a complete Uint32 biome map");
    const ownership = createPlaneOwnership(
      world.tileLayers,
      materials.sourceBiomePixels,
      pixels,
      config,
      width,
    );
    if (plane === 1 && world.elevatorShafts?.length) {
      let id = ownership.names.indexOf("robobase");
      if (id < 0) {
        id = ownership.names.length;
        ownership.names.push("robobase");
      }
      for (const shaft of world.elevatorShafts) {
        const column = shaft.minX;
        if (
          shaft.biomeName !== "robobase" ||
          !shaft.buffer ||
          !Number.isInteger(column) ||
          column < 0 ||
          column >= width
        )
          throw new Error("Invalid continued elevator ownership");
        for (let row = 0; row < 48; row++)
          ownership.owners[row * width + column] = id;
      }
    }
    options.ownershipPolicy?.(ownership, plane);
    const backgroundOwnership = createBackgroundOwnership(
      ownership,
      pixels,
      config,
      plane,
    );
    for (const name of backgroundOwnership.names) names.add(name);
    planes.set(plane, { ownership, backgroundOwnership, pixels });
  }
  const sceneBackgroundName = (
    scene: Pick<NativeScenePlacement, "key" | "variantKey">,
  ) => sceneBiomeNames(scene).find((name) => BIOME_BACKGROUND_MAP[name]);
  for (const scene of options.scenes) {
    const name = sceneBackgroundName(scene);
    if (name) names.add(name);
  }
  const textures = new Map<string, PixelImage>(),
    byPath = new Map<string, Promise<PixelImage>>();
  for (const name of names) {
    const path = BIOME_BACKGROUND_MAP[name];
    if (!path) continue; // authored sky/clouds reveal the static backdrop
    let work = byPath.get(path);
    if (!work) {
      work = assets
        .read(path)
        .then((bytes) => decodePngToRgba(Uint8Array.from(bytes).buffer));
      byPath.set(path, work);
    }
    textures.set(name, await work);
  }
  const contexts = new Map<VerticalPlane, ReturnType<typeof planeContext>>();
  function planeContext(plane: VerticalPlane) {
    const state = planes.get(plane);
    if (!state) throw new Error("Unknown composition plane");
    const offsetY = plane * WORLD_HEIGHT,
      { ownership, backgroundOwnership, pixels } = state;
    return {
      ownership,
      backgroundOwnership,
      chunkShiftX: (width * 256) % 512,
      chunkShiftY: 0,
      ownsTerrain: (x: number, y: number) => ownership.at(x, y - offsetY) >= 0,
      backgroundAt(x: number, y: number) {
        const owner = backgroundOwnership.at(x, y - offsetY);
        const texture =
          owner < 0
            ? undefined
            : textures.get(backgroundOwnership.names[owner]);
        return texture
          ? textureColor(texture, x + width * 256, y - offsetY + 7168)
          : 0;
      },
      sceneAirBackground(
        scene: PreparedScene &
          Partial<Pick<NativeScenePlacement, "key" | "variantKey">>,
        x: number,
        y: number,
      ) {
        if (!scene.key)
          throw new Error(
            "Scene air background needs original placement metadata",
          );
        const name = sceneBackgroundName({
          key: scene.key,
          variantKey: scene.variantKey,
        });
        const texture = name ? textures.get(name) : undefined;
        if (name && !texture)
          throw new Error(`Unprepared scene air background: ${name}`);
        return texture
          ? textureColor(texture, x + width * 256, y - offsetY + 7168)
          : 0;
      },
      liquidSurfaces: findLiquidSurfaces(
        materials.forPlane(plane).lattice,
        new Set(liquids),
        width,
        offsetY,
      ),
      skipSeamAt: createSeamPolicy(pixels, width),
    };
  }
  return {
    ...colors,
    edgeStamper,
    forPlane(plane: VerticalPlane) {
      let context = contexts.get(plane);
      if (!context) {
        context = planeContext(plane);
        contexts.set(plane, context);
      }
      return context;
    },
  };
}
