import { installTelescopeShim } from "./telescope-dom-shim";
import { installFetchInterceptor } from "./telescope-data-bridge";
import { restoreTileLayer } from "./tile-layer-cache";

// Install only the worker environment needed by shared Telescope data modules.
// In particular: no Image constructor and no WebGL calls, even on import.
if (typeof window === "undefined") (globalThis as any).window = self;
if (typeof document === "undefined")
  (globalThis as any).document = {
    createElement: () => ({
      style: {},
      appendChild() {},
      setAttribute() {},
      remove() {},
    }),
    getElementById: () => null,
    body: { appendChild() {} },
  };
installTelescopeShim();
installFetchInterceptor(true);
let terrain: Awaited<
  ReturnType<typeof import("./cpu-terrain-core").createCpuTerrain>
> | null = null;
const cancelled = new Set<number>();
const active = new Set<number>();
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (type === "cancel") {
    if (active.has(id)) cancelled.add(id);
    return;
  }
  try {
    if (type === "init") {
      // A pool slot keeps one plane resident. Release the previous material
      // lattice before loading a different one; never multiply it by all planes.
      terrain = null;
      const { createCpuTerrain } = await import("./cpu-terrain-core");
      terrain = await createCpuTerrain({
        ...data.generation,
        tileLayers: data.generation.tileLayers.map(restoreTileLayer),
        elevatorShafts: data.generation.elevatorShafts?.map(restoreTileLayer),
      });
      self.postMessage({
        id,
        type: "ready",
        mapWidth: terrain.mapWidth,
        centerPx: terrain.centerPx,
        stats: terrain.stats,
      });
    } else if (type === "render" || type === "present") {
      if (!terrain) throw new Error("CPU terrain resources are not ready");
      const { x, y, width, height } = data;
      if (
        ![x, y, width, height].every(Number.isSafeInteger) ||
        width < 1 ||
        width > 512 ||
        height < 1 ||
        height > 512
      ) {
        throw new Error("Invalid CPU terrain tile dimensions");
      }
      active.add(id);
      const pixels =
        type === "present"
          ? new Uint8ClampedArray(data.pixels)
          : new Uint8ClampedArray(width * height * 4);
      if (pixels.length !== width * height * 4)
        throw new Error("Invalid terrain presentation buffer");
      const hasContent = terrain.contains(x, y, width, height);
      let yieldAt = performance.now() + 12;
      for (
        let row = 0;
        type === "render" && hasContent && row < height;
        row += 16
      ) {
        if (cancelled.has(id)) break;
        terrain.renderRows(
          x,
          y,
          width,
          row,
          Math.min(row + 16, height),
          pixels,
        );
        if (row + 16 < height && performance.now() >= yieldAt) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yieldAt = performance.now() + 12;
        }
      }
      if (cancelled.has(id)) self.postMessage({ id, type: "cancelled" });
      else {
        if (hasContent) terrain.finish(pixels, x, y, width, height);
        self.postMessage(
          { id, type: "tile", width, height, pixels: pixels.buffer },
          [pixels.buffer],
        );
      }
    } else throw new Error(`Unknown CPU terrain request: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    active.delete(id);
    cancelled.delete(id);
  }
};
