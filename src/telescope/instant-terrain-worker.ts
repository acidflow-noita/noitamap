import { installTelescopeShim } from "./telescope-dom-shim";
import { installFetchInterceptor } from "./telescope-data-bridge";
import { restoreTileLayer } from "./tile-layer-cache";
import { setTerrainPlane } from "./instant-terrain-plane";

if (typeof window === "undefined") (globalThis as any).window = self;
if (typeof document === "undefined")
  (globalThis as any).document = {
    createElement: (tag: string) =>
      tag === "canvas"
        ? new OffscreenCanvas(1, 1)
        : {
            style: {},
            appendChild() {},
            setAttribute() {},
            remove() {},
          },
    getElementById: () => null,
    body: { appendChild() {} },
  };
installTelescopeShim();
installFetchInterceptor(true);

let renderer: any;
let config: any;
let warm: Promise<void> | undefined;
let resourcesLoaded: Promise<void> | undefined;
let activeToken = 0;
let latestToken = 0;
let queue: Promise<void> = Promise.resolve();
const cancelled = new Set<number>();
const outstanding = new Set<number>();

function prewarm() {
  return (warm ??= (async () => {
    const { prewarmTerrainShader } = await import("./terrain-shader-prewarm");
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("OffscreenCanvas WebGL2 unavailable");
    renderer = { canvas, gl, initContext: () => true };
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      renderer.contextLost = true;
      renderer.textures = null;
      renderer.program = null;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      renderer.contextLost = false;
      renderer.sourceKey = null;
    });
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    await prewarmTerrainShader(renderer);
  })());
}

function loadResources() {
  return (resourcesLoaded ??= (async () => {
    // init arrives only after the main archive and generated layers are ready.
    // Shader-only prewarm must not evaluate the generator's archive-dependent
    // top-level imports while a cold data.zip download is still in flight.
    const [{ GLTerrainRenderer }, { initMaterialAtlas }, { GENERATOR_CONFIG }] =
      await Promise.all([
        import("noita-telescope-full-pixels/gl/terrain_renderer.js"),
        import("noita-telescope-full-pixels/gl/material_atlas.js"),
        import("noita-telescope-full-pixels/generator_config.js"),
      ]);
    await Promise.all([prewarm(), initMaterialAtlas()]);
    config = GENERATOR_CONFIG;
    const warmed = renderer;
    renderer = Object.assign(new GLTerrainRenderer(), {
      canvas: warmed.canvas,
      gl: warmed.gl,
      program: warmed.program,
      uniforms: warmed.uniforms,
      shaderWarmupMs: warmed.shaderWarmupMs,
      contextLost: warmed.contextLost ?? false,
    });
  })());
}

self.onmessage = ({ data }) => {
  const { id, type, token } = data;
  if (type === "cancel") {
    if (outstanding.has(id)) cancelled.add(id);
    return;
  }
  if (type === "init") latestToken = token;
  outstanding.add(id);
  queue = queue
    .then(async () => {
      // Yield between tiles so cancel/reseed messages can reach this queue.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled.has(id)) throw new Error("Terrain request cancelled");
      if (type === "prewarm") {
        await prewarm();
        self.postMessage({ id, shaderWarmupMs: renderer.shaderWarmupMs });
      } else if (type === "init") {
        await loadResources();
        if (token !== latestToken)
          throw new DOMException("Obsolete terrain generation", "AbortError");
        const started = performance.now();
        const gen = data.generation;
        renderer.invalidate();
        const ready = renderer.ensureResources(
          gen.tileLayers.map(restoreTileLayer),
          gen.biomeData,
          {
            isNGP: gen.isNGP,
            gameMode: gen.gameMode ?? "normal",
            seed: gen.seed,
            lut: { recolorMaterials: true, clearSpawnPixels: true },
            engineTerrain: true,
            generatorConfig: config,
          },
        );
        if (!ready || !renderer.engineReady || renderer.gl.getError())
          throw new Error(
            renderer.failed || "Worker WebGL2 terrain resources unavailable",
          );
        activeToken = token;
        self.postMessage({
          id,
          resourceMs: performance.now() - started,
          shaderWarmupMs: renderer.shaderWarmupMs,
        });
      } else if (type === "render") {
        if (token !== activeToken || token !== latestToken)
          throw new DOMException("Obsolete terrain generation", "AbortError");
        setTerrainPlane(renderer, data.plane);
        const canvas = renderer.render(data.view);
        if (!canvas || renderer.gl.getError())
          throw new Error(renderer.failed || "Worker terrain draw failed");
        const bitmap = canvas.transferToImageBitmap();
        self.postMessage({ id, bitmap }, [bitmap]);
      } else if (type === "invalidate") {
        if (token === activeToken) {
          renderer.invalidate();
          activeToken = 0;
        }
        self.postMessage({ id });
      } else throw new Error(`Unknown terrain worker request: ${type}`);
    })
    .catch((error) => {
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
    })
    .finally(() => {
      outstanding.delete(id);
      cancelled.delete(id);
    });
};
