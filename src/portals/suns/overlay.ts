import type OSD from 'openseadragon';
import { readCameraMatrix } from '../geometry';
import { SUNS, SUN_FRAME_SIZE, SUN_REVISION, type SunEffect, type SunPlacement } from './placements';
import { sunVisibility } from './visibility';
import type { SunFrameStats, SunResponse, SunWorker } from './protocol';
import { SunFramePacing } from './frame-pacing';
import { MoonPatches, type MoonPatchViewer } from './moon-patches';

declare const OpenSeadragon: typeof OSD;
const EVENTS = ['update-viewport', 'resize', 'rotate', 'flip'];
const PREVIEWS = {
  sun: new URL('./sun-preview.webp', import.meta.url).href,
  dark_sun: new URL('./dark-sun-preview.webp', import.meta.url).href,
};
interface Viewer extends MoonPatchViewer {
  canvas: HTMLElement;
  viewport: { pixelFromPoint(point: OSD.Point, current?: boolean): { x: number; y: number }; getFlip?(): boolean };
  addHandler(name: string, callback: () => void): void;
  removeHandler(name: string, callback: () => void): void;
}
type Figure = {
  sun: SunPlacement; element: HTMLDivElement; preview: HTMLImageElement; canvas: HTMLCanvasElement;
  context: ImageBitmapRenderingContext | null; hasFrame: boolean; previewReady: boolean; active: boolean; prepare: boolean;
  pixels: number; lastRequest: number; animations: Animation[];
};
function makeWorker(): SunWorker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sun-particles' });
}

/** Only two DOM transforms run during camera movement. Simulation, shaders,
 * texture uploads and frame preparation run in a lazily-created worker. */
export class SunOverlay {
  private layer = document.createElement('div');
  private figures: Figure[];
  private worker: SunWorker | null = null;
  private ready = false;
  private destroyed = false;
  private enabled = true;
  private inFlight: Figure | null = null;
  private raf = 0;
  private error: string | null = null;
  private startupMS = 0;
  private latest: SunFrameStats | null = null;
  private transitions = 0;
  private frames = 0;
  private pacing = new SunFramePacing();
  private deliveryMS = 0;
  private submittedAt = 0;
  private moons: MoonPatches;
  constructor(private viewer: Viewer, private seed: number, private factory = makeWorker, enabled = true,
    effects: readonly SunEffect[] = [], baked = false) {
    this.enabled = enabled;
    this.layer.className = 'noitamap-suns';
    this.layer.setAttribute('aria-hidden', 'true');
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
    this.moons = new MoonPatches(viewer, () => {
      this.setEnabled(false); // Keep the original Moon if its replacement cannot be presented.
      this.fail('Unable to load the Moon replacement background');
    }, baked);
    this.figures = SUNS.filter(sun => effects.includes(sun.effect)).map(sun => {
      const element = document.createElement('div'), preview = document.createElement('img'), canvas = document.createElement('canvas');
      element.dataset.effect = sun.effect;
      Object.assign(element.style, { position: 'absolute', width: `${SUN_FRAME_SIZE}px`, height: `${SUN_FRAME_SIZE}px`,
        transformOrigin: '0 0', isolation: 'isolate' });
      // The map intentionally pixelates terrain tiles. Dust's smooth Sun sprites
      // must override that rule on both the initial still and live bitmap.
      for (const image of [preview, canvas]) Object.assign(image.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', imageRendering: 'auto' });
      preview.alt = ''; preview.decoding = 'async'; preview.draggable = false;
      canvas.hidden = true;
      element.append(preview, canvas); this.layer.append(element);
      const figure: Figure = { sun, element, preview, canvas, context: null, hasFrame: false, previewReady: false, active: false, prepare: false,
        pixels: 0, lastRequest: 0, animations: [] };
      preview.onload = () => {
        if (this.destroyed) return;
        figure.previewReady = preview.naturalWidth > 0;
        this.updateMoonPatches();
      };
      return figure;
    });
    viewer.canvas.append(this.layer);
    for (const event of EVENTS) viewer.addHandler(event, this.update);
    document.addEventListener('visibilitychange', this.update);
    this.update();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.update(); }
  private update = () => {
    if (this.destroyed) return;
    const width = this.viewer.canvas.clientWidth, height = this.viewer.canvas.clientHeight;
    const matrix = readCameraMatrix((x, y) => this.viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true),
      width, this.viewer.viewport.getFlip?.());
    this.layer.hidden = !this.enabled || document.hidden;
    for (const figure of this.figures) {
      const state = sunVisibility(figure.sun, matrix, width, height, figure.active);
      const active = !this.layer.hidden && state.animate;
      if (active !== figure.active) { figure.lastRequest = 0; this.transitions++; }
      figure.active = active; figure.prepare = !this.layer.hidden && state.prepare; figure.pixels = state.pixels;
      figure.element.hidden = !state.visible;
      const x = figure.sun.x - SUN_FRAME_SIZE / 2, y = figure.sun.y - SUN_FRAME_SIZE / 2;
      figure.element.style.transform = `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.a * x + matrix.c * y + matrix.e},${matrix.b * x + matrix.d * y + matrix.f})`;
      if (!this.layer.hidden && state.visible && !figure.preview.hasAttribute('src')) figure.preview.src = PREVIEWS[figure.sun.effect];
    }
    this.updateMoonPatches();
    if (!this.worker && !this.error && this.figures.some(figure => figure.prepare)) this.start();
    if (this.figures.some(figure => figure.active)) this.wake();
    else this.cancel();
  };
  private updateMoonPatches() {
    this.moons.show(this.figures.filter(figure => !this.layer.hidden && !figure.element.hidden &&
      (figure.hasFrame || figure.previewReady)).map(figure => figure.sun.effect));
  }
  private start() {
    try {
      this.worker = this.factory();
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = event => { event.preventDefault(); this.fail(event.message || 'Sun worker failed'); };
      this.worker.postMessage({ type: 'init', seed: this.seed });
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }
  private wake() {
    if (this.destroyed || !this.ready || this.inFlight || this.raf || this.error || this.layer.hidden) return;
    if (this.figures.some(figure => figure.active)) this.raf = requestAnimationFrame(this.draw);
  }
  private cancel() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  private draw = (now: number) => {
    this.raf = 0;
    if (this.destroyed || this.inFlight || !this.ready || this.layer.hidden) return;
    const figure = this.figures.filter(item => item.active).sort((a, b) => a.lastRequest - b.lastRequest)[0];
    if (!figure) return;
    if (figure.lastRequest && now - figure.lastRequest < this.pacing.intervalMS - .5) { this.wake(); return; }
    // One request in flight across both figures, with no message/GPU queue.
    const elapsedMS = figure.lastRequest ? now - figure.lastRequest : 0;
    figure.lastRequest = now;
    this.inFlight = figure; this.submittedAt = performance.now();
    const pixels = figure.pixels / figure.sun.diameter * SUN_FRAME_SIZE * Math.min(2, globalThis.devicePixelRatio || 1);
    try { this.worker!.postMessage({ type: 'frame', ...figure.sun, elapsedMS, pixels }); }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  };
  private receive(data: SunResponse) {
    if (this.destroyed) { if (data.type === 'frame') data.bitmap.close(); return; }
    if (data.type === 'error') { this.fail(data.message); return; }
    if (data.type === 'ready') { this.ready = true; this.startupMS = data.startupMS; this.wake(); return; }
    const figure = this.inFlight; this.inFlight = null;
    if (!figure || figure.sun.effect !== data.effect) { data.bitmap.close(); return; }
    try {
      figure.context ??= figure.canvas.getContext('bitmaprenderer');
      if (!figure.context) throw new Error('Sun bitmap presentation unavailable');
      if (figure.canvas.width !== data.bitmap.width) figure.canvas.width = data.bitmap.width;
      if (figure.canvas.height !== data.bitmap.height) figure.canvas.height = data.bitmap.height;
      figure.context.transferFromImageBitmap(data.bitmap);
      figure.canvas.hidden = false;
      if (!figure.hasFrame) {
        this.reveal(figure);
        figure.hasFrame = true;
        this.updateMoonPatches();
      }
      this.latest = data.stats; this.frames++;
      this.deliveryMS = performance.now() - this.submittedAt;
      this.pacing.observe(Math.max(this.deliveryMS, data.stats.gpuMS ?? 0), data.stats.warm);
      this.wake();
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    finally { data.bitmap.close(); }
  }
  private reveal(figure: Figure) {
    // Additive crossfade inside an isolated group preserves opaque black cores:
    // two ordinary overlapping opacity fades would briefly expose the terrain.
    const fade = figure.preview.complete && figure.preview.naturalWidth > 0 &&
      typeof figure.canvas.animate === 'function' && globalThis.CSS?.supports('mix-blend-mode', 'plus-lighter') &&
      !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    figure.preview.style.opacity = '0';
    if (!fade) return;
    figure.canvas.style.mixBlendMode = 'plus-lighter';
    const options = { duration: 140, easing: 'linear' };
    figure.animations = [figure.preview.animate([{ opacity: 1 }, { opacity: 0 }], options),
      figure.canvas.animate([{ opacity: 0 }, { opacity: 1 }], options)];
    void Promise.all(figure.animations.map(animation => animation.finished)).then(() => {
      figure.canvas.style.mixBlendMode = 'normal'; figure.animations = [];
    }).catch(() => {});
  }
  private fail(message: string) {
    this.error = message; this.ready = false; this.cancel(); this.worker?.terminate(); this.worker = null; this.inFlight = null;
    // Retain the last successful image, or the still preview on cold failure.
    console.warn('[Suns] Keeping still image:', message);
  }
  stats() {
    return { revision: SUN_REVISION, status: this.error ? 'error' :
      !this.enabled ? 'disabled' : !this.worker ? 'still' : !this.ready ? 'loading' :
      !this.layer.hidden && this.figures.some(figure => figure.active) ? 'animated' : 'paused',
    effects: this.figures.map(figure => figure.sun.effect),
    error: this.error, startupMS: this.startupMS, frames: this.frames, transitions: this.transitions, targetFPS: this.pacing.fps,
    inFlight: Boolean(this.inFlight), deliveryMS: this.deliveryMS, ...this.latest };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.cancel(); this.worker?.terminate(); this.worker = null;
    this.moons.destroy();
    for (const event of EVENTS) this.viewer.removeHandler(event, this.update);
    document.removeEventListener('visibilitychange', this.update);
    for (const figure of this.figures) {
      figure.preview.onload = null;
      for (const animation of figure.animations) animation.cancel();
      figure.context?.transferFromImageBitmap(null); figure.canvas.width = figure.canvas.height = 1;
    }
    this.layer.remove();
  }
}
