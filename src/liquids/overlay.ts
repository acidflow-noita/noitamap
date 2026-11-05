import { readCameraMatrix, type CameraMatrix } from '../portals/geometry';
import { liquidBoundsContain, liquidBoundsOverlap, liquidCropContains, liquidReprojection, liquidScreenCrop, liquidViewBounds, visibleLiquidBounds } from './geometry';
import type { MaskBounds } from './mask-index';
import { LiquidMaskProvider, type LiquidMaskInputs } from './mask-provider';
import type { ViewLiquidMask } from './mask-worker-client';
import type { LiquidRenderer } from './renderer.mjs';
import { LiquidSnapshot } from './snapshot';

declare const OpenSeadragon: any;
const MOVEMENT = ['pan', 'zoom', 'resize', 'rotate', 'flip'];
const CONTENT = ['terrain-cache-ready', 'terrain-frame-ready'];
const IMAGE_CHANGES = ['opacity-change', 'bounds-change', 'clip-change', 'composite-operation-change'];
const FRAME_INTERVAL = 1000 / 30;
const REFRESH_DELAY = 16;
const CONTENT_REFRESH_DELAY = 160;
interface ReadyFrame { key: string; camera: CameraMatrix; mask: ViewLiquidMask; signal: AbortSignal }
interface PresentedFrame { key: string; camera: CameraMatrix; crop: MaskBounds }
export interface LiquidOverlayDeps {
  provider: Pick<LiquidMaskProvider, 'prepare' | 'stats' | 'destroy'>;
  renderer(canvas: HTMLCanvasElement): Pick<LiquidRenderer, 'setSource' | 'render' | 'stats' | 'dispose'>;
  bitmap: typeof createImageBitmap;
}

/** The map paints independently. Reproject the completed animated crop during
 * navigation while its replacement prepares. Refreshes never blank that crop.
 * No terrain draw/readback, mask generation or upload runs in the frame loop. */
export class LiquidOverlay {
  private osd: any;
  private canvas = document.createElement('canvas');
  private layer = document.createElement('div');
  private provider: LiquidOverlayDeps['provider'];
  private renderer?: ReturnType<LiquidOverlayDeps['renderer']>;
  private rendererFactory?: LiquidOverlayDeps['renderer'];
  private bitmap: (source: HTMLCanvasElement, x: number, y: number, width: number, height: number,
    renderWidth: number, renderHeight: number) => Promise<ImageBitmap>;
  private snapshot?: LiquidSnapshot;
  private controller = new AbortController();
  private ready?: ReadyFrame;
  private presented?: PresentedFrame;
  private cameraKey = '';
  private preparing?: AbortSignal;
  private preparingBounds?: MaskBounds;
  private knownMask?: ViewLiquidMask;
  private reusedMasks = 0;
  private phase = 'waiting';
  private lastCaptureMs = 0;
  private uploadPending = false;
  private contextLost = false;
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
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', imageRendering: 'auto',
      transformOrigin: '0 0', willChange: 'transform' });
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    this.layer.append(this.canvas);
    this.canvas.hidden = true;
    // Terrain is OSD's first canvas; particle and interactive overlay layers
    // remain above refraction. POI footprints are excluded from the mask.
    const terrain = this.osd.drawer?.canvas;
    if (terrain?.parentElement === viewer.canvas) terrain.after(this.layer);
    else viewer.canvas.prepend(this.layer);
    for (const name of MOVEMENT) viewer.addHandler(name, this.cameraChanged);
    for (const name of CONTENT) viewer.addHandler(name, this.invalidateColor);
    viewer.addHandler('tile-loaded', this.invalidateTile);
    viewer.addHandler('tile-invalidated', this.invalidateTile);
    viewer.addHandler('update-viewport', this.onDraw);
    viewer.addHandler('animation-finish', this.finishMovement);
    viewer.world.addHandler('add-item', this.worldChanged);
    viewer.world.addHandler('remove-item', this.worldChanged);
    viewer.world.addHandler('item-index-change', this.invalidateAppearance);
    this.watchImages();
    viewer.addHandler('destroy', this.destroy);
    document.addEventListener('visibilitychange', this.invalidate);
    this.media?.addEventListener('change', this.invalidate);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
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
    this.raf = 0; this.lastFrame = 0; this.canvas.hidden = true; this.presented = undefined; this.state = 'paused';
  };
  private invalidate = () => {
    if (this.destroyed) return;
    this.pause(); this.cameraKey = ''; this.knownMask = undefined;
    this.resetPending(); this.cameraChanged();
  };
  private resetPending() {
    this.ready = undefined; this.captureRequested = false;
    this.preparing = undefined; this.preparingBounds = undefined;
    clearTimeout(this.timer); clearTimeout(this.captureTimer);
    this.timer = this.captureTimer = undefined;
    this.controller.abort(); this.controller = new AbortController();
  }
  private cameraChanged = () => {
    if (this.destroyed) return;
    if (!this.enabled || document.hidden || this.media?.matches || this.contextLost) {
      this.pause(); this.resetPending(); this.state = 'disabled'; return;
    }
    const camera = this.camera(), { matrix, width, height, key } = camera;
    const bounds = liquidViewBounds(matrix, width, height, this.zoomActive);
    this.zoomActive = !!bounds;
    if (!bounds) {
      this.pause(); this.resetPending(); this.cameraKey = ''; this.state = 'zoomed-out'; return;
    }
    if (key === this.cameraKey) return;
    this.reproject(camera);
    this.cameraKey = key;
    // World-space masks survive camera changes. Cancel only work for a view
    // that has actually left the screen, not every spring-animation frame.
    const pendingRegion = this.preparingBounds ?? this.ready?.mask.coverage ?? this.ready?.mask;
    if (pendingRegion && !liquidBoundsOverlap(pendingRegion, bounds)) this.resetPending();
    if (this.knownMask?.coverage && liquidBoundsContain(this.knownMask.coverage, bounds)) {
      this.reusedMasks++;
      this.ready = { key, camera: matrix, mask: this.knownMask, signal: this.controller.signal };
      this.requestExposedPixels(camera);
      if (!this.osd.isAnimating?.() && this.presented?.key !== key) this.scheduleCapture();
      return;
    }
    this.requestExposedPixels(camera);
    if (!this.presented) this.state = 'waiting';
    this.schedulePreparation();
  };
  private finishMovement = () => {
    if (this.destroyed || !this.enabled || document.hidden || this.media?.matches || this.contextLost) return;
    this.cameraChanged();
    if (!this.zoomActive) return;
    clearTimeout(this.timer); this.timer = undefined;
    const camera = this.camera(), bounds = liquidViewBounds(camera.matrix, camera.width, camera.height, this.zoomActive)!;
    if (this.ready && this.presented?.key !== camera.key) this.requestCapture();
    if (!this.knownMask?.coverage || !liquidBoundsContain(this.knownMask.coverage, bounds) || this.provider.stats().generatedPending)
      void this.prepare();
    else if (this.captureRequested) this.osd.forceRedraw();
  };
  private schedulePreparation() {
    if (this.timer !== undefined || this.preparing === this.controller.signal) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.prepare(); }, REFRESH_DELAY);
  }
  private requestExposedPixels(camera: ReturnType<LiquidOverlay['camera']>) {
    if (!this.ready || this.ready.signal.aborted) return;
    const wanted = visibleLiquidBounds(camera.matrix, this.ready.mask, camera.width, camera.height);
    if (!wanted) return;
    if (!this.presented || this.canvas.hidden) { this.requestCapture(); return; }
    if (!liquidCropContains(camera.matrix, this.presented.camera, this.presented.crop, wanted)) this.scheduleCapture();
  }
  private acceptMask(mask: ViewLiquidMask, signal: AbortSignal) {
    if (signal.aborted || this.destroyed) return;
    if (mask.complete && mask.coverage) this.knownMask = mask;
    const { key, matrix, width, height } = this.camera();
    const view = liquidViewBounds(matrix, width, height, this.zoomActive);
    if (!view || !liquidBoundsOverlap(mask, view)) return;
    this.ready = { key, camera: matrix, mask, signal };
    this.requestCapture();
  }
  private reproject(camera = this.camera()) {
    if (!this.presented) return;
    const projection = liquidReprojection(camera.matrix, this.presented.camera, this.presented.crop, camera.width, camera.height);
    this.canvas.hidden = !projection?.visible;
    if (projection) {
      const m = projection.matrix;
      this.canvas.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
    }
    if (this.canvas.hidden) { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.lastFrame = 0; }
    else this.wake();
  }
  private onContextLost = () => { this.contextLost = true; this.invalidate(); };
  private onContextRestored = () => { this.contextLost = false; this.invalidate(); };
  private invalidateAppearance = () => {
    // Layer removal, clipping and opacity alter the meaning of the old image.
    // Unlike arriving higher-resolution tiles, they cannot reuse that image.
    this.invalidate();
  };
  private async prepare() {
    if (this.destroyed || !this.enabled || document.hidden || this.contextLost || this.media?.matches) return;
    const { key, matrix, width, height } = this.camera();
    const bounds = liquidViewBounds(matrix, width, height, this.zoomActive); if (!bounds) return;
    const signal = this.controller.signal;
    if (this.preparing === signal) return;
    if (this.knownMask?.coverage && liquidBoundsContain(this.knownMask.coverage, bounds)) {
      this.reusedMasks++; this.acceptMask(this.knownMask, signal); return;
    }
    this.preparing = signal; this.preparingBounds = bounds; this.phase = 'preparing-mask';
    if (!this.presented) this.state = 'preparing';
    try {
      const mask = await this.provider.prepare(bounds, signal, partial => this.acceptMask(partial, signal));
      if (signal.aborted || this.destroyed) return;
      if (!mask) {
        if (key === this.camera().key) { this.pause(); this.state = 'no-visible-liquids'; }
        return;
      }
      this.acceptMask(mask, signal);
    } catch (error) { if (!signal.aborted && !this.destroyed) this.fail(error); }
    finally {
      if (this.preparing === signal) {
        this.preparing = undefined; this.preparingBounds = undefined;
        if (!signal.aborted && !this.destroyed && key !== this.camera().key) {
          const now = this.camera(), view = liquidViewBounds(now.matrix, now.width, now.height, this.zoomActive);
          if (view && (!this.knownMask?.coverage || !liquidBoundsContain(this.knownMask.coverage, view))) this.schedulePreparation();
        }
      }
    }
  }
  private invalidateColor = () => {
    if (this.destroyed) return;
    if (this.provider.stats().generatedPending && this.timer === undefined && !this.preparing) {
      this.knownMask = undefined; this.schedulePreparation();
    }
    if (!this.ready || this.ready.signal.aborted) return;
    this.contentRevision++;
    // Coalesce from the first update, not the last. A stream of tile arrivals
    // must not postpone capture indefinitely or hide the completed animation.
    this.scheduleCapture();
  };
  private scheduleCapture() {
    if (this.captureTimer === undefined && !this.captureRequested)
      this.captureTimer = setTimeout(() => { this.captureTimer = undefined; this.requestCapture(); }, CONTENT_REFRESH_DELAY);
  }
  private invalidateTile = (event?: any) => {
    this.invalidateColor();
    // Do not return an event's own processing promise to OSD's event barrier.
    if (event?.promise) void Promise.resolve(event.promise).then(this.invalidateColor, () => {});
  };
  private watchImages() {
    const world = this.viewer.world;
    const present = new Set(Array.from({ length: world.getItemCount?.() ?? 0 }, (_, index) => world.getItemAt(index)));
    for (const item of this.watchedImages) if (!present.has(item)) {
      for (const name of IMAGE_CHANGES) item.removeHandler?.(name, this.invalidateAppearance);
      this.watchedImages.delete(item);
    }
    for (const item of present) if (item?.addHandler && !this.watchedImages.has(item)) {
      for (const name of IMAGE_CHANGES) item.addHandler(name, this.invalidateAppearance);
      this.watchedImages.add(item);
    }
  }
  private worldChanged = () => { this.watchImages(); this.invalidate(); };
  private requestCapture() {
    if (this.destroyed || !this.ready || this.ready.signal.aborted) return;
    clearTimeout(this.captureTimer); this.captureTimer = undefined;
    if (this.captureRequested) return;
    this.captureRequested = true;
    // Capture inside update-viewport, while a WebGL drawer's backing buffer is
    // still valid. Only one extra map redraw is requested after masks are ready.
    this.osd.forceRedraw();
  }
  private onDraw = () => {
    if (this.destroyed) return;
    this.cameraChanged();
    if (!this.ready) return;
    // Some OSD drawers redraw even when their pixels did not change. Actual
    // image/frame events above invalidate content, not the act of drawing.
    if (!this.captureRequested) return;
    if (this.capturing) return;
    const { key, matrix } = this.camera();
    this.captureRequested = false; void this.capture({ ...this.ready, key, camera: matrix });
  };
  private async capture(frame: ReadyFrame) {
    const started = performance.now();
    const revision = this.contentRevision;
    const source = this.osd.drawer?.canvas;
    if (!source?.width || !source?.height) return;
    const { width, height } = this.camera(), ratio = source.width / width, ratioY = source.height / height;
    const crop = liquidScreenCrop(frame.camera, frame.mask, width, height, ratio, ratioY);
    if (!crop) { this.state = 'pixel-budget'; return; }
    this.capturing = true;
    this.phase = 'capturing-image';
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await this.bitmap(source, crop.x, crop.y, crop.width, crop.height, crop.renderWidth, crop.renderHeight);
      if (this.destroyed || frame.signal.aborted) return;
      if (!this.renderer) {
        let factory = this.rendererFactory;
        if (!factory) {
          const module = await import('./renderer.mjs');
          factory = (canvas: HTMLCanvasElement) => new module.LiquidRenderer(canvas);
        }
        if (this.destroyed || frame.signal.aborted) return;
        this.renderer = factory(this.canvas);
      }
      const mask = frame.mask;
      const reduced = crop.width !== crop.renderWidth || crop.height !== crop.renderHeight;
      const input = { color: bitmap, width: crop.renderWidth, height: crop.renderHeight, reduced,
        mask: mask.pixels, maskWidth: mask.width, maskHeight: mask.height, maskX: mask.x, maskY: mask.y,
        screenToWorld: crop.screenToWorld };
      const hadFrame = !!this.presented;
      const firstFrame = () => ({ timeSeconds: this.elapsed, strength: hadFrame ? Math.min(1, (performance.now() - this.fadeStart) / 140) : 0 });
      this.uploadPending = true;
      this.phase = 'uploading-image';
      let uploaded = this.renderer.setSource(input, firstFrame());
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
        if (this.destroyed || frame.signal.aborted) return;
        if (performance.now() - waitingSince > 5000) throw new Error('Liquid GPU did not become ready');
        uploaded = this.renderer.setSource(input, firstFrame());
      }
      if (!uploaded) { this.pause(); this.state = 'paused'; return; }
      Object.assign(this.canvas.style, { left: `${crop.x / ratio}px`, top: `${crop.y / ratioY}px`,
        width: `${crop.width / ratio}px`, height: `${crop.height / ratioY}px`, imageRendering: reduced ? 'pixelated' : 'auto' });
      this.presented = { key: frame.key, camera: frame.camera, crop: { x: crop.x / ratio, y: crop.y / ratioY, width: crop.width / ratio, height: crop.height / ratioY } };
      this.captures++; this.error = null; this.state = 'running';
      this.phase = 'ready'; this.lastCaptureMs = performance.now() - started;
      if (!hadFrame) this.fadeStart = performance.now();
      this.lastFrame = performance.now(); this.frames++;
      this.reproject();
      if (revision !== this.contentRevision && this.captureTimer === undefined) this.invalidateColor();
    } catch (error) { if (!frame.signal.aborted && !this.destroyed) this.fail(error); }
    finally {
      bitmap?.close(); this.capturing = false; this.uploadPending = false;
      if (this.captureRequested && !this.destroyed) this.osd.forceRedraw();
    }
  }
  private wake() {
    if (this.raf || this.destroyed || !this.presented || this.canvas.hidden || document.hidden || !this.enabled || this.contextLost) return;
    this.raf = requestAnimationFrame(this.draw);
  }
  private draw = (now: number) => {
    this.raf = 0;
    if (this.destroyed || !this.presented || this.canvas.hidden || document.hidden || !this.enabled || this.contextLost) return;
    if (this.uploadPending) { this.wake(); return; }
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
    targetFPS: 30, phase: this.phase, reusedMasks: this.reusedMasks, lastCaptureMs: this.lastCaptureMs,
    visible: !this.canvas.hidden, ...this.provider.stats(), renderer: this.renderer?.stats() ?? null }; }
  destroy = () => {
    if (this.destroyed) return;
    this.destroyed = true; this.controller.abort(); this.pause();
    clearTimeout(this.timer); clearTimeout(this.captureTimer);
    for (const name of MOVEMENT) this.viewer.removeHandler(name, this.cameraChanged);
    for (const name of CONTENT) this.viewer.removeHandler(name, this.invalidateColor);
    this.viewer.removeHandler('tile-loaded', this.invalidateTile);
    this.viewer.removeHandler('tile-invalidated', this.invalidateTile);
    this.viewer.removeHandler('update-viewport', this.onDraw);
    this.viewer.removeHandler('animation-finish', this.finishMovement);
    this.viewer.world.removeHandler('add-item', this.worldChanged);
    this.viewer.world.removeHandler('remove-item', this.worldChanged);
    this.viewer.world.removeHandler('item-index-change', this.invalidateAppearance);
    for (const item of this.watchedImages)
      for (const name of IMAGE_CHANGES) item.removeHandler?.(name, this.invalidateAppearance);
    this.watchedImages.clear();
    this.viewer.removeHandler('destroy', this.destroy);
    document.removeEventListener('visibilitychange', this.invalidate);
    this.media?.removeEventListener('change', this.invalidate);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.provider.destroy(); this.snapshot?.destroy(); this.renderer?.dispose(); this.layer.remove(); this.ready = undefined; this.presented = undefined; this.knownMask = undefined;
  };
}
