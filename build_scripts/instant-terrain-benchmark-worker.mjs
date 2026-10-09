import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import koffi from "koffi";
import { createHash } from "node:crypto";
import { createNativeGLES } from "./native-gles.mjs";
import { installNativeTerrainEnvironment } from "./native-terrain-environment.mjs";

let gpu, env, result;
try {
  gpu = createNativeGLES({ requireHardware: workerData.requireHardware });
  // Bypass only the harness's automatic canvas readback. The shader, textures,
  // uniforms and real native driver stay identical. glFinish includes actual
  // device completion instead of reporting command-submission time as render time.
  const lib = koffi.load("libGLESv2.so.2");
  const draw = lib.func("void glDrawArrays(uint mode, int first, int count)");
  const finish = lib.func("void glFinish()");
  const read = lib.func(
    "void glReadPixels(int x, int y, int w, int h, uint format, uint type, void *data)",
  );
  let drawMode = "viewport",
    calls = 0;
  env = installNativeTerrainEnvironment({
    ...workerData,
    fullPixels: true,
    workerScript: new URL("./native-terrain-worker.mjs", import.meta.url),
  });
  const create = document.createElement.bind(document);
  document.createElement = (name) => {
    if (name !== "canvas") return create(name);
    const canvas = gpu.createCanvas();
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = (kind, ...args) => {
      const gl = getContext(kind, ...args);
      if (kind === "webgl2" && !gl.__instantBenchmark) {
        const readbackDraw = gl.drawArrays;
        gl.drawArrays = (...values) => {
          calls++;
          if (drawMode === "tiles") return readbackDraw(...values);
          draw(...values);
          const error = gl.getError();
          if (error) throw new Error(`GLES draw error 0x${error.toString(16)}`);
        };
        gl.__instantBenchmark = true;
      }
      return gl;
    };
    return canvas;
  };
  const api = await import(
    pathToFileURL(resolve(workerData.bundle, "benchmark.js")).href
  );
  const data = await api.benchmarkInstantTerrain({
    seed: workerData.seed,
    iterations: workerData.iterations,
    worlds: workerData.worlds,
    finish,
    mode: (value) => {
      drawMode = value;
    },
    draws: () => calls,
    fingerprint(value) {
      const hash = createHash("sha256");
      function append(item) {
        if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
          const bytes =
            item instanceof ArrayBuffer
              ? new Uint8Array(item)
              : new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
          hash.update(`bytes:${bytes.byteLength}:`).update(bytes);
        } else if (Array.isArray(item)) {
          hash.update(`array:${item.length}:[`);
          for (const child of item) append(child);
          hash.update("]");
        } else if (item && typeof item === "object") {
          hash.update("{");
          for (const key of Object.keys(item).sort()) {
            hash.update(JSON.stringify(key));
            append(item[key]);
          }
          hash.update("}");
        } else hash.update(`${typeof item}:${JSON.stringify(item)};`);
      }
      append(value);
      return hash.digest("hex");
    },
    progress: (progress) => parentPort.postMessage({ progress }),
    read: (width, height) => {
      const pixels = new Uint8Array(width * height * 4);
      read(0, 0, width, height, 0x1908, 0x1401, pixels);
      return pixels;
    },
  });
  await env.waitImages();
  result = { renderer: gpu.info, ...data };
} catch (error) {
  result = { error: error.stack };
} finally {
  gpu?.dispose();
  env?.close();
}
parentPort.postMessage(result);
parentPort.close();
