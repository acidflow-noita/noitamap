import { packs, provenance } from "virtual:noitamap-scene-assets";
import { installWorkerScenes, type WorkerScenes } from "./worker-scenes";
import SceneWorker from "./prepared-scenes-worker?worker";
import { unpackSceneInputs } from "./unpack-scene-inputs";
import { loadSceneInputsOffThread } from "./scene-input-loader";

const pending = new Map<boolean, Promise<WorkerScenes>>();

/** Seed-independent download/unpack is coalesced for the tab. No seed change
 * can invalidate it; rejected loads are retriable rather than cached forever. */
export function prepareSceneInputs(
  fullPixels: boolean,
  inline = false,
): Promise<WorkerScenes> {
  const prior = pending.get(fullPixels);
  if (prior) return prior;
  const promise = (async () => {
    const pack = packs[fullPixels ? "full" : "approx"];
    const response = await fetch(pack.url, {
      signal: AbortSignal.timeout(30000),
      cache: "force-cache",
    });
    if (!response.ok)
      throw new Error(
        `Prepared scene download failed: HTTP ${response.status}`,
      );
    const compressed = await response.arrayBuffer();
    // Inflate, JSON parsing and material-mask expansion execute off the UI
    // thread. Transfer input and every unique output buffer instead of cloning.
    const scenes = inline
      ? await unpackSceneInputs(compressed, pack.bytes, provenance)
      : await loadSceneInputsOffThread(
          compressed,
          pack.bytes,
          provenance,
          () => new SceneWorker(),
        );
    if (
      scenes.fullPixels !== fullPixels ||
      Object.keys(scenes.data).length !== pack.scenes
    )
      throw new Error("Prepared scene fork/count mismatch");
    return scenes;
  })();
  pending.set(fullPixels, promise);
  void promise.catch(() => {
    if (pending.get(fullPixels) === promise) pending.delete(fullPixels);
  });
  return promise;
}

export async function installPreparedScenes(
  sceneModule: any,
  fullPixels: boolean,
  inline = false,
): Promise<void> {
  // Match upstream's asynchronous texture setup, independently of decoding.
  void sceneModule.initPixelSceneTextures?.();
  installWorkerScenes(
    sceneModule,
    await prepareSceneInputs(fullPixels, inline),
    fullPixels,
  );
}
