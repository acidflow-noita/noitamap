import { afterEach, expect, it, vi } from 'vitest';
import { waitForTerrainGPU } from '../src/telescope/terrain-gpu-ready';
afterEach(() => vi.unstubAllGlobals());

it('waits for actual GPU readiness and services frames without a blocking wait', async () => {
  let frame!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frame = fn; return 1; });
  const gl: any = { fenceSync: () => ({}), flush: vi.fn(), deleteSync: vi.fn(), isContextLost: () => false,
    ALREADY_SIGNALED: 1, CONDITION_SATISFIED: 2, WAIT_FAILED: 3,
    clientWaitSync: vi.fn().mockReturnValueOnce(0).mockReturnValue(2) };
  let ready = false;
  const pending = waitForTerrainGPU(gl, new AbortController().signal).then(() => { ready = true; });
  expect(ready).toBe(false);
  expect(gl.clientWaitSync).toHaveBeenCalledWith(expect.anything(), 0, 0);
  frame(1); await pending;
  expect(ready).toBe(true); expect(gl.deleteSync).toHaveBeenCalledOnce();
});

it('cancels a pending first frame and releases its GPU fence', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  const cancel = vi.fn(); vi.stubGlobal('cancelAnimationFrame', cancel);
  const gl: any = { fenceSync: () => ({}), flush() {}, deleteSync: vi.fn(), isContextLost: () => false,
    ALREADY_SIGNALED: 1, CONDITION_SATISFIED: 2, WAIT_FAILED: 3, clientWaitSync: () => 0 };
  const lifetime = new AbortController(), pending = waitForTerrainGPU(gl, lifetime.signal);
  lifetime.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledWith(1); expect(gl.deleteSync).toHaveBeenCalledOnce();
});
