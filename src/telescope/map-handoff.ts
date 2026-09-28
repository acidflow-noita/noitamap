import { holdTerrainRetirement } from './terrain-retirement';

/** One bounded outgoing view covers incoming layers until their current camera
 * is painted. OSD continues loading/drawing normally underneath it. */
type Cover = { element: HTMLDivElement; image: HTMLCanvasElement; update: () => void };
export interface MapHandoff {
  check(): void;
  finish(onPaint: () => void): void;
  fail(error?: unknown): void;
}
type Active = MapHandoff & { cover?: Cover; hold(): () => void; dispose(keepCover?: boolean): void };
const active = new WeakMap<object, Active>();

export function isMapHandoffPending(viewer: any): boolean {
  return active.has(viewer.viewer ?? viewer);
}

export function clearMapHandoff(viewer: any): void {
  active.get(viewer.viewer ?? viewer)?.dispose();
}

/** A renderer fallback can replace its layers after the initial setup ended. */
export function holdMapHandoff(viewer: any): () => void {
  return active.get(viewer.viewer ?? viewer)?.hold() ?? (() => {});
}

export function failMapHandoff(viewer: any, error?: unknown): void {
  active.get(viewer.viewer ?? viewer)?.fail(error);
}

/** Background cooking must not compete with the still-covered composition. */
export function afterMapHandoff(input: any, signal: AbortSignal, run: () => void): void {
  const viewer = input.viewer ?? input;
  if (signal.aborted) return;
  if (!isMapHandoffPending(viewer)) { run(); return; }
  const stop = () => {
    viewer.removeHandler?.('map-handoff-complete', complete);
    signal.removeEventListener('abort', stop);
  };
  const complete = () => { stop(); if (!signal.aborted) run(); };
  viewer.addHandler?.('map-handoff-complete', complete);
  signal.addEventListener('abort', stop, { once: true });
}

function capture(viewer: any): Cover | undefined {
  const source = viewer.drawer?.canvas ?? viewer.drawer?.context?.canvas;
  const host = viewer.canvas as HTMLElement | undefined;
  if (!host || !source?.width || !source?.height || !viewer.viewport) return;
  const size = viewer.viewport.getContainerSize();
  if (!size.x || !size.y) return;
  const image = document.createElement('canvas');
  // Never keep two whole worlds, nor an unbounded high-DPI screenshot.
  const scale = Math.min(1, Math.sqrt(4 * 1024 * 1024 / (source.width * source.height)));
  image.width = Math.max(1, Math.round(source.width * scale));
  image.height = Math.max(1, Math.round(source.height * scale));
  const context = image.getContext('2d');
  if (!context) return;
  context.fillStyle = '#000';
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(source, 0, 0, image.width, image.height);
  // Orb sprites are HTML overlays, whereas ordinary POIs already live in the
  // OSD canvas. Copy decoded images without a readback/PNG encoding step.
  const rect = host.getBoundingClientRect();
  if (rect.width && rect.height) {
    for (const element of viewer.overlaysContainer?.querySelectorAll('img') ?? []) {
      if (!element.complete || !element.naturalWidth) continue;
      const bounds = element.getBoundingClientRect();
      try {
        context.drawImage(element, (bounds.x - rect.x) * image.width / rect.width,
          (bounds.y - rect.y) * image.height / rect.height,
          bounds.width * image.width / rect.width, bounds.height * image.height / rect.height);
      } catch { /* One unavailable orb must not discard the composed map. */ }
    }
  }
  const point = (x: number, y: number) => {
    const pixel = size.clone(); pixel.x = x; pixel.y = y;
    if (viewer.viewport.getFlip?.()) pixel.x = size.x - pixel.x;
    return viewer.viewport.pointFromPixel(pixel, true);
  };
  const origin = point(0, 0), right = point(size.x, 0), bottom = point(0, size.y);
  const element = document.createElement('div');
  element.className = 'map-handoff';
  element.setAttribute('aria-hidden', 'true');
  // Outside the bounded outgoing view, navigation can show the resident base
  // map. Do not introduce a black screen when panning beyond this snapshot.
  element.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:100';
  image.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;image-rendering:pixelated';
  element.appendChild(image);
  host.appendChild(element);
  const update = () => {
    const project = (world: any) => {
      const pixel = viewer.viewport.pixelFromPoint(world, true);
      if (viewer.viewport.getFlip?.()) pixel.x = viewer.viewport.getContainerSize().x - pixel.x;
      return pixel;
    };
    const a = project(origin), b = project(right), c = project(bottom);
    image.style.transform = `matrix(${(b.x-a.x)/image.width},${(b.y-a.y)/image.width},${(c.x-a.x)/image.height},${(c.y-a.y)/image.height},${a.x},${a.y})`;
  };
  update();
  return { element, image, update };
}

export function beginMapHandoff(input: any, preserveView: boolean, onFailure?: (error: unknown) => void): MapHandoff {
  const viewer = input.viewer ?? input;
  const previous = active.get(viewer);
  const releaseRetirement = holdTerrainRetirement();
  // Rapid reseeding preserves the original complete view, never a half-built
  // intermediate seed, and keeps at most one snapshot alive.
  let cover = previous?.cover;
  previous?.dispose(true);
  if (!cover && preserveView) {
    try { cover = capture(viewer); }
    catch (error) { console.warn('[Map handoff] Cannot preserve outgoing view:', error); }
  }
  let sealed = false, queued = false, disposed = false;
  let failed = false;
  let setupHolds = 0;
  let onPaint = () => {};
  const watched = new Set<any>();
  const outgoingAdditions = new Set((viewer._loadQueue ?? []).map((entry: any) => entry.options));
  const events = ['update-viewport', 'viewport-change', 'animation-finish', 'resize', 'rotate', 'flip', 'tile-drawn'];
  const imageEvents = ['load', 'error'];
  const overlayVisibility = viewer.overlaysContainer?.style.visibility ?? '';
  if (cover && viewer.overlaysContainer) viewer.overlaysContainer.style.visibility = 'hidden';
  const ready = () => {
    if (!sealed || failed || setupHolds || viewer._loadQueue?.length) return false;
    const world = viewer.world;
    for (let i = 0; i < (world?.getItemCount() ?? 0); i++) {
      const item = world.getItemAt(i);
      if (item.getOpacity?.() === 0 || !item.getDrawArea?.()) continue;
      // Direct GPU terrain has no OSD tiles; its own current-camera frame is
      // the readiness signal. A frame from the previous camera cannot qualify.
      if (item.source.__viewportReady) {
        if (!item.source.__viewportReady()) return false;
      // Sparse scene/POI layers deliberately contain no tiles in empty views.
      // OSD leaves needsDraw=true there even after all coverage is settled.
      } else if (!item.getFullyLoaded()
        || (item.needsDraw?.() && item._lastDrawn?.length !== 0)) return false;
    }
    for (const image of viewer.overlaysContainer?.querySelectorAll('img') ?? [])
      if (!image.complete) return false;
    return true;
  };
  function check() {
    if (disposed || queued) return;
    queued = true;
    // Tile events fire inside OSD's draw; wait for setDrawn(), not a timer.
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      cover?.update();
      if (!ready()) return;
      transaction.dispose();
      onPaint();
      viewer.raiseEvent?.('map-handoff-complete', {});
    });
  }
  function watch(item: any) {
    if (watched.has(item)) return;
    watched.add(item);
    item.addHandler?.('fully-loaded-change', check);
    item.addHandler?.('bounds-change', check);
  }
  function unwatch(item: any) {
    item.removeHandler?.('fully-loaded-change', check);
    item.removeHandler?.('bounds-change', check);
    watched.delete(item);
  }
  const added = ({ item }: any) => { watch(item); check(); };
  const removed = ({ item }: any) => { unwatch(item); check(); };
  const destroy = () => transaction.dispose();
  const additionFailed = (event: any) => {
    if (outgoingAdditions.has(event.options)) return;
    transaction.fail(event);
  };
  const tileFailed = (event: any) => {
    if (!event.maxReached || !watched.has(event.tiledImage)) return;
    transaction.fail(event);
  };
  const transaction: Active = {
    cover, check,
    hold() {
      setupHolds++;
      let released = false;
      return () => { if (!released) { released = true; setupHolds--; check(); } };
    },
    finish(callback) { sealed = true; onPaint = callback; check(); },
    // Keep the complete outgoing view on failure, available to the next retry.
    fail(error) {
      const firstFailure = !failed;
      sealed = false; failed = true; releaseRetirement();
      if (firstFailure && error !== undefined)
        (onFailure ?? (value => console.warn('[Map handoff] Replacement unavailable:', value)))(error);
    },
    dispose(keepCover = false) {
      if (disposed) return;
      disposed = true;
      releaseRetirement();
      for (const event of events) viewer.removeHandler?.(event, check);
      viewer.removeHandler?.('before-destroy', destroy);
      viewer.removeHandler?.('add-item-failed', additionFailed);
      viewer.removeHandler?.('tile-load-failed', tileFailed);
      viewer.world?.removeHandler?.('add-item', added);
      viewer.world?.removeHandler?.('remove-item', removed);
      for (const event of imageEvents) viewer.overlaysContainer?.removeEventListener(event, check, true);
      for (const item of watched) unwatch(item);
      if (viewer.overlaysContainer) viewer.overlaysContainer.style.visibility = overlayVisibility;
      if (!keepCover && cover) { cover.element.remove(); cover.image.width = cover.image.height = 0; }
      if (active.get(viewer) === transaction) active.delete(viewer);
    },
  };
  active.set(viewer, transaction);
  for (const event of events) viewer.addHandler?.(event, check);
  viewer.addHandler?.('before-destroy', destroy);
  viewer.addHandler?.('add-item-failed', additionFailed);
  viewer.addHandler?.('tile-load-failed', tileFailed);
  viewer.world?.addHandler?.('add-item', added);
  viewer.world?.addHandler?.('remove-item', removed);
  for (const event of imageEvents) viewer.overlaysContainer?.addEventListener(event, check, true);
  for (let i = 0; i < (viewer.world?.getItemCount() ?? 0); i++) watch(viewer.world.getItemAt(i));
  return transaction;
}
