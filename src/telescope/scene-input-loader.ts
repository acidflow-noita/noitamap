import { unpackSceneInputs } from "./unpack-scene-inputs";
import type { WorkerScenes } from "./worker-scenes";

/** Keep the small compressed input for a synchronous-environment fallback;
 * never keep a second copy of the expanded RGBA scene data. */
export async function loadSceneInputsOffThread(
  compressed: ArrayBuffer,
  bytes: number,
  provenance: string,
  createWorker: () => Worker,
): Promise<WorkerScenes> {
  try {
    return await new Promise<WorkerScenes>((resolve, reject) => {
      let worker: Worker | undefined,
        timeout: ReturnType<typeof setTimeout> | undefined,
        settled = false;
      const finish = (error?: Error, value?: WorkerScenes) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker?.terminate();
        error ? reject(error) : resolve(value!);
      };
      try {
        worker = createWorker();
        timeout = setTimeout(
          () => finish(new Error("Prepared scene unpack timed out")),
          30000,
        );
        worker.onmessage = ({ data }) => {
          if (data?.error || !data?.scenes)
            finish(new Error(String(data?.error || "Missing unpacked scenes")));
          else finish(undefined, data.scenes);
        };
        worker.onerror = (event) => {
          event.preventDefault?.();
          finish(new Error(event.message || "Prepared scene worker failed"));
        };
        worker.onmessageerror = () =>
          finish(new Error("Prepared scene worker response could not be read"));
        const copy = compressed.slice(0);
        worker.postMessage({ compressed: copy, provenance, bytes }, [copy]);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch {
    // Light maps must still work where Worker creation is unavailable/blocked.
    // The same strict decoder detects damaged assets in both execution modes.
    return unpackSceneInputs(compressed, bytes, provenance);
  }
}
