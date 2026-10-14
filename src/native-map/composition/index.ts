import Flatbush from "flatbush";
import { createLiquidPainter } from "./liquids";
import { compositeRGBA, readRGBA, writeRGBA } from "./pixels";
import type {
  CompositionPage,
  PageCompositionInputs,
  PixelBytes,
  PixelImage,
  PreparedScene,
  StaticMask,
} from "./types";

export type * from "./types";
export { compositeRGBA, readRGBA, writeRGBA } from "./pixels";
export { createStrictEdgeStamper } from "./strict-edges";
export type { PreparedEdgeTables, StrictEdgeResources } from "./strict-edges";
export {
  createNativeScenePreparer,
  prepareNativeScene,
  prepareNativeScenes,
} from "./prepare-scenes";
export type {
  NativeScenePlacement,
  NativeSceneSource,
  PreparedNativeScene,
  NativeScenePreparationResources,
} from "./prepare-scenes";
export { createSceneSourceLoader } from "./scene-source-loader";
export type {
  SceneSourceLoader,
  SceneSourceLoaderOptions,
  LoadedNativeSceneSource,
} from "./scene-source-loader";
export { nativeSceneSourceDefinitions } from "./scene-source-definitions";
export type { NativeSceneSourceDefinition } from "./scene-source-definitions";
export {
  createWorldCompositionResources,
  createSeamPolicy,
  loadSceneBiomeColors,
  staticSceneBits,
} from "./world-resources";
export type { WorldCompositionResourceOptions } from "./world-resources";

/** Kept identical to the owned stamper's reference output/scan layout. */
export const EDGE_OUTPUT_HALO = 32;

function assertRect(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
) {
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    width < 1 ||
    height < 1 ||
    Math.abs(x) >= 0x3ffff000 ||
    Math.abs(y) >= 0x3ffff000 ||
    !Number.isSafeInteger(width * height)
  )
    throw new Error(`Invalid ${label} bounds`);
}
function assertPixels(data: PixelBytes, count: number, label: string) {
  if (
    !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
    data.length !== count * 4
  )
    throw new Error(`Invalid ${label} RGBA bytes`);
}
function validateScene(scene: PreparedScene) {
  assertRect(scene.x, scene.y, scene.width, scene.height, "scene");
  const count = scene.width * scene.height;
  assertPixels(scene.pixels, count, "scene");
  if (scene.eraseMask !== null)
    assertPixels(scene.eraseMask, count, "scene erase mask");
  if (
    !(scene.sourceAlpha instanceof Uint8Array) ||
    scene.sourceAlpha.length !== count
  )
    throw new Error("Missing original scene alpha coverage");
  if (scene.backgroundArt !== null) {
    const art = scene.backgroundArt;
    if (!art)
      throw new Error(
        "Scene backgroundArt must explicitly be an image or null",
      );
    assertRect(0, 0, art.width, art.height, "scene background");
    assertPixels(art.data, art.width * art.height, "scene background");
  }
  const edge = scene.edge;
  if (
    !edge ||
    edge.x !== scene.x ||
    edge.y !== scene.y ||
    edge.width !== scene.width ||
    edge.height !== scene.height ||
    !(edge.grid instanceof Int16Array) ||
    edge.grid.length !== count ||
    (edge.artMask && edge.artMask.length !== Math.ceil(count / 8))
  )
    throw new Error(
      "Scene requires a complete matching signed material/art grid",
    );
}
function validateMask(mask: StaticMask) {
  assertRect(mask.x, mask.y, mask.width, mask.height, "static mask");
  const length = Math.ceil((mask.width * mask.height) / 8);
  if (
    !(mask.bits instanceof Uint8Array) ||
    mask.bits.length !== length ||
    (mask.airBits !== undefined &&
      (!(mask.airBits instanceof Uint8Array) || mask.airBits.length !== length))
  )
    throw new Error("Invalid static ownership bits");
}
function spatialIndex<T>(
  items: readonly T[],
  bounds: (item: T) => readonly [number, number, number, number],
) {
  if (!items.length) return null;
  const index = new Flatbush(items.length);
  for (const item of items) index.add(...bounds(item));
  index.finish();
  return index;
}
function blit(
  image: PixelImage,
  scene: PreparedScene,
  tile: Uint8ClampedArray,
  page: CompositionPage,
  eraseMask?: PixelBytes | null,
) {
  const left = Math.max(page.x, scene.x),
    top = Math.max(page.y, scene.y);
  const right = Math.min(page.x + page.width, scene.x + image.width);
  const bottom = Math.min(page.y + page.height, scene.y + image.height);
  for (let wy = top; wy < bottom; wy++)
    for (let wx = left; wx < right; wx++) {
      const s = ((wy - scene.y) * image.width + wx - scene.x) * 4;
      const d = ((wy - page.y) * page.width + wx - page.x) * 4;
      writeRGBA(
        tile,
        d,
        compositeRGBA(
          readRGBA(image.data, s),
          eraseMask?.[s + 3] ? 0 : readRGBA(tile, d),
        ),
      );
    }
}

/** One independent, synchronous page function. Callers keep all inputs immutable
 * for the composer's lifetime. Only private foreground/background/material arrays
 * are mutated, so failure never publishes a partially finished page. */
export function createPageComposer(
  input: PageCompositionInputs,
): (page: CompositionPage) => Uint8ClampedArray {
  if (
    !Number.isSafeInteger(input.seed) ||
    !Number.isSafeInteger(input.worldWidth) ||
    input.worldWidth <= 0
  )
    throw new Error("Invalid composition world/seed");
  if (
    ![input.chunkShiftX, input.chunkShiftY].every(
      (n) => Number.isSafeInteger(n) && Math.abs(n) < 512,
    )
  )
    throw new Error("Invalid composition chunk shifts");
  for (const name of [
    "materialAt",
    "ownsTerrain",
    "backgroundAt",
    "liquidColor",
    "sceneAirBackground",
    "skipSeamAt",
  ] as const)
    if (typeof input[name] !== "function")
      throw new Error(`Missing composition input: ${name}`);
  if (!input.edgeStamper || typeof input.edgeStamper.stamp !== "function")
    throw new Error("A complete edge stamper is required");
  const pad = EDGE_OUTPUT_HALO,
    reach = input.edgeStamper.stampReach;
  if (!Number.isSafeInteger(reach) || reach < 0 || reach + 4 > pad)
    throw new Error("Unsupported edge reach for the canonical page halo");
  const unusedHalo = pad - reach - 4;
  for (const scene of input.scenes) validateScene(scene);
  for (const mask of input.staticMasks) validateMask(mask);
  const sceneIndex = spatialIndex(input.scenes, (s) => [
    s.x,
    s.y,
    s.x + Math.max(s.width, s.backgroundArt?.width ?? 0),
    s.y + Math.max(s.height, s.backgroundArt?.height ?? 0),
  ]);
  const edgeIndex = spatialIndex(input.scenes, (s) => [
    s.x,
    s.y,
    s.x + s.width,
    s.y + s.height,
  ]);
  const maskIndex = spatialIndex(input.staticMasks, (m) => [
    m.x,
    m.y,
    m.x + m.width,
    m.y + m.height,
  ]);
  const water = createLiquidPainter(input.liquidSurfaces, input.worldWidth);
  const originalMaterial = (x: number, y: number) => {
    const id = input.materialAt(x, y);
    if (!Number.isInteger(id) || id < -1 || id > 0x7fff)
      throw new Error(`Unresolved original material at ${x},${y}: ${id}`);
    return id;
  };
  return (page) => {
    const { x, y, width, height } = page;
    assertRect(x, y, width, height, "page");
    if (width + pad * 2 > 640 || height + pad * 2 > 640)
      throw new Error("Page exceeds the owned edge stamper capacity");
    assertPixels(page.foreground, width * height, "foreground");
    if (page.background)
      assertPixels(page.background, width * height, "background");
    const pixels = new Uint8ClampedArray(page.foreground);
    const background = page.background
      ? new Uint8ClampedArray(page.background)
      : new Uint8ClampedArray(pixels.length);
    const canPaint = new Uint8Array(width * height);
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const p = row * width + col,
          wx = x + col,
          wy = y + row;
        if (input.ownsTerrain(wx, wy)) canPaint[p] = 1;
        else pixels.fill(0, p * 4, p * 4 + 4);
        if (!page.background)
          writeRGBA(background, p * 4, input.backgroundAt(wx, wy));
      }

    water(
      pixels,
      x,
      y,
      width,
      height,
      (wx, wy) => (input.ownsTerrain(wx, wy) ? originalMaterial(wx, wy) : -1),
      input.liquidColor,
    );

    const ids = (sceneIndex?.search(x, y, x + width, y + height) ?? []).sort(
      (a, b) => a - b,
    );
    // ALL scene backgrounds precede ANY scene foreground/erase, including when
    // background art extends outside the corresponding material rectangle.
    for (const id of ids) {
      const scene = input.scenes[id];
      if (scene.backgroundArt)
        blit(scene.backgroundArt, scene, background, page);
    }
    for (const id of ids) {
      const scene = input.scenes[id];
      blit(
        { data: scene.pixels, width: scene.width, height: scene.height },
        scene,
        pixels,
        page,
        scene.eraseMask,
      );
      const left = Math.max(x, scene.x),
        top = Math.max(y, scene.y);
      const right = Math.min(x + width, scene.x + scene.width),
        bottom = Math.min(y + height, scene.y + scene.height);
      for (let wy = top; wy < bottom; wy++)
        for (let wx = left; wx < right; wx++) {
          const s = (wy - scene.y) * scene.width + wx - scene.x;
          const p = (wy - y) * width + wx - x,
            d = p * 4;
          if (scene.sourceAlpha[s]) canPaint[p] = 1;
          if (scene.eraseMask?.[s * 4 + 3] && !background[d + 3])
            writeRGBA(background, d, input.sceneAirBackground(scene, wx, wy));
        }
    }

    const pw = width + pad * 2,
      ph = height + pad * 2,
      left = x - pad,
      top = y - pad;
    const materials = new Int16Array(pw * ph);
    if (input.readMaterials) {
      // A sentinel catches incomplete suppliers instead of manufacturing air.
      for (let row = unusedHalo; row < ph - unusedHalo; row++)
        materials.fill(
          -32768,
          row * pw + unusedHalo,
          (row + 1) * pw - unusedHalo,
        );
      input.readMaterials(
        left + unusedHalo,
        top + unusedHalo,
        pw - unusedHalo * 2,
        ph - unusedHalo * 2,
        { data: materials, stride: pw, offset: unusedHalo * pw + unusedHalo },
      );
      for (let row = unusedHalo; row < ph - unusedHalo; row++)
        for (let col = unusedHalo; col < pw - unusedHalo; col++)
          if (materials[row * pw + col] < -1)
            throw new Error(
              `Unresolved material rectangle at ${left + col},${top + row}`,
            );
    } else {
      for (let row = unusedHalo; row < ph - unusedHalo; row++)
        for (let col = unusedHalo; col < pw - unusedHalo; col++)
          materials[row * pw + col] = originalMaterial(left + col, top + row);
    }
    const edgeScenes = (edgeIndex?.search(left, top, left + pw, top + ph) ?? [])
      .sort((a, b) => a - b)
      .map((id) => input.scenes[id].edge);
    const decals = input.edgeStamper.stamp(
      materials,
      pw,
      ph,
      left,
      top,
      input.seed,
      {
        chunkShiftX: input.chunkShiftX,
        chunkShiftY: input.chunkShiftY,
        inset: pad,
        scenes: edgeScenes,
        skipSeamAt: input.skipSeamAt,
      },
    );
    assertPixels(decals, pw * ph, "edge result");
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const s = ((row + pad) * pw + col + pad) * 4,
          p = row * width + col,
          d = p * 4;
        if (decals[s + 3] && canPaint[p])
          writeRGBA(
            pixels,
            d,
            compositeRGBA(readRGBA(decals, s), readRGBA(pixels, d)),
          );
      }

    const masks = maskIndex?.search(x, y, x + width, y + height) ?? [];
    const clearStatic = (air: boolean) => {
      for (const id of masks) {
        const mask = input.staticMasks[id],
          bits = air ? mask.airBits : mask.bits;
        if (!bits) continue;
        for (
          let wy = Math.max(y, mask.y);
          wy < Math.min(y + height, mask.y + mask.height);
          wy++
        )
          for (
            let wx = Math.max(x, mask.x);
            wx < Math.min(x + width, mask.x + mask.width);
            wx++
          ) {
            const p = (wy - mask.y) * mask.width + wx - mask.x;
            if (bits[p >> 3] & (1 << (p & 7))) {
              const d = ((wy - y) * width + wx - x) * 4;
              pixels.fill(0, d, d + 4);
            }
          }
      }
    };
    clearStatic(true);
    for (let i = 0; i < pixels.length; i += 4)
      writeRGBA(
        pixels,
        i,
        compositeRGBA(readRGBA(pixels, i), readRGBA(background, i)),
      );
    clearStatic(false);
    return pixels;
  };
}
