import type {
  GLTerrainGeneration,
  GLTerrainDeps,
} from "./gl-terrain-tile-source";

/** Keep GL's fast raw cell draw, but finish scenes/liquids/edge stamps in a
 * worker. Per-pixel JS over 512x512 tiles must not freeze the UI thread. */
export async function createTerrainPresentation(
  gen: GLTerrainGeneration,
  deps: GLTerrainDeps,
) {
  const { CpuTerrainRenderer } = await import("./cpu-terrain-client");
  const worker = new CpuTerrainRenderer();
  await worker.ensureResources(gen.tileLayers, gen.biomeData, {
    ...gen,
    generatorConfig: deps.GENERATOR_CONFIG,
  });
  const present = async (
    ctx: CanvasRenderingContext2D,
    terrain: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
    signal: AbortSignal = new AbortController().signal,
    priority: () => number = () => 0,
  ) => {
    signal.throwIfAborted();
    // Copy BEFORE the next GL draw reuses its canvas. Only this short pixel
    // transfer and final blit remain on the main thread.
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(terrain, 0, 0);
    const pixels = new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data);
    const width = deps.getWorldSize(gen.isNGP, gen.gameMode);
    const pw = Math.floor((x + width * 256) / (width * 512));
    const view = {
      width: w,
      height: h,
      pw,
      camX:
        x +
        w / 2 +
        deps.getWorldCenter(gen.isNGP, gen.gameMode) * 512 -
        pw * width * 512,
      camY: y + h / 2 + 7168,
    };
    const finished = await worker.render(view, signal, priority, pixels);
    signal.throwIfAborted();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(finished, 0, 0);
  };
  present.dispose = () => worker.invalidate();
  return present;
}
