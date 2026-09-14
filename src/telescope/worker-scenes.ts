/** Seed-independent, already decoded/prescanned scene inputs for a PW worker.
 * The main thread must retain its buffers for rendering; postMessage clones
 * these inputs, never transfers/detaches them. Per-seed recolors are excluded.
 */
export interface WorkerScenes {
  version: 1;
  fullPixels: boolean;
  data: Record<string, any>;
  spawns: Record<string, any[]>;
}

export function snapshotWorkerScenes(sceneModule: any, fullPixels: boolean): WorkerScenes {
  const data: Record<string, any> = {};
  const spawns: Record<string, any[]> = {};
  for (const [key, scene] of Object.entries(sceneModule.PIXEL_SCENE_DATA) as [string, any][]) {
    const spawnPoints = sceneModule.PIXEL_SCENE_SPAWN_DATA[key];
    if (!Array.isArray(spawnPoints)) throw new Error(`Missing prescanned scene spawns: ${key}`);
    data[key] = {...scene, variants: {}};
    spawns[key] = spawnPoints;
  }
  if (!Object.keys(data).length) throw new Error("Cannot snapshot pixel scenes before initialization");
  return {version: 1, fullPixels, data, spawns};
}

export function installWorkerScenes(sceneModule: any, scenes: WorkerScenes, fullPixels: boolean): number {
  if (scenes.version !== 1 || scenes.fullPixels !== fullPixels) throw new Error("Worker pixel-scene snapshot does not match its Telescope fork");
  const keys = Object.keys(scenes.data);
  if (!keys.length || keys.some(key => !Array.isArray(scenes.spawns[key]))) throw new Error("Incomplete worker pixel-scene snapshot");
  sceneModule.injectPixelSceneData(scenes.data);
  sceneModule.injectPixelSceneSpawnData(scenes.spawns);
  return keys.length;
}
