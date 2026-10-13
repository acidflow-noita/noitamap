import { afterEach, expect, it, vi } from 'vitest';
import { NativeTerrainRenderer } from '../src/native-map/gpu/terrain-renderer';

// Driver byte output is covered by the native GLES differential suite. This
// small driver model exercises owner lifetime and delayed/failed compilation.
function context() {
  let id = 0;
  const gl: any = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, COMPILE_STATUS: 4,
    MAX_TEXTURE_IMAGE_UNITS: 5,
    createProgram: vi.fn(() => ++id), createShader: vi.fn(() => ++id),
    deleteProgram: vi.fn(), deleteShader: vi.fn(), disable: vi.fn(),
    shaderSource: vi.fn(), compileShader: vi.fn(), attachShader: vi.fn(), linkProgram: vi.fn(),
    getExtension: () => null, getProgramParameter: () => true, getShaderParameter: () => true,
    getUniformLocation: () => null, getParameter: () => 16, getError: () => 0,
  };
  const canvas = new EventTarget();
  return { gl, canvas };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('owns three programs, retains them across reseeds, and releases all of them', async () => {
  const driver = context(), renderer = new NativeTerrainRenderer(driver);
  await renderer.prewarm();
  expect(driver.gl.createProgram).toHaveBeenCalledTimes(3);
  expect(driver.gl.compileShader).toHaveBeenCalledTimes(6);
  const program = renderer.program;
  renderer.invalidate();
  await renderer.prewarm();
  expect(renderer.program).toBe(program);
  expect(driver.gl.compileShader).toHaveBeenCalledTimes(6);
  renderer.dispose(); renderer.dispose();
  expect(driver.gl.deleteProgram).toHaveBeenCalledTimes(3);
  expect(driver.gl.deleteShader).toHaveBeenCalledTimes(6);
});

it('drops lost-context handles and compiles fresh programs after restoration', async () => {
  const driver = context(), renderer = new NativeTerrainRenderer(driver);
  await renderer.prewarm();
  const original = renderer.program;
  driver.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(renderer.program).toBeNull();
  await expect(renderer.prewarm()).rejects.toThrow('context lost');
  driver.canvas.dispatchEvent(new Event('webglcontextrestored'));
  await renderer.prewarm();
  expect(renderer.program).not.toBe(original);
  expect(driver.gl.compileShader).toHaveBeenCalledTimes(12);
  renderer.dispose();
});

it('coalesces parallel compilation and cleans up an owner disposed during the wait', async () => {
  vi.useFakeTimers();
  const driver = context(), renderer = new NativeTerrainRenderer(driver);
  driver.gl.getExtension = () => ({ COMPLETION_STATUS_KHR: 6 });
  driver.gl.getProgramParameter = () => false;
  const pending = renderer.prewarm();
  expect(renderer.prewarm()).toBe(pending);
  const rejected = expect(pending).rejects.toThrow('interrupted');
  renderer.dispose();
  await vi.advanceTimersByTimeAsync(4);
  await rejected;
  expect(renderer.program).toBeNull();
  expect(driver.gl.deleteProgram).toHaveBeenCalledTimes(3);
  expect(driver.gl.deleteShader).toHaveBeenCalledTimes(6);
});

it('releases partial shader allocations after compile failure and allows retry', async () => {
  const driver = context(), renderer = new NativeTerrainRenderer(driver);
  driver.gl.getShaderParameter = () => false;
  driver.gl.getShaderInfoLog = () => 'driver compile failure';
  await expect(renderer.prewarm()).rejects.toThrow('driver compile failure');
  expect(driver.gl.deleteProgram).toHaveBeenCalledTimes(3);
  expect(driver.gl.deleteShader).toHaveBeenCalledTimes(6);
  expect(renderer.program).toBeNull();
  driver.gl.getShaderParameter = () => true;
  await renderer.prewarm();
  expect(renderer.program).not.toBeNull();
  renderer.dispose();
});
