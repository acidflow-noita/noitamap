// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { applyRetainedTerrainEvent, createInstantTileSource, refreshRetainedTerrain } from '../src/telescope/instant-terrain';
import { createInstantTerrainCooker } from '../src/telescope/instant-terrain-cooker';
import { RetainedTerrain, type StoredTerrain } from '../src/telescope/retained-terrain';
import { installTerrainAdmission } from '../src/osd-terrain-admission';
vi.mock('../src/data_sources/overlays', () => ({ createOverlays: () => [] }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prepareInstantTerrain: vi.fn() }));
vi.mock('../src/telescope/instant-terrain-plane', () => ({ setTerrainPlane: vi.fn() }));
vi.mock('../src/telescope/terrain-elevator', () => ({
  includeElevatorOwnership: (owner: unknown) => owner,
  prepareElevatorShafts: async () => [],
}));

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
    clip: { draw: (context, rendered) => context.drawImage(rendered, 0, 0), hasTerrain: () => true, dispose() {} },
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

it('sharpens a stationary real AppOSD overview as native background cooking completes, preserving transparent holes', async () => {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const app = new AppOSD(mount, false), viewer = app.viewer;
  const lifetime = new AbortController();
  const stored = new Map<string, StoredTerrain>();
  const retention = new RetainedTerrain({
    read: async key => stored.get(key),
    write: async entries => { for (const entry of entries) stored.set(entry.key, entry.value); },
  });
  const failure = vi.fn();
  let item: any;
  const render = vi.fn((view: any) => {
    const canvas = createCanvas(view.width, view.height), context = canvas.getContext('2d');
    context.fillStyle = view.scale === 1 ? '#f08020' : '#2060a0';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (view.scale === 1) {
      context.fillStyle = '#804020';
      for (let y = 8; y < canvas.height; y += 16) context.fillRect(0, y, canvas.width, 8);
      context.clearRect(64 - view.x, 64 - view.y, 64, 64);
    }
    return canvas;
  });
  const source = createInstantTileSource({
    region: { x: 0, y: 0, width: 1024, height: 1024, pw: 0 },
    deps: { GLTerrainRenderer: class {} as any, initMaterialAtlas: async () => {},
      getWorldSize: () => 2, getWorldCenter: () => 0, GENERATOR_CONFIG: {} },
    gen: { seed: 42, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(4) } },
    renderer: { render }, signal: lifetime.signal, onFailure: failure,
    retention: retention.region('stationary-cooker', 1024, 1024),
    onRetainedTiles: tiles => { if (item) refreshRetainedTerrain(viewer, item, tiles); },
    clip: { draw: (context, rendered) => context.drawImage(rendered, 0, 0), hasTerrain: () => true, dispose() {} },
  });
  const cooker = createInstantTerrainCooker({
    signal: lifetime.signal, priority: (_source, x, y) => x + y * 2,
    viewKey: () => 'stationary', persistent: () => retention.stats.persistent,
    flush: () => retention.flush(), onFailure: failure,
  });
  viewer.addHandler('tile-invalidated', applyRetainedTerrainEvent);
  try {
    item = await new Promise<any>((resolve, reject) => viewer.addTiledImage({
      tileSource: source, width: 1024, success: (event: any) => resolve(event.item), error: reject,
    }));
    // The native leaf level is outside OSD's eligible LODs at this zoom. Only
    // the background cooker can request the native samples in this replay.
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 2048, 2048), true);
    const camera = viewer.viewport.getBounds(true).clone();
    const overview = item._getTile(0, 0, 8, OSD.now(), source.getNumTiles(8));
    item._loadTile(overview, OSD.now());
    await vi.waitFor(() => expect(overview.loaded).toBe(true));
    viewer.forceRedraw(); runFrame();
    const pixel = (x: number, y: number) => [...viewer.drawer.context.getImageData(x, y, 1, 1).data];
    expect(pixel(40, 40)).toEqual([32, 96, 160, 255]);
    expect(render.mock.calls.filter(([view]) => view.scale === 1)).toHaveLength(0);
    const invalidated = vi.fn();
    viewer.addHandler('tile-invalidated', invalidated);
    const movement = vi.fn();
    viewer.addHandler('pan', movement); viewer.addHandler('zoom', movement);
    cooker.add(source); cooker.start();
    await vi.waitFor(() => {
      runFrame(); // Run only already-scheduled AppOSD frames; do not force redraw.
      expect(failure.mock.calls).toEqual([]);
      expect(cooker.stats.state).toBe('complete');
      expect(pixel(40, 40)).toEqual([240, 128, 32, 255]);
      expect(pixel(100, 100)).toEqual([240, 128, 32, 255]);
      expect(pixel(12, 12)).toEqual([0, 0, 0, 0]);
    }, { timeout: 3000 });
    expect(invalidated).toHaveBeenCalled();
    expect(render.mock.calls.filter(([view]) => view.scale === 1)).toHaveLength(4);
    expect(cooker.stats.completed).toBe(4);
    expect(viewer.viewport.getBounds(true)).toEqual(camera);
    expect(movement).not.toHaveBeenCalled();
    // Independently check all 16,384 visible pixels: each native eight-row
    // stripe becomes one screen row. Known empty native pixels replace blue
    // coarse pixels with alpha zero, including inside a still-loaded overview.
    const pixels = viewer.drawer.context.getImageData(0, 0, 128, 128).data;
    const expected = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      if (x >= 8 && x < 16 && y >= 8 && y < 16) continue;
      expected.set(y % 2 ? [128, 64, 32, 255] : [240, 128, 32, 255], (y * 128 + x) * 4);
    }
    expect(Array.from(pixels)).toEqual(Array.from(expected));
    expect(overview.loaded).toBe(true);
    expect(failure).not.toHaveBeenCalled();
  } finally {
    lifetime.abort(); retention.dispose();
    viewer.destroy(); mount.remove(); frames.clear();
  }
});

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

it.each([[1, '__instantTerrain'], [2, '__instantTerrain'], [1, '__biomeBg'], [2, '__biomeBg']] as const)('keeps completed adjacent tiles solid through fractional zoom-outs and pans at density %i (%s)', async (density, tag) => {
  OSD.pixelDensityRatio = density;
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const app = new AppOSD(mount, false), viewer = app.viewer;
  let hold = false;
  const source = new OSD.TileSource({ width: 4096, height: 4096, tileSize: 256,
    tileOverlap: 0, minLevel: 4, maxLevel: 12 });
  source[tag] = true;
  source.getTileUrl = (level: number, x: number, y: number) => `fractional:///${level}/${x}/${y}`;
  source.hasTransparency = () => true;
  source.downloadTileStart = (job: any) => {
    if (hold) return;
    const bounds = source.getTileBounds(job.tile.level, job.tile.x, job.tile.y, true);
    const canvas = createCanvas(bounds.width, bounds.height), context = canvas.getContext('2d');
    context.fillStyle = job.tile.level === 12 ? '#f08020' : '#2060a0';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = source.getLevelScale(job.tile.level);
    context.clearRect((64 - job.tile.x * 256 / scale) * scale,
      (64 - job.tile.y * 256 / scale) * scale, 64 * scale, 64 * scale);
    queueMicrotask(() => job.finish(context, null, 'context2d'));
  };
  source.downloadTileAbort = () => {};
  try {
    const item = await new Promise<any>((resolve, reject) => viewer.addTiledImage({
      tileSource: source, width: 4096, success: (event: any) => resolve(event.item), error: reject,
    }));
    async function load(level: number, x = 0, y = 0) {
      const tile = item._getTile(x, y, level, OSD.now(), source.getNumTiles(level));
      item._loadTile(tile, OSD.now());
      await vi.waitFor(() => expect(tile.loaded).toBe(true));
    }
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 4096, 4096), true);
    await load(8);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      viewer.viewport.fitBounds(new OSD.Rect(x * 256, y * 256, 256, 256), true);
      await load(12, x, y);
    }
    hold = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    function verifyFrame() {
      const { x, y, width } = viewer.viewport.getBounds(true);
      const size = 256 * density;
      const pixels = viewer.drawer.context.getImageData(0, 0, size, size).data;
      const wrong: string[] = [];
      for (let py = 2; py < size - 2; py++) for (let px = 2; px < size - 2; px++) {
        const wx = x + (px + .5) * width / size, wy = y + (py + .5) * width / size;
        if (wx > 60 && wx < 132 && wy > 60 && wy < 132) continue;
        const index = (py * size + px) * 4;
        if (pixels[index] !== 240 || pixels[index + 1] !== 128 || pixels[index + 2] !== 32 || pixels[index + 3] !== 255)
          if (wrong.length < 20) wrong.push(`${px},${py}: ${Array.from(pixels.slice(index, index + 4))}`);
      }
      expect(wrong, `camera ${x},${y},${width}; levels ${item._lastDrawn.map((info: any) => info.level)}`).toEqual([]);
      const holeX = Math.round((96 - x) * size / width), holeY = Math.round((96 - y) * size / width);
      expect(pixels[(holeY * size + holeX) * 4 + 3]).toBe(0);
    }
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 512, 512), true);
    viewer.forceRedraw(); runFrame(); verifyFrame();
    for (const [x, y, width] of [[0, 0, 545.2], [13.4, 25.2, 597.3], [7.1, 3.2, 551.7]]) {
      const target = new OSD.Rect(x, y, width, width);
      viewer.viewport.fitBounds(target, false);
      for (let frame = 0; frame < 5; frame++) {
        await vi.advanceTimersByTimeAsync(16);
        viewer.forceRedraw(); runFrame(); verifyFrame();
      }
      viewer.viewport.fitBounds(target, true);
      viewer.forceRedraw(); runFrame(); verifyFrame();
    }
  } finally {
    viewer.destroy(); mount.remove(); frames.clear();
    vi.useRealTimers();
    OSD.pixelDensityRatio = 1;
  }
});
