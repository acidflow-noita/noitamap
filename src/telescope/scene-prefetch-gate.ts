import { yieldGenerationTask } from './generation-task';

/** Admit one optional scene at a time after navigation and visible terrain
 * work settle. Wait on viewer events, not a timer polling a moving camera. */
export function createScenePrefetchGate(viewer: any, signal: AbortSignal) {
  const osd = viewer.viewer || viewer;
  let closed = false, pressed = false, task = false, revision = 0;
  let frame: number | undefined, idle: number | undefined;
  let pending: Promise<boolean> | undefined, resolve: ((ready: boolean) => void) | undefined;
  const busy = () => {
    if (document.hidden || pressed || osd.isAnimating?.()) return true;
    for (let i = 0; i < (osd.world?.getItemCount?.() ?? 0); i++)
      if (osd.world.getItemAt(i)?.source?.isInstantTerrainBusy?.()) return true;
    return false;
  };
  function cancelScheduled() {
    revision++;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (idle !== undefined) globalThis.cancelIdleCallback?.(idle);
    frame = idle = undefined;
    task = false;
  }
  function finish(ready: boolean) {
    const done = resolve;
    resolve = undefined;
    pending = undefined;
    done?.(ready);
  }
  function wake() {
    if (closed || !resolve || frame !== undefined || idle !== undefined || task || busy()) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (closed || !resolve || busy()) return;
      const version = revision;
      const admit = () => {
        // A pan may have cancelled this callback and scheduled another wait.
        if (closed || version !== revision) return;
        idle = undefined;
        task = false;
        if (busy()) return;
        finish(true);
      };
      if (typeof globalThis.requestIdleCallback === 'function') {
        idle = globalThis.requestIdleCallback(admit);
      } else {
        // Finish the current viewer frame before starting an optional scene.
        task = true;
        void yieldGenerationTask().then(admit, dispose);
      }
    });
  }
  function changed() { cancelScheduled(); wake(); }
  function press() { pressed = true; changed(); }
  function release() { pressed = false; changed(); }
  const handlers: Array<[string, () => void]> = [
    ...['pan', 'zoom', 'resize', 'rotate', 'flip', 'viewport-change', 'animation-start']
      .map(name => [name, changed] as [string, () => void]),
    ['canvas-press', press], ['canvas-drag', press],
    ['canvas-release', release], ['canvas-drag-end', release],
    ['animation-finish', wake], ['update-viewport', wake], ['before-destroy', dispose],
  ];
  function dispose() {
    if (closed) return;
    closed = true;
    cancelScheduled();
    for (const [name, handler] of handlers) osd.removeHandler?.(name, handler);
    document.removeEventListener('visibilitychange', changed);
    signal.removeEventListener('abort', dispose);
    finish(false);
  }
  if (signal.aborted) closed = true;
  else {
    for (const [name, handler] of handlers) osd.addHandler?.(name, handler);
    document.addEventListener('visibilitychange', changed);
    signal.addEventListener('abort', dispose, { once: true });
  }
  return {
    wait(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (!pending) {
        pending = new Promise<boolean>(done => { resolve = done; });
        wake();
      }
      return pending;
    },
    dispose,
  };
}
