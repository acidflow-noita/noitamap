import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { createNativeGLES } from "../../build_scripts/native-gles.mjs";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";

// Delegate ordinary generation workers to the existing native harness.
if (
  workerData.role === "web-worker" &&
  !workerData.entry.includes("instant-terrain-worker-")
) {
  await import("../../build_scripts/native-terrain-worker.mjs");
} else {
  let graphics, environment;
  try {
    graphics = createNativeGLES({ softwareOnly: true });
    environment = installNativeTerrainEnvironment({
      ...workerData,
      fullPixels: true,
      workerScript: new URL(import.meta.url),
    });
    const create = document.createElement.bind(document);
    const gpuCanvas = () => {
      const canvas = graphics.createCanvas();
      canvas.transferToImageBitmap = () => {
        // N-API canvas owns an external ArrayBuffer; Node cannot transfer it.
        const pixels = new Uint8ClampedArray(
          canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data,
        );
        return { width: canvas.width, height: canvas.height, pixels };
      };
      return canvas;
    };
    document.createElement = (tag) =>
      tag === "canvas" ? gpuCanvas() : create(tag);
    if (workerData.role === "web-worker") {
      globalThis.OffscreenCanvas = class {
        constructor() {
          return gpuCanvas();
        }
      };
      let archivesAllowed = false;
      const fetch = globalThis.fetch;
      globalThis.fetch = (url, ...args) => {
        if (!archivesAllowed)
          throw new Error(
            `Shader prewarm unexpectedly fetched an asset: ${url}`,
          );
        return fetch(url, ...args);
      };
      globalThis.postMessage = (data, transfer = []) => {
        if (data.bitmap) transfer = [data.bitmap.pixels.buffer];
        parentPort.postMessage(data, transfer);
      };
      await import(pathToFileURL(workerData.entry).href);
      parentPort.on("message", (data) => {
        if (data.type === "init") archivesAllowed = true;
        globalThis.onmessage({ data });
      });
      parentPort.postMessage({ __ready: true });
    } else {
      const BrowserWorker = globalThis.Worker;
      globalThis.Worker = class extends BrowserWorker {
        constructor(...args) {
          super(...args);
          let callback;
          Object.defineProperty(this, "onmessage", {
            get: () => (event) => {
              const source = event.data.bitmap;
              if (source?.pixels) {
                const canvas = createCanvas(source.width, source.height);
                canvas
                  .getContext("2d")
                  .putImageData(
                    new ImageData(source.pixels, source.width, source.height),
                    0,
                    0,
                  );
                canvas.close = () => {
                  canvas.width = canvas.height = 0;
                };
                event.data.bitmap = canvas;
              }
              callback?.(event);
            },
            set: (value) => {
              callback = value;
            },
          });
        }
      };
      const api = await import(pathToFileURL(workerData.entry).href);
      const result = await api.verifyInstantTerrainWorker();
      await environment.waitImages();
      parentPort.postMessage({
        ...result,
        graphics: graphics.info,
        diagnostics: environment.diagnostics,
      });
      environment.close();
      graphics.dispose();
      parentPort.close();
    }
  } catch (error) {
    if (workerData.role === "web-worker") {
      environment?.close();
      graphics?.dispose();
      throw error;
    }
    parentPort.postMessage({ error: error.stack });
    environment?.close();
    graphics?.dispose();
    parentPort.close();
  }
}
