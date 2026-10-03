// App-free upstream worker interface. Keep one warmed pool across reseeds.
// @ts-ignore — upstream JavaScript is resolved by Vite.
import { TerrainWorkers } from "noita-telescope-full-pixels/terrain_workers.js";

let workers: any;
let request = 0;

export function warmFullPixelWorld(): void {
  workers ??= new TerrainWorkers();
}

export async function generateFullPixelWorld(
  seed: number,
  ngPlusCount: number,
  gameMode: string,
) {
  const token = ++request;
  const pool = (workers ??= new TerrainWorkers());
  const job = pool.generate({ seed, ngPlusCount, gameMode });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Observe all products together, including failures before the biome arrives.
    const [{ biomeData }, tileLayers, tileSpawns] = await Promise.race([
      Promise.all([job.biome, job.layers, job.spawns, job.terrain]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terrain generation worker timed out")),
          60_000,
        );
      }),
    ]);
    return { biomeData, tileLayers, tileSpawns };
  } catch (error) {
    // Superseded callers must not terminate a newer request's shared pool.
    if (token === request) {
      pool.terminate();
      workers = undefined;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
