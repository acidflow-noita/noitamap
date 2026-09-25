// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { createInstantTileSource } from '../src/telescope/instant-terrain';
import { installTerrainAdmission } from '../src/osd-terrain-admission';
vi.mock('../src/data_sources/overlays', () => ({ createOverlays: () => [] }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prepareInstantTerrain: vi.fn() }));
vi.mock('../src/telescope/instant-terrain-plane', () => ({ setTerrainPlane: vi.fn() }));

let OSD: any;
let AppOSD: any;
const native = new WeakMap<HTMLCanvasElement, Canvas>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const dimensions = ['width', 'height'] as const;
const descriptors = new Map<string, PropertyDescriptor>();

beforeAll(async () => {
  // Real AppOSD -> Viewer -> World -> CanvasDrawer, with native canvas pixels.
  // jsdom supplies DOM layout only; no browser or network is involved.
  for (const key of dimensions) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!;
    descriptors.set(key, descriptor);
    Object.defineProperty(HTMLCanvasElement.prototype, key, { ...descriptor,
      set(value) { descriptor.set!.call(this, value); const canvas = native.get(this); if (canvas) canvas[key] = value; },
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    let canvas = native.get(this);
    if (!canvas) {
      canvas = createCanvas(this.width || 1, this.height || 1);
      native.set(this, canvas);
      const context = canvas.getContext('2d'), draw = context.drawImage;
      context.drawImage = function(source: any, ...rest: any[]) {
        return (draw as any).call(this, native.get(source) ?? source, ...rest);
      };
    }
    return canvas.getContext('2d') as any;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  OSD = (await import('openseadragon')).default;
  vi.stubGlobal('OpenSeadragon', OSD);
  vi.stubGlobal('localStorage', { getItem: () => null });
  ({ AppOSD } = await import('../src/app_osd'));
  OSD.pixelDensityRatio = 1;
  vi.spyOn(OSD, 'requestAnimationFrame').mockImplementation((callback: any) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.spyOn(OSD, 'cancelAnimationFrame').mockImplementation((id: any) => { frames.delete(id); });
});

it.each([false, true])('runs real cold AppOSD frames through a slow renderer (admission=%s)', async admission => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const app = new AppOSD(mount, false), viewer = app.viewer;
  if (!admission) installTerrainAdmission(viewer)(); // Replay the previous production path.
  const silenceExpectedErrors = vi.spyOn(OSD.console, 'error').mockImplementation(() => {});
  const lifetime = new AbortController();
  const failed: any[] = [], started: any[] = [], finished: any[] = [];
  let active = 0, maximumActive = 0;
  const renderer = { render: (view: any, signal: AbortSignal) => {
    started.push(view); active++; maximumActive = Math.max(maximumActive, active);
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); active--; reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        active--; finished.push(view);
        const canvas = createCanvas(view.width, view.height), context = canvas.getContext('2d');
        context.fillStyle = '#f08020'; context.fillRect(0, 0, canvas.width, canvas.height);
        resolve(canvas);
      }, 1000);
      signal.addEventListener('abort', cancel, { once: true });
    });
  } };
  const source = createInstantTileSource({
    region: { x: -17920, y: -7168, width: 35840, height: 24576, pw: 0 },
    deps: { GLTerrainRenderer: class {} as any, initMaterialAtlas: async () => {},
      getWorldSize: () => 70, getWorldCenter: () => 35, GENERATOR_CONFIG: {} },
    gen: { seed: 42, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(70 * 48) } },
    renderer, signal: lifetime.signal, onFailure: () => {},
    clip: { draw: (context, rendered) => context.drawImage(rendered, 0, 0), dispose() {} },
  });
  viewer.addHandler('tile-load-failed', (event: any) => failed.push(event));
  try {
    const item = await new Promise<any>((resolve, reject) => viewer.addTiledImage({
      tileSource: source, x: -17920, y: -7168, width: 35840,
      success: (event: any) => resolve(event.item), error: reject,
    }));
    viewer.autoResize = false;
    viewer.viewport.resize(new OSD.Point(1920, 1080), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    // Real uncached TileSource + queue; each asynchronous render takes one
    // virtual second. This is a timeout/liveness replay, not a GPU benchmark.
    for (const x of [-8000, 0, 8000]) {
      viewer.viewport.fitBounds(new OSD.Rect(x, 0, 7680, 4320), true);
      for (let i = 0; i < 10; i++) {
        viewer.forceRedraw(); runFrame();
        await vi.advanceTimersByTimeAsync(16);
      }
    }
    const launched = viewer.imageLoader.jobsInProgress;
    if (admission) expect(launched).toBeLessThanOrEqual(2);
    else expect(launched).toBeGreaterThan(60);
    expect(started.length).toBe(2);
    await vi.advanceTimersByTimeAsync(30100);
    const renderedAtDeadline = finished.length;
    expect(maximumActive).toBe(2);
    if (admission) {
      expect(failed).toHaveLength(0);
      // Keep processing real frames after the camera settles. Rejecting every
      // finer-but-OSD-eligible level would otherwise keep loading forever.
      for (let second = 0; second < 180; second++) {
        viewer.forceRedraw(); runFrame();
        await vi.advanceTimersByTimeAsync(1000);
        expect(viewer.imageLoader.jobsInProgress).toBeLessThanOrEqual(2);
        if (item.getFullyLoaded() && viewer.terrainAdmissionStats.active === 0
          && viewer.terrainAdmissionStats.queued === 0) break;
      }
      expect(failed).toHaveLength(0);
      expect(item.getFullyLoaded()).toBe(true);
      expect(viewer.terrainAdmissionStats.active).toBe(0);
      expect(viewer.terrainAdmissionStats.queued).toBe(0);
      expect(viewer.terrainAdmissionStats.discarded).toBeGreaterThan(0);
      expect([...viewer.drawer.context.getImageData(960, 540, 1, 1).data]).toEqual([240, 128, 32, 255]);
    } else {
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every(event => event.message.includes('timeout (30000 ms)'))).toBe(true);
      expect(failed.every(event => event.tile.exists === false)).toBe(true);
    }
    console.info('[Cold AppOSD queue replay]', { admission, launched, renderedAtDeadline, rendered: finished.length,
      timedOut: failed.length, maximumActive, frameBudget: item.maxTilesPerFrame });
  } finally {
    lifetime.abort();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    viewer.destroy(); mount.remove(); frames.clear();
    silenceExpectedErrors.mockRestore();
  }
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) Object.defineProperty(HTMLCanvasElement.prototype, key, descriptor);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function runFrame() {
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

it('reuses previously viewed fine pixels after navigating away through the actual AppOSD frame lifecycle', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const app = new AppOSD(mount, false), viewer = app.viewer;
  let hold = false;
  const pending: any[] = [];
  const source = new OSD.DziTileSource({ width: 4096, height: 4096, tileSize: 256,
    tileOverlap: 1, minLevel: 0, maxLevel: 12, tilesUrl: 'native://', fileFormat: 'png' });
  source.getTileUrl = (level: number, x: number, y: number) => `app:///${level}/${x}/${y}`;
  source.downloadTileStart = (job: any) => {
    if (hold) { pending.push(job); return; }
    const bounds = source.getTileBounds(job.tile.level, job.tile.x, job.tile.y, true);
    const canvas = createCanvas(bounds.width, bounds.height), context = canvas.getContext('2d');
    context.fillStyle = job.tile.level === 12 ? '#f08020' : '#2060a0';
    context.fillRect(0, 0, canvas.width, canvas.height);
    queueMicrotask(() => job.finish(context, null, 'context2d'));
  };
  try {
    const item = await new Promise<any>((resolve, reject) => viewer.addTiledImage({
      tileSource: source, width: 4096, success: (event: any) => resolve(event.item), error: reject,
    }));
    expect(item.getTilesToDraw).not.toBe(OSD.TiledImage.prototype.getTilesToDraw);
    async function load(level: number) {
      const tile = item._getTile(0, 0, level, OSD.now(), source.getNumTiles(level));
      item._loadTile(tile, OSD.now());
      await vi.waitFor(() => expect(tile.loaded).toBe(true));
      return tile;
    }
    await load(8);
    const fine = await load(12);
    hold = true;
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    viewer.forceRedraw(); runFrame();
    const pixel = () => [...viewer.drawer.context.getImageData(8, 8, 1, 1).data];
    expect(pixel()).toEqual([240, 128, 32, 255]);
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 1024, 1024), true);
    viewer.forceRedraw(); runFrame();
    expect(fine.loaded).toBe(true);
    expect(pixel()).toEqual([240, 128, 32, 255]);
    expect(pending.length).toBeGreaterThan(0);

    // Revisit an earlier warmed area after panning elsewhere. The actual fine
    // tile is still in OSD's cache. A preceding-frame-only helper incorrectly
    // forgot it and showed coarse blue pixels despite this completed work.
    viewer.viewport.fitBounds(new OSD.Rect(2048, 2048, 256, 256), true);
    viewer.forceRedraw(); runFrame();
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 1024, 1024), true);
    viewer.forceRedraw(); runFrame();
    expect(fine.loaded).toBe(true);
    expect(pixel()).toEqual([240, 128, 32, 255]);
  } finally {
    viewer.destroy(); mount.remove(); frames.clear();
  }
});
