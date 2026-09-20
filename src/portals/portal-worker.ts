import { createWorkerRuntime, PortalFrameRenderer } from './worker-runtime';
import type { PortalWorkerRequest, PortalWorkerResponse } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let renderer: PortalFrameRenderer | null = null;
let busy = false;
function send(message: PortalWorkerResponse, transfer: Transferable[] = []) { scope.postMessage(message, transfer); }
scope.onmessage = async ({ data }: MessageEvent<PortalWorkerRequest>) => {
  try {
    if (data.type === 'init') {
      if (renderer) throw new Error('Portal worker already initialized');
      renderer = new PortalFrameRenderer(data.portals, data.seed, data.options, createWorkerRuntime(data.resources));
      send({ type: 'ready' });
    } else {
      if (!renderer || busy) throw new Error('Portal worker received an overlapping frame');
      busy = true;
      const frame = await renderer.frame(data.id, data.camera, data.elapsed);
      send(frame, [frame.bitmap]);
    }
  } catch (error) {
    renderer?.dispose(); renderer = null;
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
