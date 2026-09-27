import { TERRAIN_FS, TERRAIN_VS } from "virtual:instant-terrain-shaders";

const pending = new WeakMap<object, Promise<void>>();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

/** A discrete adapter preference is a hint, not a terrain requirement. Let
 * the browser choose its default adapter if the preferred one is unavailable. */
export function createTerrainWebGL2Context(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  preference: WebGLPowerPreference = "high-performance",
): WebGL2RenderingContext | null {
  const attributes: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: preference,
  };
  const gl = canvas.getContext(
    "webgl2",
    attributes,
  ) as WebGL2RenderingContext | null;
  return (
    gl ||
    (preference === "high-performance"
      ? (canvas.getContext("webgl2", {
          ...attributes,
          powerPreference: "default",
        }) as WebGL2RenderingContext | null)
      : null)
  );
}

function initializeTerrainContext(renderer: any): boolean {
  if (renderer.initContext()) return true;
  if (renderer.gl || typeof document === "undefined") return false;
  // The upstream renderer already tried high-performance and retains a failed
  // flag. Recover with a default-adapter context on its ordinary canvas path.
  const canvas = document.createElement("canvas");
  const gl = createTerrainWebGL2Context(canvas, "default");
  if (!gl) return false;
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
  renderer.canvas = canvas;
  renderer.gl = gl;
  renderer.contextLost = false;
  renderer.failed = null;
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  return true;
}

/** Compile/link the real program before seed work starts. KHR completion is
 * polled without blocking; the worker also isolates drivers without KHR.
 * First-use driver specialization remains on the first real draw: dummy draws
 * measured two specializations and increased cold startup on Mesa. */
export function prewarmTerrainShader(renderer: any): Promise<void> {
  const existing = pending.get(renderer);
  if (existing) return existing;
  const warm = warmShader(renderer).finally(() => {
    // Keep only in-flight compilation. A restored context has no program and
    // must not reuse a resolved promise from the context it replaced.
    if (pending.get(renderer) === warm) pending.delete(renderer);
  });
  pending.set(renderer, warm);
  return warm;
}

async function warmShader(renderer: any) {
  if (!initializeTerrainContext(renderer))
    throw new Error(renderer.failed || "WebGL2 unavailable");
  const gl = renderer.gl;
  if (renderer.program) return;
  const started = performance.now();
  const program = gl.createProgram();
  const shaders: any[] = [];
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, TERRAIN_VS],
      [gl.FRAGMENT_SHADER, TERRAIN_FS],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    const parallel = gl.getExtension?.("KHR_parallel_shader_compile");
    while (
      parallel &&
      !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)
    ) {
      if (gl.isContextLost?.() || performance.now() - started > 30_000)
        throw new Error("Terrain shader compilation did not complete");
      await pause();
    }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(
        `Terrain shader link failed: ${gl.getProgramInfoLog(program)}`,
      );
    for (const shader of shaders)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          `Terrain shader compile failed: ${gl.getShaderInfoLog(shader)}`,
        );
    const uniforms: Record<string, any> = {};
    for (const match of TERRAIN_FS.matchAll(
      /uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*;/g,
    ))
      uniforms[match[1]] = gl.getUniformLocation(program, match[1]);
    const error = gl.getError();
    if (error)
      throw new Error(`Terrain shader warmup failed: 0x${error.toString(16)}`);
    renderer.program = program;
    renderer.uniforms = uniforms;
    renderer.shaderWarmupMs = performance.now() - started;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
