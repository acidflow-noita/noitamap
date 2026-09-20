import OpenSeadragon from 'openseadragon';
import { canvasResolution, MAX_ACTIVE_PORTALS, reprojectCamera, type CameraMatrix } from './geometry';
import { FRAME_MS, PORTAL_RENDERER_REVISION, type PortalCamera, type PortalGPUStats,
  type PortalWorker, type PortalWorkerResponse, type PortalWorkerOptions } from './protocol';
import type { PortalPlacement } from './placements';
export type { PortalGPUStats } from './protocol';

const events = ['update-viewport', 'resize', 'rotate', 'flip'];
const OVERSCAN = 64;
interface Viewer {
  canvas: HTMLElement;
  viewport: { pixelFromPoint(point: OpenSeadragon.Point, current?: boolean): { x: number; y: number }; getFlip?(): boolean };
  addHandler(name: string, callback: () => void): void;
  removeHandler(name: string, callback: () => void): void;
}
export async function loadPortalResources(signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(new URL('./assets/effects.bin', import.meta.url), { signal });
  if (!response.ok) throw new Error(`Portal resources: HTTP ${response.status}`);
  return response.arrayBuffer();
}
export function createGPURuntime(): PortalWorker {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined')
    throw new Error('Experimental GPU portals require workers and OffscreenCanvas. No main-thread/CPU fallback is enabled.');
  return new Worker(new URL('./portal-worker.ts', import.meta.url), { type: 'module', name: 'portal-gpu' });
}

/** One worker-owned WebGL context; the UI only presents GPU-backed bitmaps and
 * reprojects the last completed frame synchronously with OpenSeadragon draws. */
export class PortalGPUOverlay {
  readonly canvas = document.createElement('canvas');
  private layer = document.createElement('div');
  private context: ImageBitmapRenderingContext;
  private worker: PortalWorker;
  private ready = false;
  private destroyed = false;
  private enabled = true;
  private frame = 0;
  private requestID = 0;
  private inFlight: { id: number; cameraRevision: number; started: number } | null = null;
  private cameraRevision = 0;
  private lastRequest = 0;
  private lastSentCameraRevision = -1;
  private lastPresented = 0;
  private lastPublish = -Infinity;
  private camera: PortalCamera | null = null;
  private renderedCamera: PortalCamera | null = null;
  private latest: PortalGPUStats;
  private displayedPortalIDs: readonly string[] = [];

  constructor(private viewer: Viewer, portals: PortalPlacement[], seed: number, resources: ArrayBuffer,
    factory: () => PortalWorker, private publish: (stats: PortalGPUStats) => void,
    private failure: (error: unknown) => void,
    private showBackgrounds: (ids: readonly string[]) => void = () => {}) {
    this.canvas.className = 'noitamap-portal-gpu';
    this.canvas.dataset.renderer = 'experimental-gpu-particles';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none',
      mixBlendMode: 'screen', transformOrigin: '0 0', willChange: 'transform', imageRendering: 'pixelated' });
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
    const context = this.canvas.getContext('bitmaprenderer');
    if (!context) throw new Error('GPU bitmap presentation unavailable. No CPU renderer fallback is enabled.');
    this.context = context;
    const params = new URLSearchParams(location.search);
    const min = Number(params.get('portalGpuMinPixels') ?? 1.5);
    const limit = Number(params.get('portalGpuLimit') ?? MAX_ACTIVE_PORTALS);
    const options: PortalWorkerOptions = {
      minPixels: Number.isFinite(min) && min >= 0 ? min : 1.5,
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(MAX_ACTIVE_PORTALS, limit) : MAX_ACTIVE_PORTALS,
    };
    this.latest = { mode: 'experimental-gpu-particles', executionThread: 'worker', revision: PORTAL_RENDERER_REVISION,
      total: portals.length, visible: 0, active: 0, capped: 0, particles: 0, visibleParticles: 0,
      cpuMS: 0, gpuMS: null, gpuWaitMS: 0, frameMS: 0, fps: 0, steps: 0, simFPS: 0, deliveryMS: 0, canvasPixels: 0, estimatedGPUBytes: 0,
      device: 'Initializing worker WebGL2', suspended: false, slow: false };
    this.worker = factory();
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message || 'Portal GPU worker failed')); };
    try {
      this.worker.postMessage({ type: 'init', resources, portals, seed, options }, [resources]);
      this.layer.append(this.canvas); viewer.canvas.append(this.layer);
      for (const event of events) viewer.addHandler(event, this.cameraChanged);
      document.addEventListener('visibilitychange', this.visibilityChanged);
      this.cameraChanged();
    } catch (error) { this.destroy(); throw error; }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.lastRequest = this.lastPresented = 0;
    if (!enabled) { this.cancel(); this.canvas.hidden = true; this.showBackgrounds([]); }
    else { this.cameraChanged(); }
  }
  private visibilityChanged = () => {
    this.lastRequest = this.lastPresented = 0;
    if (document.hidden) { this.cancel(); this.canvas.hidden = true; this.showBackgrounds([]); }
    else { this.cameraChanged(); }
  };
  private cameraChanged = () => {
    if (this.destroyed) return;
    const width = this.viewer.canvas.clientWidth, height = this.viewer.canvas.clientHeight;
    const point = (x: number, y: number) => this.viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
    const o = point(0, 0), x = point(1, 0), y = point(0, 1);
    const matrix: CameraMatrix = { a: x.x - o.x, b: x.y - o.y, c: y.x - o.x, d: y.y - o.y, e: o.x, f: o.y };
    if (this.viewer.viewport.getFlip?.()) { matrix.a *= -1; matrix.c *= -1; matrix.e = width - matrix.e; }
    if (!this.camera || width !== this.camera.width || height !== this.camera.height ||
      (Object.keys(matrix) as (keyof CameraMatrix)[]).some(key => matrix[key] !== this.camera!.matrix[key])) this.cameraRevision++;
    this.camera = { matrix, width, height, resolution: 1 };
    // Do this in OSD's draw event, NOT a later animation frame or worker reply.
    this.reproject();
    this.wake();
  };
  private reproject() {
    if (!this.camera || !this.renderedCamera) return;
    const m = reprojectCamera(this.camera.matrix, this.renderedCamera.matrix);
    this.canvas.hidden = !m || !this.enabled || document.hidden;
    this.showBackgrounds(this.canvas.hidden ? [] : this.displayedPortalIDs);
    if (m) this.canvas.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
  }
  private wake() {
    if (this.destroyed || !this.enabled || document.hidden || !this.ready || this.inFlight || this.frame) return;
    this.frame = requestAnimationFrame(this.draw);
  }
  private cancel() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  private draw = (now: number) => {
    this.frame = 0;
    if (this.destroyed || !this.enabled || document.hidden || this.inFlight || !this.camera) return;
    // Avoid zero-step redraws at 120/144Hz, but never impose extra idle time
    // after expensive work. Camera changes may redraw before the next step.
    if (this.lastRequest && now - this.lastRequest < FRAME_MS - .5 &&
      this.lastSentCameraRevision === this.cameraRevision) { this.wake(); return; }
    const { matrix, width, height } = this.camera;
    if (width <= 0 || height <= 0 || !Object.values(matrix).every(Number.isFinite)) return;
    const paddedWidth = width + OVERSCAN * 2, paddedHeight = height + OVERSCAN * 2;
    const camera: PortalCamera = { matrix: { ...matrix, e: matrix.e + OVERSCAN, f: matrix.f + OVERSCAN },
      width: paddedWidth, height: paddedHeight, resolution: canvasResolution(paddedWidth, paddedHeight, globalThis.devicePixelRatio) };
    const id = ++this.requestID;
    this.inFlight = { id, cameraRevision: this.cameraRevision, started: performance.now() };
    const elapsed = this.lastRequest ? Math.max(0, now - this.lastRequest) : 0;
    this.lastRequest = now;
    this.lastSentCameraRevision = this.cameraRevision;
    try { this.worker.postMessage({ type: 'frame', id, camera, elapsed }); }
    catch (error) { this.fail(error); }
  };
  private receive(data: PortalWorkerResponse) {
    if (this.destroyed) { if (data.type === 'frame') data.bitmap.close(); return; }
    if (data.type === 'error') { this.fail(new Error(data.message)); return; }
    if (data.type === 'ready') { this.ready = true; this.wake(); return; }
    if (data.id !== this.inFlight?.id) { data.bitmap.close(); return; }
    const { cameraRevision, started } = this.inFlight;
    this.inFlight = null;
    try {
      const now = performance.now();
      const fps = this.lastPresented ? 1000 / Math.max(1, now - this.lastPresented) : 0;
      const simFPS = fps * data.stats.steps;
      this.latest = { ...data.stats, fps: this.latest.fps ? this.latest.fps * .8 + fps * .2 : fps,
        simFPS: this.latest.simFPS ? this.latest.simFPS * .8 + simFPS * .2 : simFPS,
        deliveryMS: Math.max(0, now - started - data.stats.frameMS) };
      this.lastPresented = now;
      if (this.canvas.width !== data.bitmap.width) this.canvas.width = data.bitmap.width;
      if (this.canvas.height !== data.bitmap.height) this.canvas.height = data.bitmap.height;
      this.context.transferFromImageBitmap(data.bitmap);
      this.canvas.style.width = `${data.camera.width}px`; this.canvas.style.height = `${data.camera.height}px`;
      this.renderedCamera = data.camera;
      this.displayedPortalIDs = data.activePortalIDs;
      this.reproject(); // Even an old worker camera is aligned to the CURRENT map.
      if (now - this.lastPublish >= 250) { this.lastPublish = now; this.publish(this.stats()); }
      // A camera move while this frame was in flight must still request a new
      // frame, even if the old view contained zero portals.
      const moved = cameraRevision !== this.cameraRevision;
      if (data.stats.active || moved) this.wake(); else this.lastRequest = 0;
    } catch (error) { this.fail(error); }
    finally { data.bitmap.close(); }
  }
  private fail(error: unknown) { this.destroy(); this.failure(error); }
  stats(): PortalGPUStats { return { ...this.latest, suspended: !this.enabled || document.hidden }; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.cancel(); this.showBackgrounds([]);
    for (const event of events) this.viewer.removeHandler(event, this.cameraChanged);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.worker.terminate(); this.layer.remove();
    this.context.transferFromImageBitmap(null);
    this.canvas.width = this.canvas.height = 1;
  }
}
