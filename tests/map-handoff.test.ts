// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { afterMapHandoff, beginMapHandoff, clearMapHandoff, holdMapHandoff, isMapHandoffPending } from '../src/telescope/map-handoff';
import { createInstantTerrainViewport } from '../src/telescope/instant-terrain-viewport';


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
  vi.stubGlobal('OpenSeadragon', OSD);
  vi.spyOn(OSD, 'requestAnimationFrame').mockImplementation((callback: any) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.spyOn(OSD, 'cancelAnimationFrame').mockImplementation((id: any) => { frames.delete(id); });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) Object.defineProperty(HTMLCanvasElement.prototype, key, descriptor);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture() {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const viewer = OSD({
    element: mount, drawer: 'canvas', showNavigationControl: false,
    autoResize: false, blendTime: 0, animationTime: 0,
    preserveViewport: true,
    immediateRender: false, maxTilesPerFrame: 10,
  });
  const held = new Set<() => void>();
  function addWorld(pw: number, tagOnSuccess = false, color = '#008000') {
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
        context.fillStyle = job.tile.level <= 8 ? '#ff8000' : color;
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
    clearMapHandoff(viewer); viewer.destroy(); mount.remove(); frames.clear(); held.clear();
  } };
}

async function settle(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 40; i++) {
    for (const finish of [...f.held]) finish();
    await f.frame();
    const world = f.viewer.world;
    if (Array.from({ length: world.getItemCount() }, (_, i) => world.getItemAt(i))
      .every((item: any) => !item.getDrawArea() || (item.getFullyLoaded() && !item.needsDraw()))) return;
  }
  throw new Error('Fixture viewport did not finish');
}

it('holds a composed outgoing daily until incoming daily detail and POIs have painted, without a timer', async () => {
  const f = fixture(), commit = vi.fn();
  try {
    const old = await f.addWorld(0, false, '#ff0000');
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true);
    const cover = document.querySelector('.map-handoff canvas') as HTMLCanvasElement;
    expect(cover).toBeTruthy();
    expect([...native.get(cover)!.getContext('2d').getImageData(128, 128, 1, 1).data]).toEqual([255, 0, 0, 255]);
    f.viewer.world.removeItem(old);
    const pending = f.addWorld(0, false, '#0000ff');
    await vi.advanceTimersByTimeAsync(0);
    const next = await pending;
    const offscreen = f.addWorld(2);
    await vi.advanceTimersByTimeAsync(0);
    await offscreen;
    handoff.finish(commit);
    await f.frame();
    await vi.advanceTimersByTimeAsync(5000);
    expect(next.getFullyLoaded()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.map-handoff canvas')).toBe(cover);
    await settle(f);
    expect(commit).toHaveBeenCalledOnce();
    expect(document.querySelector('.map-handoff')).toBeNull();
    expect(isMapHandoffPending(f.viewer)).toBe(false);
    expect(f.viewer.getFullyLoaded()).toBe(false); // offscreen world never loads
    expect([...f.viewer.drawer.context.getImageData(128, 128, 1, 1).data]).toEqual([0, 0, 255, 255]);
  } finally { f.dispose(); vi.useRealTimers(); }
});

it('requires a current-camera direct GPU frame and finished scene tiles for a live destination', async () => {
  const f = fixture(), commit = vi.fn(), lifetime = new AbortController();
  const renders: Array<{ plan: any; resolve: (value: any) => void }> = [];
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true);
    f.viewer.world.removeItem(old);
    const layer = createInstantTerrainViewport({ viewer: f.viewer,
      bounds: { x: 0, y: 0, width: 1024, height: 1024 }, signal: lifetime.signal,
      renderFrame: plan => new Promise(resolve => renders.push({ plan, resolve })),
      firstPaint: handoff.check, onFailure: error => { throw error; },
    });
    f.viewer.addTiledImage({ tileSource: layer.source, x: 0, y: 0, width: 1024 });
    const scenes = f.addWorld(0);
    await vi.advanceTimersByTimeAsync(0); await scenes;
    handoff.finish(commit);
    await f.frame();
    expect(commit).not.toHaveBeenCalled();
    expect(renders.length).toBeGreaterThan(0);
    const completeFrame = () => {
      const request = renders.at(-1)!;
      request.resolve(createCanvas(request.plan.pixelWidth, request.plan.pixelHeight));
    };
    completeFrame(); await f.frame();
    expect(commit).not.toHaveBeenCalled(); // scenes still waiting on their detailed tiles
    f.viewer.viewport.panTo(new OSD.Point(384, 128), true);
    await f.frame();
    for (const finish of [...f.held]) finish();
    await f.frame();
    expect(commit).not.toHaveBeenCalled(); // old camera frame cannot qualify
    completeFrame();
    for (let i = 0; i < 30 && !commit.mock.calls.length; i++) {
      for (const finish of [...f.held]) finish();
      await f.frame();
    }
    expect(commit).toHaveBeenCalledOnce();
  } finally { lifetime.abort(); f.dispose(); vi.useRealTimers(); }
});

it('reuses one original cover during rapid reseeding and ignores superseded completion', async () => {
  const f = fixture(), firstCommit = vi.fn(), secondCommit = vi.fn();
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const first = beginMapHandoff(f.viewer, true);
    const cover = document.querySelector('.map-handoff canvas');
    f.viewer.world.removeItem(old);
    first.finish(firstCommit);
    const second = beginMapHandoff(f.viewer, true);
    expect(document.querySelectorAll('.map-handoff')).toHaveLength(1);
    expect(document.querySelector('.map-handoff canvas')).toBe(cover);
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).not.toHaveBeenCalled();
    const pending = f.addWorld(0);
    await vi.advanceTimersByTimeAsync(0); await pending;
    second.finish(secondCommit);
    await settle(f);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledOnce();
    expect(f.viewer.overlaysContainer.style.visibility).toBe('');
  } finally { f.dispose(); vi.useRealTimers(); }
});

it('finishes over empty sparse scene coverage and starts cooking only after the composition handoff', async () => {
  const f = fixture(), commit = vi.fn(), cook = vi.fn(), lifetime = new AbortController();
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true);
    f.viewer.world.removeItem(old);
    const sparse = new OSD.TileSource({ width: 1024, height: 1024, tileSize: 256, maxLevel: 10 });
    sparse.tileExists = () => false;
    sparse.getTileUrl = () => 'empty-scene://tile';
    f.viewer.addTiledImage({ tileSource: sparse, width: 1024, x: 0, y: 0 });
    afterMapHandoff(f.viewer, lifetime.signal, cook);
    await f.frame();
    const item = f.viewer.world.getItemAt(0);
    for (let i = 0; i < 8 && !item.getFullyLoaded(); i++) await f.frame();
    expect(item.getDrawArea()).toBeTruthy();
    expect(item.getFullyLoaded()).toBe(true);
    expect(item.needsDraw()).toBe(true);
    expect(cook).not.toHaveBeenCalled();
    handoff.finish(commit);
    await f.frame();
    expect(commit).toHaveBeenCalledOnce();
    expect(cook).toHaveBeenCalledOnce();
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(cook.mock.invocationCallOrder[0]);
  } finally { lifetime.abort(); f.dispose(); vi.useRealTimers(); }
});

it('keeps the outgoing picture when an incoming DZI fails instead of revealing a missing region', async () => {
  const f = fixture(), commit = vi.fn(), failed = vi.fn();
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true, failed);
    f.viewer.world.removeItem(old);
    handoff.finish(commit);
    f.viewer.raiseEvent('add-item-failed', { options: {}, message: 'Missing manifest' });
    await f.frame();
    expect(failed).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.map-handoff')).toBeTruthy();
  } finally { f.dispose(); vi.useRealTimers(); }
});

it('does not reveal a fallback renderer while its replacement layers are still being prepared', async () => {
  const f = fixture(), commit = vi.fn();
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true);
    handoff.finish(commit);
    f.viewer.world.removeItem(old); // failed GPU layer disappears
    const prepared = holdMapHandoff(f.viewer); // async renderer rebuild
    await f.frame();
    expect(commit).not.toHaveBeenCalled();
    const incoming = f.addWorld(0);
    await vi.advanceTimersByTimeAsync(0); await incoming;
    prepared();
    await f.frame();
    expect(commit).not.toHaveBeenCalled();
    await settle(f);
    expect(commit).toHaveBeenCalledOnce();
  } finally { f.dispose(); vi.useRealTimers(); }
});

it('rejects a terminal incoming tile failure but ignores failures belonging to a retired image', async () => {
  const f = fixture(), commit = vi.fn(), failed = vi.fn();
  try {
    const old = await f.addWorld(0);
    f.viewer.viewport.fitBounds(new OSD.Rect(0, 0, 256, 256), true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    await settle(f);
    const handoff = beginMapHandoff(f.viewer, true, failed);
    f.viewer.world.removeItem(old);
    f.viewer.raiseEvent('tile-load-failed', { tiledImage: old, maxReached: true });
    expect(failed).not.toHaveBeenCalled();
    const pending = f.addWorld(0);
    await vi.advanceTimersByTimeAsync(0);
    const incoming = await pending;
    handoff.finish(commit);
    f.viewer.raiseEvent('tile-load-failed', { tiledImage: incoming, maxReached: false });
    expect(failed).not.toHaveBeenCalled();
    f.viewer.raiseEvent('tile-load-failed', { tiledImage: incoming, maxReached: true });
    await settle(f);
    expect(failed).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.map-handoff')).toBeTruthy();
  } finally { f.dispose(); vi.useRealTimers(); }
});
