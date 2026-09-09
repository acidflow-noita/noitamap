import { createTerrainComposition } from "./terrain-composition";
import type {
  GLTerrainGeneration,
  GLTerrainDeps,
} from "./gl-terrain-tile-source";

/** The GPU supplies raw cell colors. Apply the same scene erasure, native
 * backgrounds and static-area mask as the CPU and daily baker before caching. */
export async function createTerrainPresentation(
  gen: GLTerrainGeneration,
  deps: GLTerrainDeps,
) {
  const composition = await createTerrainComposition(
    gen,
    deps.GENERATOR_CONFIG,
    deps.getWorldSize(gen.isNGP, gen.gameMode),
  );
  return (
    ctx: CanvasRenderingContext2D,
    terrain: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(terrain, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    composition.finish(image.data, x, y, w, h);
    ctx.putImageData(image, 0, 0);
  };
}
