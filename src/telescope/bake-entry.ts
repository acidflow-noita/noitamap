import { serializeTileLayer, restoreTileLayer } from "./tile-layer-cache";
import { prepareTerrainPlane } from "./terrain-planes";
import {
  TERRAIN_VERSION,
  WORLD_TOP,
  WORLD_HEIGHT,
  type VerticalPlane,
} from "./terrain-policy";

/** Exactly one seed/POI generation. Main and vertical terrain data are exported
 * read-only to all native renderer workers rather than regenerated per tile. */
export async function prepareBake(seed: number) {
  const { generateDynamicMap } = await import("./telescope-adapter");
  const generation = await generateDynamicMap({
    seed,
    ngPlus: 0,
    dailySeed: true,
    unlocks: null,
    parallelWorlds: [0, -1, 1],
  });
  const { serializeGenerationForBake } = await import("./baked-generation");
  const planes: Record<string, any> = {};
  for (const plane of [0, -1, 1] as VerticalPlane[]) {
    const data = await prepareTerrainPlane(generation, plane);
    planes[String(plane)] = {
      seed,
      isNGP: data.isNGP,
      gameMode: data.gameMode,
      plane,
      biomeData: data.biomeData,
      sourceBiomeData: data.sourceBiomeData,
      elevatorShafts: data.elevatorShafts?.map(serializeTileLayer),
      tileLayers: data.tileLayers.map(serializeTileLayer),
    };
  }
  const metadata = serializeGenerationForBake(generation);
  if (!metadata) throw new Error("Generation metadata could not be serialized");
  (globalThis as any).OpenSeadragon = (await import("openseadragon")).default;
  const { prepareDecorationExport, prepareTerrainSceneData } =
    await import("./telescope-osd-bridge");
  const sceneData = await prepareTerrainSceneData(generation);
  // Scenes now paint within terrain tiles so force-air can erase cells. Only
  // POI marker sprites remain in the independent source-over decoration pass.
  const decor = await prepareDecorationExport(generation, false);
  if (!decor?.cells.length)
    throw new Error("Required pixel-scene/POI decoration export is empty");
  return {
    seed,
    version: TERRAIN_VERSION,
    planes,
    sceneData,
    metadata,
    decor,
    width: generation.worldSize * 512,
    worldTop: WORLD_TOP - WORLD_HEIGHT,
    height: WORLD_HEIGHT * 3,
  };
}

export async function openBakeRenderer(snapshot: any) {
  const { installTelescopeShim } = await import("./telescope-dom-shim");
  const { installFetchInterceptor } = await import("./telescope-data-bridge");
  installTelescopeShim();
  const { getDataZip } = await import("../data-archive");
  await getDataZip();
  installFetchInterceptor(true);
  const { createCpuTerrain } = await import("./cpu-terrain-core");
  const renderers = new Map<
    number,
    Awaited<ReturnType<typeof createCpuTerrain>>
  >();
  for (const p of [0, -1, 1]) {
    const data = snapshot.planes[String(p)];
    renderers.set(
      p,
      await createCpuTerrain({
        ...data,
        sceneData: snapshot.sceneData,
        tileLayers: data.tileLayers.map(restoreTileLayer),
        elevatorShafts: data.elevatorShafts?.map(restoreTileLayer),
      }),
    );
  }
  return {
    render(x: number, y: number, width: number, height: number) {
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (const [plane, renderer] of renderers) {
        const top = Math.max(y, WORLD_TOP + plane * WORLD_HEIGHT);
        const bottom = Math.min(
          y + height,
          WORLD_TOP + (plane + 1) * WORLD_HEIGHT,
        );
        if (top >= bottom || !renderer.contains(x, top, width, bottom - top))
          continue;
        const from = top - y,
          to = bottom - y;
        renderer.renderRows(x, y, width, from, to, pixels);
        renderer.finish(
          pixels.subarray(from * width * 4, to * width * 4),
          x,
          top,
          width,
          to - from,
        );
      }
      return pixels;
    },
  };
}

export async function exportBakeDecoration(cx: number, cy: number) {
  const { exportDecorationCell } = await import("./telescope-osd-bridge");
  return exportDecorationCell(cx, cy);
}
