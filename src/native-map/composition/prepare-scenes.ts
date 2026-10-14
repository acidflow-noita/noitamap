// Adapted from Lymm Telescope's pixel_scene_generation.js (MIT) and the
// Noitamap native scene compositor (GPL-3.0). See NOTICE.txt.
import type {
  CompleteMaterialResolver,
  MaterialCoveragePoint,
} from "../complete-materials";
import {
  materialAlpha,
  materialTexelRGBA,
  type NativeMaterialAtlas,
} from "../cook-inputs/atlas";
import type { PixelBytes, PixelImage, PreparedScene } from "./types";

export interface NativeScenePlacement {
  key: string;
  name: string;
  variantKey?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface NativeSceneSource extends PixelImage {
  skipEdgeTextures?: boolean;
  visualArt?: PixelImage | null;
  backgroundArt?: PixelImage | null;
}
export interface PreparedNativeScene
  extends PreparedScene, NativeScenePlacement {}

/** Immutable tables and one explicit owned band resolver. The native scene
 * contract always uses material recoloring. No global settings/init are read. */
export interface NativeScenePreparationResources {
  atlas: NativeMaterialAtlas;
  generatorConfig: Readonly<Record<string, { color: number }>>;
  /** Exact compiled ordering: a band's biomeId is this array's zero-based index. */
  engineBiomes: ReadonlyArray<{ color: number; bands: ReadonlyArray<unknown> }>;
  materialNames: ReadonlyArray<string>;
  wangMaterialIds: ReadonlyArray<readonly [number, number]>;
  fillBiomeMaterials: Readonly<Record<number, string>>;
  fillLayerMaterials: Readonly<Record<number, string>>;
  biomeBackgroundColors: Readonly<Record<string, number>>;
  biomeForegroundColors: Readonly<Record<string, number>>;
  bands: Pick<CompleteMaterialResolver, "resolveCoverageBandPoints">;
}

interface Recipe {
  entry: number;
  flat: number;
  alpha: number;
}
const SCENE_UNTOUCHED = -2;
const UNKNOWN_MATERIAL = 0x7ffe;
const BAND_BATCH = 4096;

function assertImage(image: PixelImage, label: string) {
  if (
    !image ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !Number.isSafeInteger(image.width * image.height * 4) ||
    !(
      image.data instanceof Uint8Array ||
      image.data instanceof Uint8ClampedArray
    ) ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error(`Invalid ${label} image`);
}

/** Resolve COMPLETE scene instances in their original placement order. Source
 * pixels are cleaned material instructions, not an already recolored overlay.
 * Color and material answers intentionally remain separate for edges. */
export function createNativeScenePreparer(
  resources: NativeScenePreparationResources,
): (
  placement: NativeScenePlacement,
  source: NativeSceneSource,
) => PreparedNativeScene {
  const {
    atlas,
    generatorConfig,
    engineBiomes,
    materialNames,
    fillBiomeMaterials,
    fillLayerMaterials,
    biomeBackgroundColors,
    biomeForegroundColors,
    bands,
  } = resources;
  if (
    !atlas ||
    !bands ||
    typeof bands.resolveCoverageBandPoints !== "function" ||
    !engineBiomes ||
    !materialNames ||
    !generatorConfig ||
    !fillBiomeMaterials ||
    !fillLayerMaterials ||
    !biomeBackgroundColors ||
    !biomeForegroundColors ||
    !resources.wangMaterialIds
  )
    throw new Error("Complete scene preparation resources are required");
  const engineByColor = new Map(
    engineBiomes.map((biome, id) => [biome.color & 0xffffff, id]),
  );
  const materialIds = new Map(materialNames.map((name, id) => [name, id]));
  const wangIds = new Map(resources.wangMaterialIds);
  const wangNames = new Map(
    Object.entries(atlas.materialColorLookup).map(([hex, name]) => [
      parseInt(hex, 16) & 0xffffff,
      name,
    ]),
  );
  const materialDisplayColor = (name: string) => {
    const wang = parseInt(atlas.materialWangColors[name], 16) & 0xffffff;
    return atlas.materialColorConversion[wang] ?? wang;
  };
  const fillMaterial = (
    name: string | null,
    table: Readonly<Record<number, string>>,
  ) => {
    const config = name ? generatorConfig[name] : undefined;
    return config ? table[config.color & 0xffffff] : undefined;
  };
  const fillColor = (
    name: string | null,
    table: Readonly<Record<number, string>>,
  ) => {
    const material = fillMaterial(name, table);
    return material === undefined ? undefined : materialDisplayColor(material);
  };
  const densityBiome = (names: readonly (string | null)[]) => {
    for (const name of names) {
      const config = name ? generatorConfig[name] : undefined;
      const id = config
        ? engineByColor.get(config.color & 0xffffff)
        : undefined;
      // A scene's coverage is literal 1.0; topology support is irrelevant here.
      if (id !== undefined && engineBiomes[id].bands.length) return id;
    }
    return undefined;
  };

  return (placement, source) => {
    assertImage(source, `scene ${placement.key}`);
    if (
      ![placement.x, placement.y, placement.width, placement.height].every(
        Number.isSafeInteger,
      ) ||
      source.width !== placement.width ||
      source.height !== placement.height
    )
      throw new Error(`Scene placement/source bounds differ: ${placement.key}`);
    if (source.visualArt) assertImage(source.visualArt, "scene visual art");
    if (source.backgroundArt)
      assertImage(source.backgroundArt, "scene background art");
    const { width, height } = source,
      count = width * height;
    const raw = new Uint8Array(source.data);
    let biome = placement.key.split("/")[0];
    // Replacements are ordered operations, including on transparent RGB bytes.
    // Cascades such as A->B followed by B->C must not become a lookup map.
    for (const part of (placement.variantKey ?? "").split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq) === "biome") biome = part.slice(eq + 1);
      else {
        const from = parseInt(part.slice(0, eq), 16) & 0xffffff;
        const to = parseInt(part.slice(eq + 1), 16) & 0xffffff;
        for (let i = 0; i < raw.length; i += 4)
          if (((raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]) === from) {
            raw[i] = to >>> 16;
            raw[i + 1] = (to >>> 8) & 255;
            raw[i + 2] = to & 255;
          }
      }
    }
    const at = biome.indexOf("@"),
      targetBiome = at < 0 ? biome : biome.slice(0, at);
    const underlyingBiome = at < 0 ? null : biome.slice(at + 1);
    const colorNames = [targetBiome, underlyingBiome];
    // The current signed-grid path splits every suffix; retain that distinction
    // even for a supplied variant containing more than one @ separator.
    const gridNames = biome.split("@");
    const colorDensityBiome = densityBiome(colorNames),
      gridDensityBiome = densityBiome(gridNames);
    const targetColor =
      fillColor(targetBiome, fillBiomeMaterials) ??
      biomeForegroundColors[targetBiome] ??
      (underlyingBiome
        ? (fillColor(underlyingBiome, fillBiomeMaterials) ??
          biomeForegroundColors[underlyingBiome])
        : undefined) ??
      0xff00ff;
    let backgroundColor =
      biomeBackgroundColors[targetBiome] ??
      (underlyingBiome ? biomeBackgroundColors[underlyingBiome] : undefined) ??
      0;
    const underlyingFill =
      underlyingBiome &&
      fillColor(underlyingBiome, fillLayerMaterials) !== undefined
        ? underlyingBiome
        : null;
    const under = fillColor(underlyingFill ?? targetBiome, fillLayerMaterials);
    if (
      under !== undefined &&
      Math.max(
        Math.abs(((backgroundColor >>> 16) & 255) - ((under >>> 16) & 255)),
        Math.abs(((backgroundColor >>> 8) & 255) - ((under >>> 8) & 255)),
        Math.abs((backgroundColor & 255) - (under & 255)),
      ) <= 24
    )
      backgroundColor =
        (Math.round(((under >>> 16) & 255) * 0.45) << 16) |
        (Math.round(((under >>> 8) & 255) * 0.45) << 8) |
        Math.round((under & 255) * 0.45);

    const recipes = new Map<string, Recipe>();
    const recipeFor = (name: string, fallback: number): Recipe => {
      let recipe = recipes.get(name);
      if (!recipe) {
        const known = atlas.materialWangColors[name] !== undefined;
        recipe = {
          entry: atlas.entryByMaterial.get(name) ?? 0,
          flat: known ? materialDisplayColor(name) : fallback,
          alpha: known ? materialAlpha(atlas, name) : 255,
        };
        recipes.set(name, recipe);
      }
      return recipe;
    };
    const colorFillName = colorNames
      .map((name) => fillMaterial(name, fillBiomeMaterials))
      .find((name) => name !== undefined);
    const fillRecipe =
      colorFillName !== undefined
        ? recipeFor(colorFillName, targetColor)
        : { entry: 0, flat: targetColor, alpha: 255 };
    const gridFillName = gridNames
      .map((name) => fillMaterial(name, fillBiomeMaterials))
      .find((name) => name !== undefined);
    const gridFillId =
      gridFillName === undefined
        ? UNKNOWN_MATERIAL
        : (materialIds.get(gridFillName) ?? UNKNOWN_MATERIAL);
    const grayPixels: number[] = [];
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      if (
        raw[i + 3] &&
        raw[i] > 0 &&
        raw[i] === raw[i + 1] &&
        raw[i + 1] === raw[i + 2]
      )
        grayPixels.push(p);
    }
    const resolveDensity = (biomeId: number | undefined) => {
      if (biomeId === undefined) return null;
      const values = new Int32Array(grayPixels.length);
      for (let from = 0; from < grayPixels.length; from += BAND_BATCH) {
        const size = Math.min(BAND_BATCH, grayPixels.length - from);
        const points: MaterialCoveragePoint[] = Array.from(
          { length: size },
          (_, i) => {
            const p = grayPixels[from + i];
            return {
              biomeId,
              x: placement.x + (p % width),
              y: placement.y + Math.floor(p / width),
              coverage: 1,
            };
          },
        );
        const result = bands.resolveCoverageBandPoints(points);
        if (
          !(result instanceof Int32Array) ||
          result.length !== size ||
          result.some((id) => id < -1 || id > 0x7fff)
        )
          throw new Error("Invalid scene density band result");
        values.set(result, from); // borrowed native output must be copied now
      }
      return values;
    };
    const colorDensity = resolveDensity(colorDensityBiome);
    const gridDensity =
      colorDensityBiome === gridDensityBiome
        ? colorDensity
        : resolveDensity(gridDensityBiome);
    const pixels = raw.slice(),
      sourceAlpha = new Uint8Array(count),
      grid = new Int16Array(count).fill(SCENE_UNTOUCHED);
    const artMask = source.visualArt
      ? new Uint8Array(Math.ceil(count / 8))
      : null;
    let eraseMask: Uint8Array | null = null,
      gray = 0;
    const erase = (p: number) => {
      eraseMask ??= new Uint8Array(raw.length);
      eraseMask[p * 4 + 3] = 255;
    };
    const wangRecipes = new Map<number, Recipe>();
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      sourceAlpha[p] = source.data[i + 3];
      if (!raw[i + 3]) continue;
      const rgb = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
      const x = p % width,
        y = Math.floor(p / width),
        wx = placement.x + x,
        wy = placement.y + y;
      const isGray =
        raw[i] > 0 && raw[i] === raw[i + 1] && raw[i + 1] === raw[i + 2];
      grid[p] =
        rgb === 0x42
          ? 0
          : isGray
            ? gridDensity
              ? Math.max(0, gridDensity[gray])
              : gridFillId
            : (wangIds.get(rgb) ?? UNKNOWN_MATERIAL);
      const art = source.visualArt;
      if (
        artMask &&
        art &&
        x < art.width &&
        y < art.height &&
        art.data[(y * art.width + x) * 4 + 3] >= 128
      )
        artMask[p >> 3] |= 0x80 >> (p & 7);
      if (rgb === 0x42) {
        // Native terrain always applies applySceneForceAir after the texture
        // painter, overriding the legacy opaque-air display exceptions.
        pixels[i] = (backgroundColor >>> 16) & 255;
        pixels[i + 1] = (backgroundColor >>> 8) & 255;
        pixels[i + 2] = backgroundColor & 255;
        pixels[i + 3] = 0;
        erase(p);
        continue;
      }
      let recipe: Recipe;
      if (isGray) {
        const id = colorDensity ? colorDensity[gray] : undefined;
        gray++;
        if (id !== undefined && id < 0) {
          pixels[i + 3] = 0;
          erase(p);
          continue;
        }
        const name = id === undefined ? null : materialNames[id];
        recipe = name ? recipeFor(name, targetColor) : fillRecipe;
      } else {
        let known = wangRecipes.get(rgb);
        if (!known) {
          const name = wangNames.get(rgb),
            flat = atlas.materialColorConversion[rgb] ?? rgb;
          known = name ? recipeFor(name, flat) : { entry: 0, flat, alpha: 255 };
          wangRecipes.set(rgb, known);
        }
        recipe = known;
      }
      let alpha = recipe.alpha;
      if (recipe.entry > 0) {
        const texel = materialTexelRGBA(atlas, recipe.entry, wx, wy);
        // Transparent atlas cells do not create a new erase instruction. Their
        // original instruction RGB and separate material identity survive.
        if (texel < 0) {
          pixels[i + 3] = 0;
          continue;
        }
        alpha = (texel >>> 24) & 255;
        pixels[i] = (texel >>> 16) & 255;
        pixels[i + 1] = (texel >>> 8) & 255;
        pixels[i + 2] = texel & 255;
      } else {
        pixels[i] = (recipe.flat >>> 16) & 255;
        pixels[i + 1] = (recipe.flat >>> 8) & 255;
        pixels[i + 2] = recipe.flat & 255;
      }
      if (alpha < 255) {
        pixels[i + 3] = alpha;
        erase(p);
      }
    }
    if (source.visualArt)
      applyVisualArt(pixels, width, height, source.visualArt);
    return {
      ...placement,
      pixels,
      eraseMask,
      sourceAlpha,
      backgroundArt: source.backgroundArt ?? null,
      edge: {
        x: placement.x,
        y: placement.y,
        width,
        height,
        grid,
        artMask,
        skipEdges: !!source.skipEdgeTextures,
      },
    };
  };
}

/** Resolve one whole scene without retaining any expanded neighboring scenes. */
export function prepareNativeScene(
  placement: NativeScenePlacement,
  source: NativeSceneSource,
  resources: NativeScenePreparationResources,
): PreparedNativeScene {
  return createNativeScenePreparer(resources)(placement, source);
}

/** Convenience for an explicitly bounded batch. Streaming cookers should reuse
 * createNativeScenePreparer and cache completed instances under their own budget. */
export function prepareNativeScenes(
  placements: readonly NativeScenePlacement[],
  sources: Readonly<Record<string, NativeSceneSource>>,
  resources: NativeScenePreparationResources,
): PreparedNativeScene[] {
  const prepare = createNativeScenePreparer(resources);
  return placements.map((placement) =>
    prepare(placement, sources[placement.key]),
  );
}

function applyVisualArt(
  pixels: PixelBytes,
  width: number,
  height: number,
  art: PixelImage,
) {
  for (let y = 0; y < Math.min(height, art.height); y++)
    for (let x = 0; x < Math.min(width, art.width); x++) {
      const d = (y * width + x) * 4;
      if (!pixels[d + 3]) continue;
      const s = (y * art.width + x) * 4,
        alpha = art.data[s + 3];
      for (let c = 0; c < 3; c++)
        pixels[d + c] =
          ((art.data[s + c] * alpha + pixels[d + c] * (255 - alpha) + 127) /
            255) |
          0;
      if (alpha === 255) pixels[d + 3] = 255;
    }
}
