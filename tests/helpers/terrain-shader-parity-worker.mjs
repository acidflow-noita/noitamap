import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import koffi from "koffi";
import { createNativeGLES } from "../../build_scripts/native-gles.mjs";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";

let graphics, environment, result;
try {
  graphics = createNativeGLES({ softwareOnly: true });
  environment = installNativeTerrainEnvironment({
    ...workerData,
    fullPixels: true,
    workerScript: new URL(
      "../../build_scripts/native-terrain-worker.mjs",
      import.meta.url,
    ),
  });
  const create = document.createElement.bind(document);
  document.createElement = (tag) =>
    tag === "canvas" ? graphics.createCanvas() : create(tag);
  globalThis.OpenSeadragon = {
    TileSource: class {},
    Point: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Rect: class {},
  };
  const library = koffi.load("libGLESv2.so.2");
  const finish = library.func("void glFinish()");
  const fixture = await import(
    pathToFileURL(workerData.bundle + "/fixture.js").href
  );
  result = await fixture.verifyTerrainShaderParity({
    variants: workerData.variants,
    finish,
    progress: (message) => parentPort.postMessage({ progress: message }),
  });
  await environment.waitImages();
  result = {
    ...result,
    graphics: graphics.info,
    diagnostics: environment.diagnostics,
  };
} catch (error) {
  result = { error: error.stack };
} finally {
  graphics?.dispose();
  environment?.close();
}
parentPort.postMessage(result);
parentPort.close();
