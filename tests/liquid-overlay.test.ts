// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiquidOverlay, type LiquidOverlayDeps } from '../src/liquids/overlay';
import { LiquidMaskWorkerClient, type ViewLiquidMask } from '../src/liquids/mask-worker-client';
import type { MaskBounds } from '../src/liquids/mask-index';
import type { CameraMatrix } from '../src/portals/geometry';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function events() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    addHandler(name: string, callback: () => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(callback); },
    removeHandler(name: string, callback: () => void) { handlers.get(name)?.delete(callback); if (!handlers.get(name)?.size) handlers.delete(name); },
    emit(name: string) { for (const callback of [...handlers.get(name) ?? []]) callback(); },
  };
}
const sampleMask = (): ViewLiquidMask => ({ x: 100, y: 100, width: 40, height: 30, pixels: new Uint8Array(1200).fill(255) });
const image = (width = 46, height = 36, scene = 0) => ({ width, height, scene, close: vi.fn() }) as unknown as ImageBitmap & { scene: number; close: ReturnType<typeof vi.fn> };
let layers: LiquidOverlay[] = [], queue = new Map<number, FrameRequestCallback>(), nextFrame = 0;
let hidden = false;
let media: EventTarget & { matches: boolean };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  hidden = false; media = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queue.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
});
afterEach(() => {
  for (const layer of layers) layer.destroy();
  layers = []; queue.clear(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function tick(now = performance.now() + 1000 / 60) {
  vi.advanceTimersByTime(Math.max(0, now - performance.now()));
  const callbacks = [...queue.values()]; queue.clear(); for (const callback of callbacks) callback(now);
}

function setup(options: { scale?: number; ratio?: number; ratioY?: number; mask?: ViewLiquidMask | null } = {}) {
  const canvas = document.createElement('div'), terrain = document.createElement('canvas'), particles = document.createElement('canvas');
  document.body.append(canvas); canvas.append(terrain, particles);
  let width = 800, height = 600, scene = 0, flipped = false, animating = false;
  const scale = options.scale ?? 1;
  let matrix: CameraMatrix = { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
  Object.defineProperties(canvas, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
  terrain.width = Math.round(width * (options.ratio ?? 1)); terrain.height = Math.round(height * (options.ratioY ?? options.ratio ?? 1));
  const bus = events(), world = events(), item = events();
  const viewer = { canvas, ...bus, world: { ...world, getItemCount: () => 1, getItemAt: () => item },
    viewport: {
      pixelFromPoint: vi.fn((point: { x: number; y: number }, _current: boolean) => ({ x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f })),
      getFlip: () => flipped,
    },
    drawer: { canvas: terrain }, forceRedraw: vi.fn(), isAnimating: () => animating,
  };
  const provider = { prepare: vi.fn(async (_bounds: MaskBounds, _signal: AbortSignal): Promise<ViewLiquidMask | null> => options.mask === undefined ? sampleMask() : options.mask),
    stats: vi.fn(() => ({ preparations: provider.prepare.mock.calls.length, cachedBlocks: 0, cachedBytes: 0 })), destroy: vi.fn() };
  const renderer = { setSource: vi.fn((_source: any): boolean | null => true), render: vi.fn((_time: number, _strength: number): boolean | null => true),
    stats: vi.fn(() => ({ uploads: renderer.setSource.mock.calls.length * 2 })), dispose: vi.fn() };
  const factory = vi.fn((_canvas: HTMLCanvasElement) => renderer);
  const bitmap = vi.fn(async (_source: ImageBitmapSource, _x: number, _y: number, w: number, h: number): Promise<ImageBitmap> => image(w, h, scene));
  const overlay = new LiquidOverlay(viewer, { staticBackground: false, exclusions: () => [] }, {
    provider, renderer: factory as unknown as LiquidOverlayDeps['renderer'], bitmap: bitmap as unknown as typeof createImageBitmap,
  });
  layers.push(overlay);
  const layer = canvas.querySelector('.noitamap-liquid-wobble') as HTMLCanvasElement;
  return { overlay, layer, viewer, provider, renderer, factory, bitmap, terrain, particles, canvas, item,
    emit: bus.emit, setCamera(next: CameraMatrix) { matrix = next; }, setFlip(value: boolean) { flipped = value; },
    setAnimating(value: boolean) { animating = value; },
    resize(w: number, h: number, physicalWidth = w, physicalHeight = h) { width = w; height = h; terrain.width = physicalWidth; terrain.height = physicalHeight; },
    drawScene(version = 1) { scene = version; bus.emit('update-viewport'); },
  };
}
async function start(test: ReturnType<typeof setup>) {
  await vi.advanceTimersByTimeAsync(160); test.drawScene(); await flush();
}
function stop(test: ReturnType<typeof setup>, reason: string) {
  if (reason === 'disable') test.overlay.setEnabled(false);
  else if (reason === 'hidden') { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }
  else if (reason === 'reduced-motion') { media.matches = true; media.dispatchEvent(new Event('change')); }
  else if (reason === 'reseed') { test.viewer.world.emit('remove-item'); test.viewer.world.emit('add-item'); }
  else if (reason === 'destroy') test.overlay.destroy();
  else { test.setCamera({ a: 2, b: 0, c: 0, d: 2, e: -10, f: 20 }); test.emit('zoom'); }
}

describe('liquid overlay scheduling and lifecycle', () => {
  it('retains one snapshot while the GPU is busy without repeated map draws or captures', async () => {
    const test = setup(); test.renderer.setSource.mockReturnValueOnce(null);
    await start(test);
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    expect(test.bitmap).toHaveBeenCalledOnce(); expect(test.viewer.forceRedraw).toHaveBeenCalledOnce();
    const bitmap = await test.bitmap.mock.results[0].value;
    expect(bitmap.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(34); await flush();
    expect(test.renderer.setSource).toHaveBeenCalledTimes(2); expect(bitmap.close).toHaveBeenCalledOnce();
    test.renderer.render.mockReturnValueOnce(null);
    tick(); expect(test.layer.hidden).toBe(true); expect(test.overlay.stats().frames).toBe(0);
    tick(performance.now() + 34); expect(test.layer.hidden).toBe(false); expect(test.overlay.stats().frames).toBe(1);
    expect(test.bitmap).toHaveBeenCalledOnce(); expect(test.viewer.forceRedraw).toHaveBeenCalledOnce();
  });
  it('refreshes opacity/background changes that redraw OSD without loading a tile', async () => {
    const test = setup(); await start(test); tick();
    test.item.emit('opacity-change');
    test.drawScene(9);
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    await vi.advanceTimersByTimeAsync(80); test.drawScene(10); await flush();
    expect(test.provider.prepare).toHaveBeenCalledOnce();
    expect(test.renderer.setSource).toHaveBeenCalledTimes(2);
    expect(test.renderer.setSource.mock.calls[1][0].color.scene).toBe(10);
    await vi.advanceTimersByTimeAsync(500);
    expect(test.viewer.forceRedraw).toHaveBeenCalledTimes(2); // no self-triggered redraw loop
  });
  it('does not hide or recapture for repeated OSD redraws with unchanged pixels', async () => {
    const test = setup(); await start(test); tick();
    for (let i = 0; i < 60; i++) { test.drawScene(); tick(performance.now() + 34); }
    expect(test.layer.hidden).toBe(false); expect(test.bitmap).toHaveBeenCalledOnce();
    expect(test.viewer.forceRedraw).toHaveBeenCalledOnce(); expect(test.provider.prepare).toHaveBeenCalledOnce();
    test.overlay.destroy(); expect(test.item.handlers.size).toBe(0);
  });
  it('releases the retained snapshot immediately when navigation cancels a busy-GPU wait', async () => {
    const test = setup(); test.renderer.setSource.mockReturnValue(null);
    await start(test);
    const bitmap = await test.bitmap.mock.results[0].value;
    test.overlay.destroy(); await flush();
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(queue.size).toBe(0);
    expect(test.renderer.setSource).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['overview', 'hidden', 'reduced-motion', 'off'])('does no preparation, capture, or GPU work while %s', async reason => {
    if (reason === 'hidden') hidden = true;
    if (reason === 'reduced-motion') media.matches = true;
    const test = setup({ scale: reason === 'overview' ? 0.1 : 1 });
    if (reason === 'off') test.overlay.setEnabled(false);
    await vi.advanceTimersByTimeAsync(5000); test.drawScene(); tick();
    expect(test.provider.prepare).not.toHaveBeenCalled(); expect(test.bitmap).not.toHaveBeenCalled();
    expect(test.factory).not.toHaveBeenCalled(); expect(test.viewer.forceRedraw).not.toHaveBeenCalled();
    expect(queue.size).toBe(0); expect(test.layer.hidden).toBe(true);
  });

  it('captures a finished cold terrain frame before creating or animating the GPU layer', async () => {
    const test = setup(), pending = deferred<ImageBitmap>(); test.bitmap.mockReturnValueOnce(pending.promise);
    expect(test.canvas.children[0]).toBe(test.terrain); expect(test.canvas.children[1]).toBe(test.layer); expect(test.canvas.children[2]).toBe(test.particles);
    await vi.advanceTimersByTimeAsync(159); expect(test.provider.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.provider.prepare).toHaveBeenCalledOnce(); expect(test.viewer.forceRedraw).toHaveBeenCalledOnce();
    expect(test.bitmap).not.toHaveBeenCalled(); expect(test.factory).not.toHaveBeenCalled();
    test.drawScene(7);
    expect(test.bitmap).toHaveBeenCalledWith(test.terrain, 97, 97, 46, 36);
    expect(test.factory).not.toHaveBeenCalled(); expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    const captured = image(46, 36, 7); pending.resolve(captured); await flush();
    expect(test.renderer.setSource).toHaveBeenCalledOnce(); expect(test.renderer.setSource.mock.calls[0][0].color).toBe(captured);
    expect(captured.close).toHaveBeenCalledOnce(); expect(test.renderer.render).not.toHaveBeenCalled();
    tick(); expect(test.renderer.render).toHaveBeenCalledOnce();
    expect(test.renderer.setSource.mock.invocationCallOrder[0]).toBeLessThan(test.renderer.render.mock.invocationCallOrder[0]);
    expect(test.viewer.viewport.pixelFromPoint.mock.calls.every(([, current]) => current === true)).toBe(true);
  });

  it('debounces navigation, aborts superseded masks, and waits for animation to finish', async () => {
    const test = setup(), pending = deferred<ViewLiquidMask | null>(); test.provider.prepare.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(100); test.emit('pan');
    await vi.advanceTimersByTimeAsync(100); test.emit('zoom');
    await vi.advanceTimersByTimeAsync(159); expect(test.provider.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(test.provider.prepare).toHaveBeenCalledOnce();
    const signal = test.provider.prepare.mock.calls[0][1];
    test.setAnimating(true); test.emit('pan'); expect(signal.aborted).toBe(true);
    pending.resolve(sampleMask()); await flush(); expect(test.viewer.forceRedraw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(160); expect(test.provider.prepare).toHaveBeenCalledOnce();
    test.setAnimating(false); test.emit('animation-finish');
    await vi.advanceTimersByTimeAsync(160); expect(test.provider.prepare).toHaveBeenCalledTimes(2);
    test.drawScene(2); await flush(); expect(test.factory).toHaveBeenCalledOnce();
  });

  it('caps animation at thirty frames per second without recapturing, preparing, or redrawing terrain', async () => {
    const test = setup(); await start(test);
    const began = performance.now();
    for (let i = 1; i <= 120; i++) tick(began + i * 1000 / 120);
    expect(test.renderer.render.mock.calls.length).toBeGreaterThanOrEqual(29);
    expect(test.renderer.render.mock.calls.length).toBeLessThanOrEqual(31);
    expect(test.provider.prepare).toHaveBeenCalledOnce(); expect(test.bitmap).toHaveBeenCalledOnce();
    expect(test.renderer.setSource).toHaveBeenCalledOnce(); expect(test.viewer.forceRedraw).toHaveBeenCalledOnce();
    expect(test.overlay.stats()).toMatchObject({ targetFPS: 30, captures: 1, status: 'running' });
    expect(queue.size).toBe(1);
  });

  it('hides stale frames at camera changes and uploads only a crop captured for the new camera', async () => {
    const test = setup(); await start(test); tick();
    const previousFrames = test.renderer.render.mock.calls.length;
    test.setCamera({ a: 2, b: 0, c: 0, d: 2, e: -30, f: 10 }); test.drawScene(2);
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    tick(); expect(test.renderer.render).toHaveBeenCalledTimes(previousFrames);
    await vi.advanceTimersByTimeAsync(160); test.drawScene(3); await flush();
    expect(test.renderer.setSource).toHaveBeenCalledTimes(2);
    const second = test.renderer.setSource.mock.calls[1][0];
    expect(second.color.scene).toBe(3);
    expect(second.screenToWorld[0]).toBe(0.5); expect(second.screenToWorld[3]).toBe(0.5);
    expect(test.factory).toHaveBeenCalledOnce();
  });

  it('refreshes changed map content once after a quiet interval without regenerating masks', async () => {
    const test = setup(); await start(test); tick();
    test.emit('tile-loaded');
    await vi.advanceTimersByTimeAsync(50); test.emit('terrain-cache-ready');
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    await vi.advanceTimersByTimeAsync(79); expect(test.viewer.forceRedraw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(test.viewer.forceRedraw).toHaveBeenCalledTimes(2);
    test.drawScene(9); await flush();
    expect(test.provider.prepare).toHaveBeenCalledOnce(); expect(test.renderer.setSource).toHaveBeenCalledTimes(2);
    expect(test.renderer.setSource.mock.calls[1][0].color.scene).toBe(9);
    expect(test.factory).toHaveBeenCalledOnce();
  });

  it('discards a pending snapshot when new terrain invalidates its captured content', async () => {
    const test = setup(), pending = deferred<ImageBitmap>(); test.bitmap.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(160); test.drawScene(1);
    test.emit('terrain-cache-ready');
    const stale = image(46, 36, 1); pending.resolve(stale); await flush();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(test.renderer.setSource).not.toHaveBeenCalled(); expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    await vi.advanceTimersByTimeAsync(80); test.drawScene(2); await flush();
    expect(test.renderer.setSource).toHaveBeenCalledOnce(); expect(test.renderer.setSource.mock.calls[0][0].color.scene).toBe(2);
    expect(test.provider.prepare).toHaveBeenCalledOnce();
  });

  it.each(['disable', 'hidden', 'reduced-motion', 'zoom', 'reseed', 'destroy'])('ignores mask completion after %s', async reason => {
    const test = setup(), pending = deferred<ViewLiquidMask | null>(); test.provider.prepare.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(160); const signal = test.provider.prepare.mock.calls[0][1];
    stop(test, reason); expect(signal.aborted).toBe(true);
    pending.resolve(sampleMask()); await flush(); test.drawScene();
    expect(test.bitmap).not.toHaveBeenCalled(); expect(test.factory).not.toHaveBeenCalled();
    expect(test.viewer.forceRedraw).not.toHaveBeenCalled(); expect(queue.size).toBe(0); expect(test.layer.hidden).toBe(true);
  });

  it.each(['disable', 'hidden', 'reduced-motion', 'zoom', 'reseed', 'destroy'])('closes and discards bitmap completion after %s', async reason => {
    const test = setup(), pending = deferred<ImageBitmap>(); test.bitmap.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(160); test.drawScene(); expect(test.bitmap).toHaveBeenCalledOnce();
    stop(test, reason);
    const late = image(); pending.resolve(late); await flush();
    expect(late.close).toHaveBeenCalledOnce(); expect(test.factory).not.toHaveBeenCalled();
    expect(test.renderer.setSource).not.toHaveBeenCalled(); expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
  });

  it('does not display or schedule a frame if the GPU refuses its source', async () => {
    const test = setup(); test.renderer.setSource.mockReturnValue(false);
    await start(test);
    expect(test.renderer.setSource).toHaveBeenCalledOnce(); expect(test.layer.hidden).toBe(true);
    expect(queue.size).toBe(0); expect(test.overlay.stats().captures).toBe(0);
  });

  it('drains an old capture before capturing a newer camera without reviving the old layer', async () => {
    const test = setup(), pending = deferred<ImageBitmap>(); test.bitmap.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(160); test.drawScene(1);
    test.setCamera({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }); test.emit('zoom');
    await vi.advanceTimersByTimeAsync(160); test.drawScene(2);
    expect(test.bitmap).toHaveBeenCalledOnce();
    const stale = image(46, 36, 1); pending.resolve(stale); await flush();
    expect(stale.close).toHaveBeenCalledOnce(); expect(test.renderer.setSource).not.toHaveBeenCalled();
    expect(test.viewer.forceRedraw).toHaveBeenCalledTimes(3);
    test.drawScene(3); await flush();
    expect(test.bitmap).toHaveBeenCalledTimes(2); expect(test.renderer.setSource).toHaveBeenCalledOnce();
    expect(test.renderer.setSource.mock.calls[0][0].color.scene).toBe(3);
    expect(test.renderer.setSource.mock.calls[0][0].screenToWorld[0]).toBe(0.5);
  });

  it('applies zoom hysteresis when an already running view drops back to overview', async () => {
    const test = setup(); await start(test);
    test.setCamera({ a: 0.6, b: 0, c: 0, d: 0.6, e: 0, f: 0 }); test.emit('zoom');
    await vi.advanceTimersByTimeAsync(160); test.drawScene(2); await flush();
    expect(test.provider.prepare).toHaveBeenCalledTimes(2);
    test.setCamera({ a: 0.49, b: 0, c: 0, d: 0.49, e: 0, f: 0 }); test.emit('zoom');
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); expect(test.provider.prepare).toHaveBeenCalledTimes(2);
    test.setCamera({ a: 0.6, b: 0, c: 0, d: 0.6, e: 0, f: 0 }); test.emit('zoom');
    await vi.advanceTimersByTimeAsync(1000); expect(test.provider.prepare).toHaveBeenCalledTimes(2);
    test.setCamera({ a: 0.75, b: 0, c: 0, d: 0.75, e: 0, f: 0 }); test.emit('zoom');
    await vi.advanceTimersByTimeAsync(160); expect(test.provider.prepare).toHaveBeenCalledTimes(3);
  });

  it.each(['mask', 'bitmap', 'GPU', 'render'])('keeps the original map visible and stops scheduled work after a %s failure', async stage => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = setup(), error = new Error(`${stage} unavailable`);
    if (stage === 'mask') test.provider.prepare.mockRejectedValueOnce(error);
    else if (stage === 'bitmap') test.bitmap.mockRejectedValueOnce(error);
    else if (stage === 'GPU') test.factory.mockImplementationOnce(() => { throw error; });
    else test.renderer.render.mockImplementationOnce(() => { throw error; });
    await start(test); tick();
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    expect(test.overlay.stats()).toMatchObject({ status: 'error', error: `${stage} unavailable` });
    const calls = test.viewer.forceRedraw.mock.calls.length;
    tick(performance.now() + 1000); expect(test.viewer.forceRedraw).toHaveBeenCalledTimes(calls);
    expect(test.canvas.contains(test.terrain)).toBe(true);
  });

  it('recaptures the original map after context restoration and resumes without a time jump', async () => {
    const test = setup(); await start(test); tick(); tick(performance.now() + 34);
    const elapsed = test.renderer.render.mock.calls.at(-1)![0];
    test.layer.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(test.layer.hidden).toBe(true); expect(queue.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000); expect(test.renderer.setSource).toHaveBeenCalledOnce();
    test.layer.dispatchEvent(new Event('webglcontextrestored'));
    await vi.advanceTimersByTimeAsync(80); test.drawScene(12); await flush(); tick();
    expect(test.renderer.setSource).toHaveBeenCalledTimes(2); expect(test.factory).toHaveBeenCalledOnce();
    expect(test.renderer.render.mock.calls.at(-1)![0]).toBe(elapsed);
  });

  it('aligns physical crop ratios with the drawer flip and rotation', async () => {
    const test = setup({ ratio: 1.5, ratioY: 2 });
    test.setCamera({ a: 0, b: 2, c: -2, d: 0, e: 700, f: 20 }); test.setFlip(true); test.emit('flip');
    await start(test);
    const source = test.renderer.setSource.mock.calls[0][0], [a, b, c, d, e, f] = source.screenToWorld;
    const [, x, y, width, height] = test.bitmap.mock.calls[0];
    expect(test.layer.style.left).toBe(`${x / 1.5}px`); expect(test.layer.style.top).toBe(`${y / 2}px`);
    expect(test.layer.style.width).toBe(`${width / 1.5}px`); expect(test.layer.style.height).toBe(`${height / 2}px`);
    const px = 0.5, py = 0.5, worldX = a * px + c * py + e, worldY = b * px + d * py + f;
    // OSD's projection includes rotation, while its separate drawer flip maps x to width-x.
    expect((800 - (-2 * worldY + 700)) * 1.5).toBeCloseTo(x + px, 9);
    expect((2 * worldX + 20) * 2).toBeCloseTo(y + py, 9);
    expect(source.width).toBe(width); expect(source.height).toBe(height);
  });

  it('leaves empty views idle and releases timers, callbacks, and resources exactly once', async () => {
    const empty = setup({ mask: null }); await start(empty);
    expect(empty.factory).not.toHaveBeenCalled(); expect(empty.bitmap).not.toHaveBeenCalled();
    expect(empty.overlay.stats().status).toBe('no-visible-liquids'); empty.overlay.destroy();
    const test = setup(); await start(test); test.emit('tile-loaded');
    test.overlay.destroy(); test.overlay.destroy();
    expect(test.provider.destroy).toHaveBeenCalledOnce(); expect(test.renderer.dispose).toHaveBeenCalledOnce();
    expect(test.viewer.handlers.size).toBe(0); expect(test.viewer.world.handlers.size).toBe(0);
    expect(test.canvas.contains(test.layer)).toBe(false); expect(queue.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    hidden = true; document.dispatchEvent(new Event('visibilitychange')); media.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(5000); expect(test.provider.prepare).toHaveBeenCalledOnce();
  });
});

function fakeWorker() {
  return { onmessage: null as ((event: MessageEvent) => void) | null, onerror: null as ((event: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null, postMessage: vi.fn(), terminate: vi.fn() };
}

describe('liquid mask worker request lifecycle', () => {
  const bounds = { x: 0, y: 0, width: 4, height: 4 };
  it('matches responses by request and transfers crop buffers without leaving timeout work', async () => {
    const worker = fakeWorker(), client = new LiquidMaskWorkerClient(worker as unknown as Worker), signal = new AbortController().signal;
    const paint = client.paint(bounds, [{ url: '/mask.bin' }], signal), pixels = new Uint8Array(16).fill(255);
    const request = worker.postMessage.mock.calls[0][0]; expect(request).toMatchObject({ type: 'paint', bounds });
    worker.onmessage!({ data: { id: request.id, pixels } } as MessageEvent); await expect(paint).resolves.toBe(pixels);
    const crop = client.crop(bounds, pixels, [], signal), next = worker.postMessage.mock.calls[1];
    expect(next[1]).toEqual([pixels.buffer]);
    worker.onmessage!({ data: { id: next[0].id, mask: { ...bounds, pixels } } } as MessageEvent);
    await expect(crop).resolves.toEqual({ ...bounds, pixels }); expect(vi.getTimerCount()).toBe(0); client.destroy();
  });

  it('cancels a superseded request and ignores its late response', async () => {
    const worker = fakeWorker(), client = new LiquidMaskWorkerClient(worker as unknown as Worker), controller = new AbortController();
    const result = client.paint(bounds, [], controller.signal).catch(error => error), id = worker.postMessage.mock.calls[0][0].id;
    controller.abort('superseded seed'); await expect(result).resolves.toBe('superseded seed');
    expect(worker.postMessage.mock.calls.at(-1)![0]).toEqual({ type: 'cancel', id });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => worker.onmessage!({ data: { id, pixels: new Uint8Array(16) } } as MessageEvent)).not.toThrow(); client.destroy();
  });

  it.each(['dispose', 'worker-error', 'message-error'])('rejects pending and future work immediately after %s', async reason => {
    const worker = fakeWorker(), client = new LiquidMaskWorkerClient(worker as unknown as Worker), signal = new AbortController().signal;
    const pending = client.paint(bounds, [], signal).catch(error => error);
    if (reason === 'dispose') client.destroy();
    else if (reason === 'worker-error') worker.onerror!({ message: 'GPU worker failed' } as ErrorEvent);
    else worker.onmessageerror!();
    expect(await pending).toMatchObject({ name: reason === 'dispose' ? 'AbortError' : 'Error', message: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
    let rejected = false;
    const future = client.paint(bounds, [], signal).catch(() => { rejected = true; });
    await flush();
    try {
      expect(rejected).toBe(true); expect(worker.postMessage).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { client.destroy(); await future; }
  });

  it('cleans up timeout, synchronous post failure, and already-aborted requests', async () => {
    const worker = fakeWorker(), client = new LiquidMaskWorkerClient(worker as unknown as Worker), controller = new AbortController();
    const timed = client.paint(bounds, [], controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(35_000); expect((await timed).message).toMatch(/timed out/); expect(vi.getTimerCount()).toBe(0);
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Detached buffer'); });
    await expect(client.paint(bounds, [], controller.signal)).rejects.toThrow('Detached buffer'); expect(vi.getTimerCount()).toBe(0);
    const calls = worker.postMessage.mock.calls.length; controller.abort();
    await expect(client.paint(bounds, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0); client.destroy();
  });
});
