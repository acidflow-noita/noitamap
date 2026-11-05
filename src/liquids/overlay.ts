import { readCameraMatrix, type CameraMatrix } from '../portals/geometry';
import { liquidScreenCrop, liquidViewBounds } from './geometry';
import { LiquidMaskProvider, type LiquidMaskInputs } from './mask-provider';
import type { ViewLiquidMask } from './mask-worker-client';
import type { LiquidRenderer } from './renderer.mjs';
import { LiquidSnapshot } from './snapshot';

declare const OpenSeadragon: any;
const MOVEMENT = ['pan', 'zoom', 'resize', 'rotate', 'flip'];
const CONTENT = ['terrain-cache-ready', 'terrain-frame-ready'];
const IMAGE_CHANGES = ['opacity-change', 'bounds-change', 'clip-change', 'composite-operation-change'];
const FRAME_INTERVAL = 1000 / 30;
interface ReadyFrame { key: string; camera: CameraMatrix; mask: ViewLiquidMask; signal: AbortSignal }
export interface LiquidOverlayDeps {
  provider: Pick<LiquidMaskProvider, 'prepare' | 'stats' | 'destroy'>;
  renderer(canvas: HTMLCanvasElement): Pick<LiquidRenderer, 'setSource' | 'render' | 'stats' | 'dispose'>;
  bitmap: typeof createImageBitmap;
}

/** The map paints independently. Query masks after navigation settles, capture
 * one finished raster crop, then animate only that crop at a capped cadence.
 * No terrain draw/readback, mask generation or upload runs in the frame loop. */
export class LiquidOverlay {
  private osd: any;
  private canvas = document.createElement('canvas');
  private provider: LiquidOverlayDeps['provider'];
  private renderer?: ReturnType<LiquidOverlayDeps['renderer']>;
  private rendererFactory?: LiquidOverlayDeps['renderer'];
  private bitmap: (source: HTMLCanvasElement, x: number, y: number, width: number, height: number,
    renderWidth: number, renderHeight: number) => Promise<ImageBitmap>;
  private snapshot?: LiquidSnapshot;
  private controller = new AbortController();
  private ready?: ReadyFrame;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private captureRequested = false;
  private capturing = false;
  private raf = 0;
  private lastFrame = 0;
  private elapsed = 0;
  private fadeStart = 0;
  private zoomActive = false;
  private destroyed = false;
  private enabled = true;
  private state = 'waiting';
  private error: string | null = null;
  private frames = 0;
  private captures = 0;
  private contentRevision = 0;
  private watchedImages = new Set<any>();
  private media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  constructor(private viewer: any, inputs: LiquidMaskInputs, deps?: Partial<LiquidOverlayDeps>) {
    this.osd = viewer.viewer ?? viewer;
    this.provider = deps?.provider ?? new LiquidMaskProvider(inputs);
    this.rendererFactory = deps?.renderer;
    this.bitmap = deps?.bitmap ? ((source, x, y, width, height, renderWidth, renderHeight) =>
      deps.bitmap!(source, x, y, width, height, { resizeWidth: renderWidth, resizeHeight: renderHeight, resizeQuality: 'pixelated' }))
      : ((source, x, y, width, height, renderWidth, renderHeight) =>
        (this.snapshot ??= new LiquidSnapshot()).capture(source, x, y, width, height, renderWidth, renderHeight));
    this.canvas.className = 'noitamap-liquid-wobble'; this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', imageRendering: 'auto' });
    this.canvas.hidden = true;
    // Terrain is OSD's first canvas; particle and interactive overlay layers
    // remain above refraction. POI footprints are excluded from the mask.
    const terrain = this.osd.drawer?.canvas;
    if (terrain?.parentElement === viewer.canvas) terrain.after(this.canvas);
    else viewer.canvas.prepend(this.canvas);
    for (const name of MOVEMENT) viewer.addHandler(name, this.invalidate);
    for (const name of CONTENT) viewer.addHandler(name, this.invalidateColor);
    viewer.addHandler('tile-loaded', this.invalidateTile);
    viewer.addHandler('tile-invalidated', this.invalidateTile);
    viewer.addHandler('update-viewport', this.onDraw);
    viewer.addHandler('animation-finish', this.invalidate);
    viewer.world.addHandler('add-item', this.worldChanged);
    viewer.world.addHandler('remove-item', this.worldChanged);
    viewer.world.addHandler('item-index-change', this.invalidateColor);
    this.watchImages();
    viewer.addHandler('destroy', this.destroy);
    document.addEventListener('visibilitychange', this.invalidate);
    this.media?.addEventListener('change', this.invalidate);
    this.canvas.addEventListener('webglcontextlost', this.pause);
    this.canvas.addEventListener('webglcontextrestored', this.invalidateColor);
    this.invalidate();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.invalidate(); }
  private camera() {
    const width = this.viewer.canvas.clientWidth, height = this.viewer.canvas.clientHeight;
    const matrix = readCameraMatrix((x, y) => this.viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true),
      width, this.viewer.viewport.getFlip?.());
    return { matrix, width, height, key: Object.values(matrix).concat(width, height).join('/') };
  }
  private pause = () => {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0; this.lastFrame = 0; this.canvas.hidden = true; this.state = 'paused';
  };
  private invalidate = () => {
    if (this.destroyed) return;
    this.pause(); this.ready = undefined; this.captureRequested = false;
    clearTimeout(this.timer); clearTimeout(this.captureTimer);
    this.controller.abort(); this.controller = new AbortController();
    if (!this.enabled || document.hidden || this.media?.matches) { this.state = 'disabled'; return; }
    const { matrix, width, height } = this.camera();
    const bounds = liquidViewBounds(matrix, width, height, this.zoomActive);
    this.zoomActive = !!bounds;
    if (!bounds) { this.state = 'zoomed-out'; return; }
    this.state = 'waiting';
    this.timer = setTimeout(() => { this.timer = undefined; void this.prepare(); }, 160);
  };
  private async prepare() {
    if (this.destroyed || !this.enabled || document.hidden || this.osd.isAnimating?.()) return;
    const { key, matrix, width, height } = this.camera();
    const bounds = liquidViewBounds(matrix, width, height, this.zoomActive); if (!bounds) return;
    const signal = this.controller.signal;
    this.state = 'preparing';
    try {
      const mask = await this.provider.prepare(bounds, signal);
      if (signal.aborted || this.destroyed || key !== this.camera().key) return;
      if (!mask) { this.state = 'no-visible-liquids'; return; }
      this.ready = { key, camera: matrix, mask, signal };
      this.requestCapture();
    } catch (error) { if (!signal.aborted && !this.destroyed) this.fail(error); }
  }
  private invalidateColor = () => {
    if (this.destroyed) return;
    if (this.provider.stats().generatedPending) { this.invalidate(); return; }
    if (!this.ready || this.ready.signal.aborted) return;
    this.contentRevision++;
    this.pause(); clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => { this.captureTimer = undefined; this.requestCapture(); }, 80);
  };
  private invalidateTile = (event?: any) => {
    this.invalidateColor();
    // Do not return an event's own processing promise to OSD's event barrier.
    if (event?.promise) void Promise.resolve(event.promise).then(this.invalidateColor, () => {});
  };
  private watchImages() {
    const world = this.viewer.world;
    const present = new Set(Array.from({ length: world.getItemCount?.() ?? 0 }, (_, index) => world.getItemAt(index)));
    for (const item of this.watchedImages) if (!present.has(item)) {
      for (const name of IMAGE_CHANGES) item.removeHandler?.(name, this.invalidateColor);
      this.watchedImages.delete(item);
    }
    for (const item of present) if (item?.addHandler && !this.watchedImages.has(item)) {
      for (const name of IMAGE_CHANGES) item.addHandler(name, this.invalidateColor);
      this.watchedImages.add(item);
    }
  }
  private worldChanged = () => { this.watchImages(); this.invalidate(); };
  private requestCapture() {
    if (this.destroyed || !this.ready || this.ready.signal.aborted) return;
    this.captureRequested = true;
    // Capture inside update-viewport, while a WebGL drawer's backing buffer is
    // still valid. Only one extra map redraw is requested after masks are ready.
    this.osd.forceRedraw();
  }
  private onDraw = () => {
    if (this.destroyed || !this.ready) return;
    if (this.ready.key !== this.camera().key) { this.invalidate(); return; }
    if (this.osd.isAnimating?.()) return;
    // Some OSD drawers redraw even when their pixels did not change. Actual
    // image/frame events above invalidate content, not the act of drawing.
    if (!this.captureRequested) return;
    if (this.capturing) return;
    this.captureRequested = false; void this.capture(this.ready);
  };
  private async capture(frame: ReadyFrame) {
    const revision = this.contentRevision;
    const source = this.osd.drawer?.canvas;
    if (!source?.width || !source?.height) return;
    const { width, height } = this.camera(), ratio = source.width / width, ratioY = source.height / height;
    const crop = liquidScreenCrop(frame.camera, frame.mask, width, height, ratio, ratioY);
    if (!crop) { this.state = 'pixel-budget'; return; }
    this.capturing = true;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await this.bitmap(source, crop.x, crop.y, crop.width, crop.height, crop.renderWidth, crop.renderHeight);
      if (this.destroyed || frame.signal.aborted || revision !== this.contentRevision ||
        frame !== this.ready || frame.key !== this.camera().key) return;
      if (!this.renderer) {
        let factory = this.rendererFactory;
        if (!factory) {
          const module = await import('./renderer.mjs');
          factory = (canvas: HTMLCanvasElement) => new module.LiquidRenderer(canvas);
        }
        if (this.destroyed || frame.signal.aborted || revision !== this.contentRevision || frame !== this.ready) return;
        this.renderer = factory(this.canvas);
      }
      const mask = frame.mask;
      const reduced = crop.width !== crop.renderWidth || crop.height !== crop.renderHeight;
      const input = { color: bitmap, width: crop.renderWidth, height: crop.renderHeight, reduced,
        mask: mask.pixels, maskWidth: mask.width, maskHeight: mask.height, maskX: mask.x, maskY: mask.y,
        screenToWorld: crop.screenToWorld };
      let uploaded = this.renderer.setSource(input);
      const waitingSince = performance.now();
      while (uploaded === null) {
        frame.signal.throwIfAborted();
        // One retained snapshot, no repeated map redraw/capture, while the GPU
        // finishes its preceding frame. Navigation aborts this wait immediately.
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(frame.signal.reason); };
          const timer = setTimeout(() => { frame.signal.removeEventListener('abort', abort); resolve(); }, FRAME_INTERVAL);
          frame.signal.addEventListener('abort', abort, { once: true });
        });
        if (this.destroyed || frame.signal.aborted || revision !== this.contentRevision || frame !== this.ready) return;
        if (performance.now() - waitingSince > 5000) throw new Error('Liquid GPU did not become ready');
        uploaded = this.renderer.setSource(input);
      }
      if (!uploaded) { this.pause(); this.state = 'paused'; return; }
      Object.assign(this.canvas.style, { left: `${crop.x / ratio}px`, top: `${crop.y / ratioY}px`,
        width: `${crop.width / ratio}px`, height: `${crop.height / ratioY}px`, imageRendering: reduced ? 'pixelated' : 'auto' });
      this.captures++; this.error = null; this.state = 'running';
      this.fadeStart = performance.now(); this.lastFrame = 0;
      this.wake();
    } catch (error) { if (!frame.signal.aborted && !this.destroyed) this.fail(error); }
    finally {
      bitmap?.close(); this.capturing = false;
      if (this.captureRequested && !this.destroyed) this.osd.forceRedraw();
    }
  }
  private wake() {
    if (this.raf || this.destroyed || this.state !== 'running' || document.hidden || !this.enabled) return;
    this.raf = requestAnimationFrame(this.draw);
  }
  private draw = (now: number) => {
    this.raf = 0;
    if (this.destroyed || this.state !== 'running' || document.hidden || this.ready?.signal.aborted) return;
    if (this.lastFrame && now - this.lastFrame < FRAME_INTERVAL - 0.5) { this.wake(); return; }
    if (this.lastFrame) this.elapsed += Math.min(100, now - this.lastFrame) / 1000;
    this.lastFrame = now;
    try {
      const rendered = this.renderer?.render(this.elapsed, Math.min(1, (now - this.fadeStart) / 140));
      if (rendered === false || rendered === undefined) {
        this.pause(); this.state = 'paused'; return;
      }
      if (rendered) { this.canvas.hidden = false; this.frames++; }
      this.wake();
    } catch (error) { this.fail(error); }
  };
  private fail(error: unknown) {
    this.pause(); this.state = 'error'; this.error = error instanceof Error ? error.message : String(error);
    console.warn('[Liquid wobble] Keeping the original map:', this.error);
  }
  stats() { return { status: this.state, error: this.error, frames: this.frames, captures: this.captures,
    targetFPS: 30, ...this.provider.stats(), renderer: this.renderer?.stats() ?? null }; }
  destroy = () => {
    if (this.destroyed) return;
    this.destroyed = true; this.controller.abort(); this.pause();
    clearTimeout(this.timer); clearTimeout(this.captureTimer);
    for (const name of MOVEMENT) this.viewer.removeHandler(name, this.invalidate);
    for (const name of CONTENT) this.viewer.removeHandler(name, this.invalidateColor);
    this.viewer.removeHandler('tile-loaded', this.invalidateTile);
    this.viewer.removeHandler('tile-invalidated', this.invalidateTile);
    this.viewer.removeHandler('update-viewport', this.onDraw);
    this.viewer.removeHandler('animation-finish', this.invalidate);
    this.viewer.world.removeHandler('add-item', this.worldChanged);
    this.viewer.world.removeHandler('remove-item', this.worldChanged);
    this.viewer.world.removeHandler('item-index-change', this.invalidateColor);
    for (const item of this.watchedImages)
      for (const name of IMAGE_CHANGES) item.removeHandler?.(name, this.invalidateColor);
    this.watchedImages.clear();
    this.viewer.removeHandler('destroy', this.destroy);
    document.removeEventListener('visibilitychange', this.invalidate);
    this.media?.removeEventListener('change', this.invalidate);
    this.canvas.removeEventListener('webglcontextlost', this.pause);
    this.canvas.removeEventListener('webglcontextrestored', this.invalidateColor);
    this.provider.destroy(); this.snapshot?.destroy(); this.renderer?.dispose(); this.canvas.remove(); this.ready = undefined;
  };
}
