import { includeElevatorOwnership } from "./terrain-elevator";
import { prepareTerrainPlane } from "./terrain-planes";
import {
  createPlaneOwnership,
  WORLD_HEIGHT,
  WORLD_TOP,
  type VerticalPlane,
} from "./terrain-policy";
import {
  clearGLTerrain,
  ensureGLTerrain,
  createGLTerrainTileSource,
  type GLTerrainGeneration,
  type GLTerrainDeps,
} from "./gl-terrain-tile-source";

/** The same three planes and ownership masks as the native daily renderer. */
export async function addFullPixelLayers(
  viewer: any,
  generation: GLTerrainGeneration & { parallelWorlds?: number[] },
  deps: GLTerrainDeps,
  isCurrent: () => boolean,
  onItem: (item: any) => void,
  firstPaint?: () => void,
) {
  clearGLTerrain();
  const { createTileOverlaysCheap } =
    await import("noita-telescope-full-pixels/image_processing.js");
  const osd = viewer.viewer || viewer;
  const width = deps.getWorldSize(generation.isNGP, generation.gameMode);
  const w = width * 512,
    h = WORLD_HEIGHT;
  const pws = [...(generation.parallelWorlds ?? [0, -1, 1])].sort(
    (a, b) => Math.abs(a) - Math.abs(b),
  );
  let count = 0;
  for (const plane of [0, -1, 1] as VerticalPlane[]) {
    const gen = await prepareTerrainPlane(generation, plane);
    if (!isCurrent()) return;
    if (!(await ensureGLTerrain(deps, gen)))
      throw new Error(
        `Full-resolution terrain failed for vertical plane ${plane}`,
      );
    const ownership = createPlaneOwnership(
      gen.tileLayers,
      (gen.sourceBiomeData ?? gen.biomeData).pixels,
      gen.biomeData.pixels,
      deps.GENERATOR_CONFIG,
      width,
    );
    includeElevatorOwnership(ownership, gen.elevatorShafts, gen.plane);
    const layers = createTileOverlaysCheap(
      gen.biomeData,
      gen.tileLayers,
      0,
      0,
      gen.isNGP,
      gen.gameMode,
    );
    const preview = new OffscreenCanvas(Math.ceil(w / 10), Math.ceil(h / 10));
    const ctx = preview.getContext("2d")!;
    // Strict footprint even in the temporary preview: no procedural fills in
    // static brown rock and no bounding-box-wide Winter Caves repaint.
    ctx.beginPath();
    for (let cy = 0; cy < 48; cy++)
      for (let cx = 0; cx < width; cx++)
        if (ownership.owners[cy * width + cx] >= 0)
          ctx.rect(cx * 51.2, cy * 51.2, 51.2, 51.2);
    ctx.clip();
    for (let i = 0; i < layers.length; i++)
      if (layers[i])
        ctx.drawImage(
          layers[i],
          gen.tileLayers[i].correctedX / 10,
          gen.tileLayers[i].correctedY / 10,
        );
    for (const pw of pws) {
      if (!isCurrent()) return;
      const x = -width * 256 + pw * w,
        y = WORLD_TOP + plane * h;
      const source = createGLTerrainTileSource({
        deps,
        gen,
        pw,
        worldX: x,
        worldY: y,
        worldW: w,
        worldH: h,
        preview,
        getFocus: () => osd.viewport.getCenter(true),
        onTileUpdate: (tile) => {
          if (tile.loaded && tile.tiledImage)
            void osd.world
              .requestTileInvalidateEvent([tile], Date.now(), true)
              .then(() => osd.forceRedraw());
          else osd.forceRedraw?.();
        },
      });
      viewer.addTiledImage({
        tileSource: source,
        x,
        y,
        width: w,
        blendTime: 0,
        success: ({ item }: any) => {
          if (isCurrent()) onItem(item);
          else osd.world.removeItem(item);
        },
      });
      if (count++ === 0) firstPaint?.();
    }
  }
}
