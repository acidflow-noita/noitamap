import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeGLES } from "../../build_scripts/native-gles.mjs";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";

let graphics, environment, result;
try {
  const trace = globalThis.__sharedResourceTrace = {
    phase: "bootstrap", latticeBuilds: [], coverage: [], uploads: [], compiles: [], creates: [], deletes: [],
  };
  graphics = createNativeGLES({ softwareOnly: true });
  environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true });
  const create = document.createElement.bind(document), instrumented = new WeakSet();
  document.createElement = tag => {
    if (tag !== "canvas") return create(tag);
    const canvas = graphics.createCanvas(), getContext = canvas.getContext.bind(canvas);
    canvas.getContext = type => {
      const gl = getContext(type);
      if (type !== "webgl2" || instrumented.has(gl)) return gl;
      instrumented.add(gl);
      let boundTexture;
      const bindTexture = gl.bindTexture;
      gl.bindTexture = (...args) => { boundTexture = args[1]; return bindTexture(...args); };
      for (const method of ["texImage2D", "texSubImage2D", "compileShader", "createTexture", "deleteTexture"]) {
        const original = gl[method];
        gl[method] = (...args) => {
          const value = original(...args);
          if (method === "compileShader") trace.compiles.push(trace.phase);
          else if (method === "createTexture") trace.creates.push({ phase: trace.phase, texture: value });
          else if (method === "deleteTexture") trace.deletes.push({ phase: trace.phase, texture: args[0] });
          else trace.uploads.push({ phase: trace.phase, method, texture: boundTexture,
            format: method === "texImage2D" ? args[2] : undefined, width: args[method === "texImage2D" ? 3 : 4],
            height: args[method === "texImage2D" ? 4 : 5], bytes: args[8]?.byteLength ?? 0 });
          return value;
        };
      }
      return gl;
    };
    return canvas;
  };
  const fixture = await import(pathToFileURL(resolve(workerData.bundle, "fixture.js")).href);
  result = await fixture.verifySharedTerrainResources();
  await environment.waitImages();
  result = { ...result, graphics: graphics.info, diagnostics: environment.diagnostics };
} catch (error) {
  result = { error: error.stack };
} finally {
  graphics?.dispose(); environment?.close();
}
parentPort.postMessage(result);
parentPort.close();
