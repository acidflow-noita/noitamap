/** Wait for first-use GPU work without making Canvas drawImage synchronously
 * wait for driver compilation. Readiness and cancellation control the wait. */
export async function waitForTerrainGPU(gl: WebGL2RenderingContext, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw new Error('Terrain GPU fence unavailable');
  gl.flush();
  try {
    for (;;) {
      signal.throwIfAborted();
      if (gl.isContextLost()) throw new Error('Terrain GPU context lost');
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
      if (status === gl.WAIT_FAILED) throw new Error('Terrain GPU frame failed');
      await new Promise<void>((resolve, reject) => {
        const frame = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
        const abort = () => { cancelAnimationFrame(frame); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  } finally { gl.deleteSync(fence); }
}
