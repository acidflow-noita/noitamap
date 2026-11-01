// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenSeadragon from 'openseadragon';
import { SunOverlay } from '../src/portals/suns/overlay';
import { SUNS } from '../src/portals/suns/placements';
import { sunVisibility } from '../src/portals/suns/visibility';
import { SunFramePacing } from '../src/portals/suns/frame-pacing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SunResponse, SunRequest, SunWorker } from '../src/portals/suns/protocol';

const context = { transferFromImageBitmap: vi.fn() };
let overlay: SunOverlay | undefined;
let queue = new Map<number, FrameRequestCallback>(), sequence = 0;
beforeEach(() => {
  vi.stubGlobal('OpenSeadragon', OpenSeadragon);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.set(++sequence, cb); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
  context.transferFromImageBitmap.mockClear();
});
afterEach(() => { overlay?.destroy(); overlay = undefined; queue.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const tick = (now: number) => { const work = [...queue.values()]; queue.clear(); work.forEach(cb => cb(now)); };
function setup(initialScale = 1, visible = true, enabled = true) {
  const canvas = document.createElement('div'); document.body.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  let scale = initialScale, x = SUNS[0].x, y = visible ? SUNS[0].y : 0;
  const handlers = new Map<string, () => void>();
  const viewer = { canvas, viewport: { pixelFromPoint: (p: { x: number; y: number }) => ({ x: (p.x - x) * scale + 400, y: (p.y - y) * scale + 300 }) },
    addHandler: (name: string, cb: () => void) => handlers.set(name, cb), removeHandler: (name: string) => handlers.delete(name) };
  const worker: SunWorker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
  const factory = vi.fn(() => worker);
  overlay = new SunOverlay(viewer, 618, factory, enabled);
  const send = (data: SunResponse) => worker.onmessage!({ data } as MessageEvent<SunResponse>);
  const frames = () => vi.mocked(worker.postMessage).mock.calls.map(([data]) => data).filter((data): data is Extract<SunRequest, { type: 'frame' }> => data.type === 'frame');
  const reply = () => {
    const bitmap = { width: 512, height: 512, close: vi.fn() } as unknown as ImageBitmap;
    send({ type: 'frame', effect: frames().at(-1)!.effect, bitmap, stats: { particles: 7500, estimatedGPUBytes: 16e6,
      gpuMS: 1, cpuMS: 2, draws: frames().length, retainedSuns: 1, device: 'test', steps: 1, warm: frames().length === 1,
      outputSize: 512, outputPixels: 512 * 512 } });
    return bitmap;
  };
  const move = (zoom: number, sun = SUNS[0]) => { scale = zoom; x = sun.x; y = sun.y; handlers.get('update-viewport')!(); };
  return { canvas, handlers, worker, factory, frames, send, reply, move };
}
describe('Sun transitions and resource lifetime', () => {
  it('overrides the real map pixelation rule for Sun frames without changing terrain filtering', () => {
    const css = readFileSync(resolve('public/css/style.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = css.match(/\.openseadragon-canvas canvas,\s*\.openseadragon-canvas img\s*\{[^}]+\}/)![0];
    document.body.append(style);
    const test = setup(); test.canvas.classList.add('openseadragon-canvas');
    const terrain = document.createElement('canvas'); test.canvas.append(terrain);
    expect(getComputedStyle(terrain).imageRendering).toBe('pixelated');
    for (const image of test.canvas.querySelectorAll('.noitamap-suns img, .noitamap-suns canvas'))
      expect(getComputedStyle(image).imageRendering).toBe('auto');
  });
  it('does not start a worker at the surface, at world overview, or in spoiler-free mode', () => {
    let test = setup(1, false); expect(test.factory).not.toHaveBeenCalled(); overlay!.destroy();
    test = setup(.01); expect(test.factory).not.toHaveBeenCalled();
    expect(test.canvas.querySelector('img')!.getAttribute('src')).toContain('sun-preview.webp'); overlay!.destroy();
    test = setup(1, true, false); expect(test.factory).not.toHaveBeenCalled();
    expect(test.canvas.querySelector('img')!.hasAttribute('src')).toBe(false);
  });
  it('keeps the still visible until a real frame arrives, never queues overlapping work', () => {
    const test = setup(); expect(test.factory).toHaveBeenCalledOnce();
    test.send({ type: 'ready', startupMS: 20 }); tick(1); tick(20); tick(40);
    expect(test.frames()).toHaveLength(1);
    expect(test.canvas.querySelector('canvas')!.hidden).toBe(true);
    const bitmap = test.reply();
    expect(context.transferFromImageBitmap).toHaveBeenCalledWith(bitmap);
    expect(test.canvas.querySelector('canvas')!.hidden).toBe(false);
    expect(test.canvas.querySelector('img')!.style.opacity).toBe('0');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('freezes and reprojects the same complete frame, then resumes without elapsed-time catch-up', () => {
    const test = setup(); test.send({ type: 'ready', startupMS: 20 }); tick(1); test.reply();
    const figure = test.canvas.querySelector('[data-effect="sun"]') as HTMLElement;
    test.move(.04); tick(10_000);
    expect(overlay!.stats().status).toBe('paused'); expect(test.frames()).toHaveLength(1);
    expect(figure.querySelector('canvas')!.hidden).toBe(false);
    expect(figure.querySelector('img')!.style.opacity).toBe('0');
    expect(figure.style.transform).toContain('matrix(0.04');
    test.move(1); tick(10_017);
    expect(test.frames()).toHaveLength(2); expect(test.frames()[1].elapsedMS).toBe(0);
    expect(test.factory).toHaveBeenCalledOnce();
  });
  it('uses an isolated additive initial fade so opaque cores do not flash transparent', async () => {
    const test = setup();
    const preview = test.canvas.querySelector('img')!;
    Object.defineProperties(preview, { complete: { value: true }, naturalWidth: { value: 512 } });
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    vi.stubGlobal('Animation', class {});
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      test.send({ type: 'ready', startupMS: 20 }); tick(1); test.reply();
      const figure = test.canvas.querySelector('[data-effect="sun"]') as HTMLElement;
      expect(figure.style.isolation).toBe('isolate');
      expect(figure.querySelector('canvas')!.style.mixBlendMode).toBe('plus-lighter');
      expect(animate.mock.calls.map(call => (call as any)[0])).toEqual([
        [{ opacity: 1 }, { opacity: 0 }], [{ opacity: 0 }, { opacity: 1 }],
      ]);
      await Promise.resolve(); await Promise.resolve();
      expect(figure.querySelector('canvas')!.style.mixBlendMode).toBe('normal');
    } finally { delete (HTMLElement.prototype as any).animate; }
  });
  it('keeps animating at a lower cadence on slow devices instead of permanently freezing', () => {
    let clock = 1; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const test = setup(); test.send({ type: 'ready', startupMS: 20 }); tick(clock); clock += 60; test.reply();
    for (let i = 0; i < 30; i++) { tick(clock); clock += 80; test.reply(); }
    expect(overlay!.stats().status).toBe('animated'); expect(overlay!.stats().targetFPS).toBe(15);
    const count = test.frames().length; tick(clock + 1000); test.move(2); tick(clock + 2000);
    expect(test.frames()).toHaveLength(count + 1); // Still only one request in flight.
    expect(test.canvas.querySelector('canvas')!.hidden).toBe(false);
  });
  it('ignores cold startup and recovers cadence only after sustained fast frames', () => {
    const pacing = new SunFramePacing();
    pacing.observe(1000, true); expect(pacing.fps).toBe(60);
    for (let i = 0; i < 6; i++) pacing.observe(40, false);
    expect(pacing.fps).toBe(30);
    for (let i = 0; i < 44; i++) pacing.observe(5, false);
    expect(pacing.fps).toBe(30);
    pacing.observe(5, false); expect(pacing.fps).toBe(60);
  });
  it('uses different enter/exit thresholds, preventing flicker near the boundary', () => {
    const test = setup(.09); test.send({ type: 'ready', startupMS: 20 }); tick(1); test.reply();
    test.move(.07); expect(overlay!.stats().status).toBe('animated');
    test.move(.05); expect(overlay!.stats().status).toBe('paused');
    test.move(.07); expect(overlay!.stats().status).toBe('paused');
    test.move(.09); expect(overlay!.stats().status).toBe('animated');
  });
  it('retains each Sun image independently and uses a single worker when moving between them', () => {
    const test = setup(); test.send({ type: 'ready', startupMS: 20 }); tick(1); test.reply();
    test.move(1, SUNS[1]); tick(18); test.reply();
    expect(test.frames().map(f => f.effect)).toEqual(['sun', 'dark_sun']);
    expect([...test.canvas.querySelectorAll('canvas')].every(c => !c.hidden)).toBe(true);
    expect(test.factory).toHaveBeenCalledOnce();
    test.move(1); tick(35); expect(test.frames().at(-1)!.elapsedMS).toBe(0);
  });
  it('keeps the last image on failure, cancels hidden-tab work, and closes late bitmaps on teardown', () => {
    const test = setup(); test.send({ type: 'ready', startupMS: 20 }); tick(1); test.reply();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); tick(1000);
    expect(test.frames()).toHaveLength(1); expect(overlay!.stats().status).toBe('paused');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    test.send({ type: 'error', message: 'lost' });
    expect(overlay!.stats().error).toBe('lost'); expect(test.worker.terminate).toHaveBeenCalledOnce();
    expect(test.canvas.querySelector('canvas')!.hidden).toBe(false);
    overlay!.destroy(); const late = test.reply(); expect(late.close).toHaveBeenCalledOnce();
    expect(test.handlers.size).toBe(0); expect(test.canvas.children.length).toBe(0);
  });
  it('culls rotated/flipped frames and starts preparation just before the viewport edge', () => {
    const sun = { ...SUNS[0], x: 0, y: 0 };
    const camera = { a: 0, b: .1, c: -.1, d: 0, e: 900, f: 300 };
    expect(sunVisibility(sun, camera, 800, 600, false)).toMatchObject({ visible: false, animate: false, prepare: true });
    expect(sunVisibility(sun, { ...camera, e: 1300 }, 800, 600, false).prepare).toBe(false);
  });
});
