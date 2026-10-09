import { afterEach, expect, it, vi } from "vitest";

vi.mock("virtual:instant-terrain-shaders", () => ({
  TERRAIN_VS: "void main() {}",
  TERRAIN_FS: "uniform int u_verticalPlane; void main() {}",
}));

import {
  createTerrainWebGL2Context,
  prewarmTerrainShader,
} from "../src/telescope/terrain-shader-prewarm";

function context() {
  const state = { complete: true, linked: true };
  const completion = 0x91b1;
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    disable: vi.fn(),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getExtension: vi.fn(() => ({ COMPLETION_STATUS_KHR: completion })),
    getProgramParameter: vi.fn((_program: object, parameter: number) =>
      parameter === completion ? state.complete : state.linked,
    ),
    getShaderParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => "link refused"),
    getShaderInfoLog: vi.fn(() => ""),
    getUniformLocation: vi.fn((program: object, name: string) => ({
      program,
      name,
    })),
    getError: vi.fn(() => 0),
    isContextLost: vi.fn(() => false),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
  };
  return { gl, state };
}

function renderer() {
  const gpu = context();
  return {
    ...gpu,
    renderer: {
      gl: gpu.gl,
      initContext: vi.fn(() => true),
      program: null as object | null,
      uniforms: null as Record<string, unknown> | null,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses a default adapter when the preferred worker adapter is unavailable", () => {
  const gpu = context();
  const getContext = vi.fn((_type, attributes) =>
    attributes.powerPreference === "default" ? gpu.gl : null,
  );
  expect(createTerrainWebGL2Context({ getContext } as any)).toBe(gpu.gl);
  expect(getContext.mock.calls.map((call) => call[1].powerPreference)).toEqual([
    "high-performance",
    "default",
  ]);
  expect(getContext.mock.calls[1][1]).toMatchObject({
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
});

it("does not request another adapter after successful context creation", () => {
  const gpu = context(),
    getContext = vi.fn(() => gpu.gl);
  expect(createTerrainWebGL2Context({ getContext } as any)).toBe(gpu.gl);
  expect(getContext).toHaveBeenCalledOnce();
});

it("recovers main-context initialization without changing context-loss behavior", async () => {
  const gpu = context();
  const handlers = new Map<string, (event: any) => void>();
  const canvas = {
    getContext: vi.fn(() => gpu.gl),
    addEventListener: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  const renderer: any = {
    initContext: vi.fn(() => !!renderer.gl),
    gl: null,
    program: null,
    failed: "WebGL2 unavailable",
  };
  await prewarmTerrainShader(renderer);
  expect(canvas.getContext).toHaveBeenCalledExactlyOnceWith(
    "webgl2",
    expect.objectContaining({ powerPreference: "default" }),
  );
  expect(renderer.canvas).toBe(canvas);
  expect(renderer.gl).toBe(gpu.gl);
  expect(renderer.failed).toBeNull();
  expect(gpu.gl.compileShader).toHaveBeenCalledTimes(2);
  renderer.textures = { atlas: {} };
  const lost = { preventDefault: vi.fn() };
  handlers.get("webglcontextlost")!(lost);
  expect(lost.preventDefault).toHaveBeenCalledOnce();
  expect(renderer.contextLost).toBe(true);
  expect(renderer.textures).toBeNull();
  expect(renderer.program).toBeNull();
  handlers.get("webglcontextrestored")!({});
  await prewarmTerrainShader(renderer);
  expect(renderer.contextLost).toBe(false);
  expect(gpu.gl.compileShader).toHaveBeenCalledTimes(4);
});

it("still reports unavailable WebGL2 if both adapter preferences fail", async () => {
  const getContext = vi.fn(() => null);
  expect(createTerrainWebGL2Context({ getContext } as any)).toBeNull();
  expect(getContext).toHaveBeenCalledTimes(2);
  vi.stubGlobal("document", { createElement: () => ({ getContext }) });
  const gpu = context();
  const renderer = {
    gl: null,
    initContext: () => false,
    failed: "WebGL2 unavailable",
  };
  await expect(prewarmTerrainShader(renderer)).rejects.toThrow(
    "WebGL2 unavailable",
  );
  expect(getContext).toHaveBeenCalledTimes(3);
  expect(gpu.gl.compileShader).not.toHaveBeenCalled();
});

it("coalesces concurrent prewarm calls while shader completion is pending", async () => {
  vi.useFakeTimers();
  const gpu = renderer();
  gpu.state.complete = false;
  const first = prewarmTerrainShader(gpu.renderer);
  const second = prewarmTerrainShader(gpu.renderer);
  expect(second).toBe(first);
  expect(gpu.gl.createProgram).toHaveBeenCalledOnce();
  expect(gpu.renderer.program).toBeNull();
  gpu.state.complete = true;
  await vi.advanceTimersByTimeAsync(4);
  await Promise.all([first, second]);
  expect(gpu.gl.compileShader).toHaveBeenCalledTimes(2);
  expect(gpu.renderer.program).not.toBeNull();
});

it("reuses an already valid program without compiling or linking again", async () => {
  const gpu = renderer();
  await prewarmTerrainShader(gpu.renderer);
  const program = gpu.renderer.program;
  await prewarmTerrainShader(gpu.renderer);
  await prewarmTerrainShader(gpu.renderer);
  expect(gpu.renderer.program).toBe(program);
  expect(gpu.gl.createProgram).toHaveBeenCalledOnce();
  expect(gpu.gl.compileShader).toHaveBeenCalledTimes(2);
  expect(gpu.gl.linkProgram).toHaveBeenCalledOnce();
});

it("compiles again for the same renderer after its context restores without a program", async () => {
  const gpu = renderer();
  await prewarmTerrainShader(gpu.renderer);
  const oldProgram = gpu.renderer.program;
  const oldUniforms = gpu.renderer.uniforms;
  // Context loss clears the renderer's program. A restored context needs new
  // GL objects even though the renderer used as the WeakMap key is unchanged.
  const restored = context();
  gpu.renderer.gl = restored.gl;
  gpu.renderer.program = null;
  gpu.renderer.uniforms = null;
  await prewarmTerrainShader(gpu.renderer);
  expect(restored.gl.createProgram).toHaveBeenCalledOnce();
  expect(restored.gl.compileShader).toHaveBeenCalledTimes(2);
  expect(gpu.renderer.program).not.toBeNull();
  expect(gpu.renderer.program).not.toBe(oldProgram);
  expect(gpu.renderer.uniforms).not.toBe(oldUniforms);
  expect(gpu.renderer.uniforms).toEqual({
    u_verticalPlane: {
      program: gpu.renderer.program,
      name: "u_verticalPlane",
    },
  });
});

it("releases a failed compilation and permits a successful retry", async () => {
  const gpu = renderer();
  gpu.state.linked = false;
  await expect(prewarmTerrainShader(gpu.renderer)).rejects.toThrow(
    "link refused",
  );
  expect(gpu.renderer.program).toBeNull();
  expect(gpu.gl.deleteProgram).toHaveBeenCalledOnce();
  expect(gpu.gl.deleteShader).toHaveBeenCalledTimes(2);
  gpu.state.linked = true;
  await prewarmTerrainShader(gpu.renderer);
  expect(gpu.gl.createProgram).toHaveBeenCalledTimes(2);
  expect(gpu.gl.compileShader).toHaveBeenCalledTimes(4);
  expect(gpu.gl.deleteShader).toHaveBeenCalledTimes(4);
  expect(gpu.renderer.program).not.toBeNull();
});
