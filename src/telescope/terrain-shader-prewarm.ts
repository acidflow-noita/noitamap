import { TERRAIN_FS, TERRAIN_VS } from "virtual:instant-terrain-shaders";

const pending = new WeakMap<object, Promise<void>>();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

/** Compile/link the real program before seed work starts. KHR completion is
 * polled without blocking; the worker also isolates drivers without KHR.
 * First-use driver specialization remains on the first real draw: dummy draws
 * measured two specializations and increased cold startup on Mesa. */
export function prewarmTerrainShader(renderer: any): Promise<void> {
  const existing = pending.get(renderer);
  if (existing) return existing;
  const warm = warmShader(renderer).catch((error) => {
    pending.delete(renderer);
    throw error;
  });
  pending.set(renderer, warm);
  return warm;
}

async function warmShader(renderer: any) {
  if (!renderer.initContext())
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
