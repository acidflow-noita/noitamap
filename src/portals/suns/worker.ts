import { SunRenderer } from './renderer.mjs';
import type { SunRequest, SunResponse } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let renderer: SunRenderer | null = null;
let initializing = false;
function send(data: SunResponse, transfer: Transferable[] = []) { scope.postMessage(data, transfer); }
scope.onmessage = async ({ data }: MessageEvent<SunRequest>) => {
  try {
    if (data.type === 'init') {
      if (renderer || initializing) throw new Error('Sun worker already initialized');
      initializing = true;
      const started = performance.now();
      const response = await fetch(new URL('./effects.bin', import.meta.url));
      if (!response.ok) throw new Error(`Sun resources: HTTP ${response.status}`);
      renderer = new SunRenderer(await response.arrayBuffer(), data.seed);
      send({ type: 'ready', startupMS: performance.now() - started });
    } else {
      if (!renderer) throw new Error('Sun renderer unavailable');
      const stats = renderer.render(data.effect, data.x, data.y, data.elapsedMS, data.pixels);
      const bitmap = renderer.finish();
      send({ type: 'frame', effect: data.effect, bitmap, stats }, [bitmap]);
    }
  } catch (error) {
    renderer?.dispose(); renderer = null;
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
