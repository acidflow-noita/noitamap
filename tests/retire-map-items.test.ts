// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { installMapItemRetirement, retireMapItems } from '../src/telescope/retire-map-items';

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  OSD = (await import('openseadragon')).default;
  vi.spyOn(OSD, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(OSD, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());
afterAll(() => vi.restoreAllMocks());

function source(seed: string, ready = true) {
  const source = new OSD.TileSource({ width: 256, height: 256, tileSize: 256 });
  source.seed = seed;
  source.ready = ready;
  source.getTileUrl = () => `seed://${seed}`;
  source.getTileWidth = source.getTileHeight = () => 256;
  source.destroy = vi.fn();
  return source;
}

it('unblocks ready backgrounds/incoming images behind an obsolete manifest and destroys its late result', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const viewer = OSD({ element: mount, drawer: 'canvas', showNavigationControl: false, autoResize: false });
  installMapItemRetirement(viewer);
  const old = source('old', false), detached = source('old'), background = source('old'), next = source('next');
  background.__biomeBg = true;
  const oldSuccess = vi.fn(), oldError = vi.fn(), backgroundSuccess = vi.fn(), nextSuccess = vi.fn();
  try {
    viewer.addTiledImage({ tileSource: old, success: oldSuccess, error: oldError });
    viewer.addTiledImage({ tileSource: detached, success: oldSuccess, error: oldError });
    viewer.addTiledImage({ tileSource: background, success: backgroundSuccess });
    viewer.addTiledImage({ tileSource: next, success: nextSuccess });
    await vi.advanceTimersByTimeAsync(0);
    expect(viewer.world.getItemCount()).toBe(0);
    expect(viewer._loadQueue).toHaveLength(4);
    retireMapItems(viewer, (source: any) => source.seed === 'old');
    expect(viewer._loadQueue).toHaveLength(0);
    expect(viewer.world.getItemCount()).toBe(2);
    expect(backgroundSuccess).toHaveBeenCalledOnce();
    expect(nextSuccess).toHaveBeenCalledOnce();
    expect(detached.destroy).toHaveBeenCalledOnce();
    old.ready = true;
    old.raiseEvent('ready', { tileSource: old });
    await vi.advanceTimersByTimeAsync(0);
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(oldSuccess).not.toHaveBeenCalled();
    expect(oldError).not.toHaveBeenCalled();
    expect(viewer.world.getItemCount()).toBe(2);
    expect(background.destroy).not.toHaveBeenCalled();
    expect(next.destroy).not.toHaveBeenCalled();
  } finally { viewer.destroy(); mount.remove(); }
});

it('retires pending URL discovery before OSD has instantiated the source', async () => {
  const destroy = vi.fn(), staleSuccess = vi.fn();
  const old = { options: { tileSource: 'https://daily-middle.acidflow.stream/old.dzi', success: staleSuccess, error: vi.fn() } };
  const next = { options: { tileSource: 'https://daily-middle.acidflow.stream/next.dzi' } };
  const base = { options: { tileSource: 'https://noitamap.com/base.dzi' } };
  const viewer = { _loadQueue: [old, next, base] };
  retireMapItems(viewer, value => value === old.options.tileSource);
  expect(viewer._loadQueue).toEqual([next, base]);
  old.options.success({ item: { destroy } });
  expect(destroy).toHaveBeenCalledOnce();
  expect(staleSuccess).not.toHaveBeenCalled();
});

it('cancels only outgoing queued/running ImageJobs and immediately frees their slot without retries or failure reports', () => {
  const loader = new OSD.ImageLoader({ jobLimit: 1, timeout: 3000, tileRetryMax: 3 });
  const viewer = { imageLoader: loader, _loadQueue: [] };
  installMapItemRetirement(viewer);
  installMapItemRetirement(viewer);
  const old = source('old'), background = source('old'), next = source('next');
  background.__biomeBg = true;
  const started: any[] = [];
  for (const s of [old, background, next]) {
    s.downloadTileStart = vi.fn((job: any) => started.push(job));
    s.downloadTileAbort = vi.fn();
  }
  const request = (source: any) => {
    const tile = new OSD.Tile(0, 0, 0, new OSD.Rect(0, 0, 1, 1), true, source.getTileUrl(),
      undefined, false, {}, undefined, null, source.getTileUrl());
    tile.tiledImage = { _imageLoader: loader };
    const callback = vi.fn(), abort = vi.fn();
    loader.addJob({ source, tile, src: source.getTileUrl(), callback, abort });
    return { callback, abort };
  };
  const running = request(old), queued = request(old), kept = request(background), incoming = request(next);
  expect(started).toHaveLength(1);
  const oldJob = started[0];
  retireMapItems(viewer, (source: any) => source.seed === 'old');
  expect(running.abort).toHaveBeenCalledOnce();
  expect(queued.abort).toHaveBeenCalledOnce();
  expect(running.callback).not.toHaveBeenCalled();
  expect(queued.callback).not.toHaveBeenCalled();
  expect(old.downloadTileAbort).toHaveBeenCalledOnce();
  expect(started.map(job => job.source)).toEqual([old, background]);
  expect(loader.jobsInProgress).toBe(1);
  expect(loader.jobQueue).toHaveLength(1);
  expect(loader.failedTiles).toHaveLength(0);
  oldJob.finish(createCanvas(1, 1), null, 'image');
  expect(loader.jobsInProgress).toBe(1);
  started[1].finish(createCanvas(1, 1), null, 'image');
  expect(kept.callback).toHaveBeenCalledOnce();
  expect(started[2].source).toBe(next);
  started[2].finish(createCanvas(1, 1), null, 'image');
  expect(incoming.callback).toHaveBeenCalledOnce();
  expect(kept.abort).not.toHaveBeenCalled();
  expect(incoming.abort).not.toHaveBeenCalled();
  expect(loader.jobsInProgress).toBe(0);
  expect(loader.failedTiles).toHaveLength(0);
});

it('does not abort another viewer sharing the same source, including synchronous source cancellation', () => {
  const sourceA = source('old'), held: any[] = [];
  sourceA.downloadTileStart = (job: any) => held.push(job);
  sourceA.downloadTileAbort = (job: any) => job.fail('Source cancelled', null);
  const viewers = [0, 1].map(() => ({ imageLoader: new OSD.ImageLoader({ jobLimit: 1 }), _loadQueue: [] }));
  const callbacks = viewers.map(viewer => {
    installMapItemRetirement(viewer);
    const tile = new OSD.Tile(0, 0, 0, new OSD.Rect(0, 0, 1, 1), true, 'test',
      undefined, false, {}, undefined, null, 'test');
    tile.tiledImage = { _imageLoader: viewer.imageLoader };
    const callback = vi.fn();
    viewer.imageLoader.addJob({ source: sourceA, tile, callback });
    return callback;
  });
  retireMapItems(viewers[0], () => true);
  expect(viewers[0].imageLoader.jobsInProgress).toBe(0);
  expect(viewers[1].imageLoader.jobsInProgress).toBe(1);
  expect(callbacks[0]).not.toHaveBeenCalled();
  held[1].finish(createCanvas(1, 1), null, 'image');
  expect(callbacks[1]).toHaveBeenCalledOnce();
  expect(viewers[1].imageLoader.jobsInProgress).toBe(0);
});
