// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { scheduleDailyAssetWarmup } from '../src/telescope/daily-asset-prewarm';

vi.mock('../src/telescope/daily-asset-worker-client', () => ({ prepareDailyAssetsOffThread: vi.fn() }));
vi.mock('../src/telescope/terrain-storage-usage', () => ({ reportTerrainStorageUsage: vi.fn() }));

let OSD: any;
const native = new WeakMap<HTMLCanvasElement, Canvas>();
const frames = new Map<number, FrameRequestCallback>();
const descriptors = new Map<string, PropertyDescriptor>();
let nextFrame = 0;

beforeAll(async () => {
  // Installed OSD Viewer/World/TileSource/ImageLoader/CanvasDrawer; only DOM
  // layout and tile I/O are supplied by this nonbrowser fixture.
  for (const key of ['width', 'height'] as const) {
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
  OSD.pixelDensityRatio = 1;
  vi.spyOn(OSD, 'requestAnimationFrame').mockImplementation((callback: any) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.spyOn(OSD, 'cancelAnimationFrame').mockImplementation((id: any) => { frames.delete(id); });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) Object.defineProperty(HTMLCanvasElement.prototype, key, descriptor);
  vi.restoreAllMocks();
});

function fixture() {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const viewer = OSD({
    element: mount, drawer: 'canvas', showNavigationControl: false,
    autoResize: false, blendTime: 0, animationTime: 0,
    immediateRender: false, maxTilesPerFrame: 10,
  });
  const held = new Set<() => void>();
  function addWorld(pw: number, tagOnSuccess = false) {
    const source = new OSD.DziTileSource({ width: 1024, height: 1024,
      tileSize: 256, tileOverlap: 0, minLevel: 0, maxLevel: 10,
      tilesUrl: `daily-fixture://${pw}/`, fileFormat: 'png' });
    if (!tagOnSuccess) source.__bakedDzi = true;
    source.getTileUrl = (level: number, x: number, y: number) => `daily-fixture://${pw}/${level}/${x}/${y}`;
    source.downloadTileStart = (job: any) => {
      const finish = () => {
        held.delete(finish);
        const bounds = source.getTileBounds(job.tile.level, job.tile.x, job.tile.y, true);
        const canvas = createCanvas(bounds.width, bounds.height), context = canvas.getContext('2d');
        context.fillStyle = job.tile.level <= 8 ? '#ff8000' : '#008000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        job.finish(context, null, 'context2d');
      };
      if (job.tile.level > 8) held.add(finish);
      else queueMicrotask(finish);
    };
    return new Promise<any>((resolve, reject) => viewer.addTiledImage({
      tileSource: source, x: pw * 2048, y: 0, width: 1024,
      success: (event: any) => { source.__bakedDzi = true; resolve(event.item); }, error: reject,
    }));
  }
  async function frame(elapsed = 16) {
    viewer.forceRedraw();
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(performance.now());
    await vi.advanceTimersByTimeAsync(elapsed);
  }
  return { viewer, held, addWorld, frame, dispose() {
    viewer.destroy(); mount.remove(); frames.clear(); held.clear();
  } };
}

it('starts from metadata completion after visible detail and all expected worlds are ready, without a timer delay', async () => {
  const fixture_ = fixture(), { viewer, held, addWorld, frame } = fixture_;
  const drawn: number[] = [];
  const stage = vi.fn(), info = vi.spyOn(console, 'info').mockImplementation(() => {});
  let metadataDone!: () => void, stop: (() => void) | undefined;
  const metadataReady = new Promise<void>(resolve => { metadataDone = resolve; });
  try {
    const middle = await addWorld(0), left = await addWorld(-1);
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    viewer.addHandler('tile-drawn', (event: any) => {
      if (event.tiledImage === middle) drawn.push(event.tile.level);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    stop = scheduleDailyAssetWarmup({ viewer, isCurrent: () => true,
      expectedBakedImages: 3, metadataReady,
      stages: [stage], yieldTask: async () => {} });

    for (let i = 0; i < 20 && !drawn.length; i++) await frame();
    expect(drawn.some(level => level <= 8)).toBe(true);
    expect(held.size).toBeGreaterThan(0);
    expect(middle.getFullyLoaded()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stage).not.toHaveBeenCalled();

    for (let i = 0; i < 40 && !middle.getFullyLoaded(); i++) {
      for (const finish of [...held]) finish();
      await frame();
    }
    expect(middle.getFullyLoaded()).toBe(true);
    expect(left.getDrawArea()).toBeFalsy();
    expect(left.getFullyLoaded()).toBe(false);
    expect(viewer.getFullyLoaded()).toBe(false); // Offscreen worlds never load.

    await vi.advanceTimersByTimeAsync(1000);
    expect(stage).not.toHaveBeenCalled(); // Third expected DZI is still absent.
    const pendingRight = addWorld(1);
    await vi.advanceTimersByTimeAsync(0);
    const right = await pendingRight;
    for (let i = 0; i < 3; i++) await frame();
    expect(right.getDrawArea()).toBeFalsy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stage).not.toHaveBeenCalled(); // Seed metadata/POI setup is pending.

    expect(document.hidden).toBe(false);
    expect(viewer.isAnimating()).toBe(false);
    const beforeCompletion = performance.now();
    metadataDone();
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledOnce();
    expect(performance.now()).toBe(beforeCompletion);
    expect(viewer.getFullyLoaded()).toBe(false); // Aggregate must not block it.
    await frame();
    await vi.advanceTimersByTimeAsync(500);
    expect(stage).toHaveBeenCalledOnce();
  } finally {
    stop?.();
    fixture_.dispose();
    vi.useRealTimers(); info.mockRestore();
  }
});

it('does not start asset work after coarse paint when metadata and all worlds are already ready', async () => {
  const fixture_ = fixture(), { viewer, held, addWorld, frame } = fixture_;
  const stage = vi.fn(), info = vi.spyOn(console, 'info').mockImplementation(() => {});
  let stop: (() => void) | undefined;
  try {
    const middle = await addWorld(0);
    await addWorld(-1); await addWorld(1);
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    const drawn: number[] = [];
    viewer.addHandler('tile-drawn', (event: any) => drawn.push(event.tile.level));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    stop = scheduleDailyAssetWarmup({ viewer, isCurrent: () => true,
      expectedBakedImages: 3, metadataReady: Promise.resolve(),
      stages: [stage], yieldTask: async () => {} });
    for (let i = 0; i < 20 && !drawn.length; i++) await frame();
    for (let i = 0; i < 3; i++) await frame();
    expect(viewer.isAnimating()).toBe(false);
    expect(drawn.some(level => level <= 8)).toBe(true);
    expect(held.size).toBeGreaterThan(0);
    expect(middle.getFullyLoaded()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stage).not.toHaveBeenCalled();

    let finalPaint = false;
    const startedBeforePaint: boolean[] = [];
    viewer.addHandler('update-viewport', () => {
      if (middle.getFullyLoaded() && !middle.needsDraw()) finalPaint = true;
    });
    stage.mockImplementation(() => { startedBeforePaint.push(!finalPaint); });
    const beforeDetail = performance.now();
    for (let i = 0; i < 40 && !middle.getFullyLoaded(); i++) {
      for (const finish of [...held]) finish();
      await frame(0);
    }
    expect(middle.getFullyLoaded()).toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    expect(startedBeforePaint).toEqual([false]);
    expect(performance.now()).toBe(beforeDetail);
  } finally {
    stop?.(); fixture_.dispose(); vi.useRealTimers(); info.mockRestore();
  }
});

it('notices a late offscreen world tagged in addTiledImage success, with no readiness polling', async () => {
  const fixture_ = fixture(), { viewer, held, addWorld, frame } = fixture_;
  const stage = vi.fn(), info = vi.spyOn(console, 'info').mockImplementation(() => {});
  let stop: (() => void) | undefined;
  try {
    const middle = await addWorld(0); await addWorld(-1);
    viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    stop = scheduleDailyAssetWarmup({ viewer, isCurrent: () => true,
      expectedBakedImages: 3, metadataReady: Promise.resolve(),
      stages: [stage], yieldTask: async () => {} });
    for (let i = 0; i < 40 && !middle.getFullyLoaded(); i++) {
      for (const finish of [...held]) finish();
      await frame();
    }
    for (let i = 0; i < 3; i++) await frame();
    expect(middle.getFullyLoaded()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stage).not.toHaveBeenCalled();
    const taggedAtWorldAdd: unknown[] = [];
    viewer.world.addHandler('add-item', (event: any) => taggedAtWorldAdd.push(event.item.source.__bakedDzi));
    const beforeAttachment = performance.now();
    const adding = addWorld(1, true);
    await vi.advanceTimersByTimeAsync(0);
    const right = await adding;
    expect(taggedAtWorldAdd).toEqual([undefined]);
    expect(right.source.__bakedDzi).toBe(true);
    expect(right.getDrawArea()).toBeFalsy();
    for (let i = 0; i < 3; i++) await frame(0);
    expect(stage).toHaveBeenCalledOnce();
    expect(performance.now()).toBe(beforeAttachment);
  } finally {
    stop?.(); fixture_.dispose(); vi.useRealTimers(); info.mockRestore();
  }
});
