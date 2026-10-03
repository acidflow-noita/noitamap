// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalGPUOverlay } from '../src/portals/overlay';
import { MAX_CANVAS_PIXELS, reprojectCamera, type CameraMatrix } from '../src/portals/geometry';
import type { PortalPlacement } from '../src/portals/placements';
import type { PortalFrame, PortalGPUStats, PortalWorker, PortalWorkerRequest, PortalWorkerResponse } from '../src/portals/protocol';

let overlay: PortalGPUOverlay | undefined;
let frames = new Map<number, FrameRequestCallback>(), sequence = 0;
const context = { transferFromImageBitmap: vi.fn() };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  history.replaceState(null, '', '/'); context.transferFromImageBitmap.mockClear();
});
afterEach(() => {
  overlay?.destroy(); overlay = undefined; frames.clear(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function tick(now = 1) {
  vi.advanceTimersByTime(Math.max(0, now - performance.now()));
  const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now));
}
function viewer() {
  const canvas = document.createElement('div'); document.body.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  let matrix: CameraMatrix = { a: 1, b: 0, c: 0, d: 1, e: 400, f: 300 };
  const handlers = new Map<string, () => void>();
  return { canvas, handlers, setCamera: (next: CameraMatrix) => { matrix = next; },
    viewport: { pixelFromPoint: (p: { x: number; y: number }) => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f }) },
    addHandler: (name: string, fn: () => void) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) };
}
const portal = { id: 'p', effect: 'teleportation', x: 0, y: 0 } as PortalPlacement;
const stats: PortalGPUStats = { mode: 'experimental-gpu-particles', executionThread: 'worker', revision: '85d0740',
  total: 1, active: 1, visible: 1, capped: 0, particles: 10, visibleParticles: 10, cpuMS: 1, gpuMS: 2,
  frameMS: 3, fps: 0, steps: 1, simFPS: 60, deliveryMS: 0, gpuWaitMS: 1, canvasPixels: 100, estimatedGPUBytes: 1024, device: 'test WebGL2', suspended: false, slow: false };
function worker() {
  const fake: PortalWorker = { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  const send = (data: PortalWorkerResponse) => fake.onmessage!({ data } as MessageEvent<PortalWorkerResponse>);
  const requests = () => vi.mocked(fake.postMessage).mock.calls.map(([data]) => data).filter(
    (data): data is Extract<PortalWorkerRequest, { type: 'frame' }> => data.type === 'frame');
  const reply = (overrides: Partial<PortalGPUStats> = {}) => {
    const request = requests().at(-1)!;
    const bitmap = { width: 928, height: 728, close: vi.fn() } as unknown as ImageBitmap;
    const data: PortalFrame = { type: 'frame', id: request.id, camera: request.camera, bitmap, activePortalIDs: overrides.active === 0 ? [] : ['p'], stats: { ...stats, ...overrides } };
    send(data); return data;
  };
  return { fake, send, requests, reply };
}
function start() {
  const v = viewer(), w = worker(), failure = vi.fn(), publish = vi.fn(), showBackgrounds = vi.fn();
  overlay = new PortalGPUOverlay(v, [portal], 42, new ArrayBuffer(4), () => w.fake, publish, failure, showBackgrounds);
  w.send({ type: 'ready' }); tick();
  return { v, w, failure, publish, showBackgrounds };
}

describe('worker GPU map overlay', () => {
  it('keeps only one request in flight and reprojects pan/zoom before the worker catches up', () => {
    const { v, w } = start();
    expect(w.requests()).toHaveLength(1);
    tick(18); tick(35); expect(w.requests()).toHaveLength(1);
    w.reply(); expect(overlay!.canvas.style.transform).toBe('matrix(1,0,0,1,-64,-64)');
    v.setCamera({ a: 2, b: 0, c: 0, d: 2, e: 400, f: 300 }); v.handlers.get('update-viewport')!();
    expect(overlay!.canvas.style.transform).toBe('matrix(2,0,0,2,-528,-428)');
    tick(52); expect(w.requests()).toHaveLength(2);
    v.setCamera({ a: 3, b: 0, c: 0, d: 3, e: 500, f: 350 }); v.handlers.get('update-viewport')!();
    w.reply(); // reply was rendered at zoom 2, not the current zoom 3
    expect(overlay!.canvas.style.transform).toBe('matrix(1.5,0,0,1.5,-196,-196)');
    expect(v.canvas.querySelectorAll('canvas')).toHaveLength(1);
    expect(overlay!.stats().executionThread).toBe('worker');
    expect(overlay!.canvas.style.imageRendering).toBe('pixelated');
  });

  it('world-anchors cropped worker bitmaps without relying on viewport-sized output', () => {
    const { v, w } = start();
    const request = w.requests()[0];
    const bitmap = { width: 480, height: 320, close: vi.fn() } as unknown as ImageBitmap;
    w.send({ type: 'frame', id: request.id,
      camera: { width: 480, height: 320, resolution: 1, matrix: { a: 1, b: 0, c: 0, d: 1, e: 240, f: 160 } },
      bitmap, activePortalIDs: ['p'], stats });
    expect(overlay!.canvas.style.transform).toBe('matrix(1,0,0,1,160,140)');
    expect(overlay!.canvas.style.width).toBe('480px');
    v.setCamera({ a: 2, b: 0, c: 0, d: 2, e: 400, f: 300 }); v.handlers.get('update-viewport')!();
    expect(overlay!.canvas.style.transform).toBe('matrix(2,0,0,2,-80,-20)');
  });

  it('sends seed/resources/options once and bounds pixels without decoding or simulating on the UI thread', () => {
    history.replaceState(null, '', '/?portalGpuLimit=2');
    const { w } = start();
    expect(vi.mocked(w.fake.postMessage).mock.calls[0][0]).toMatchObject({ type: 'init', seed: 42, portals: [portal], options: { limit: 2 } });
    const camera = w.requests()[0].camera;
    expect(camera.width * camera.height * camera.resolution ** 2).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    const frame = w.reply();
    expect(context.transferFromImageBitmap).toHaveBeenCalledWith(frame.bitmap);
    expect(frame.bitmap.close).toHaveBeenCalledOnce();
  });

  it('does not run an idle view forever, but does not lose a camera change during an empty frame', () => {
    const { v, w } = start(); w.reply({ active: 0, visible: 0 }); tick(18);
    expect(w.requests()).toHaveLength(1);
    v.setCamera({ a: 1, b: 0, c: 0, d: 1, e: 450, f: 300 }); v.handlers.get('update-viewport')!(); tick(35);
    v.setCamera({ a: 1, b: 0, c: 0, d: 1, e: 500, f: 300 }); v.handlers.get('update-viewport')!();
    w.reply({ active: 0, visible: 0 }); tick(52);
    expect(w.requests()).toHaveLength(3);
  });

  it('does not impose extra idle time after slow frames, suspends hidden work, and terminates cleanly', () => {
    const { v, w } = start(); w.reply({ frameMS: 100 });
    tick(18); expect(w.requests()).toHaveLength(2); // no artificial 200ms wait
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    w.reply(); tick(1000); expect(w.requests()).toHaveLength(2); expect(overlay!.canvas.hidden).toBe(true);
    overlay!.setEnabled(false); overlay!.destroy();
    expect(w.fake.terminate).toHaveBeenCalledOnce(); expect(v.handlers.size).toBe(0); expect(v.canvas.children).toHaveLength(0);
    const late = w.reply(); expect(late.bitmap.close).toHaveBeenCalledOnce();
  });

  it('stops on worker GPU failure, without constructing a main-thread or CPU fallback', () => {
    const { w, failure } = start(); w.send({ type: 'error', message: 'GPU context lost' });
    expect(failure).toHaveBeenCalledOnce(); expect(w.fake.terminate).toHaveBeenCalledOnce();
    tick(1000); expect(w.requests()).toHaveLength(1);
  });

  it('shows patches only for the displayed frame and hides them while suspended or destroyed', () => {
    const { w, showBackgrounds } = start();
    expect(showBackgrounds).not.toHaveBeenCalled();
    w.reply(); expect(showBackgrounds).toHaveBeenLastCalledWith(['p']);
    overlay!.setEnabled(false); expect(showBackgrounds).toHaveBeenLastCalledWith([]);
    overlay!.setEnabled(true); expect(showBackgrounds).toHaveBeenLastCalledWith(['p']);
    tick(18); w.reply({ active: 0, visible: 0 }); expect(showBackgrounds).toHaveBeenLastCalledWith([]);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    expect(showBackgrounds).toHaveBeenLastCalledWith([]);
    overlay!.destroy(); expect(showBackgrounds).toHaveBeenLastCalledWith([]);
  });

  it('reprojects rotated/flipped frames by the same world-space affine mapping', () => {
    const rendered = { a: 0, b: 2, c: -2, d: 0, e: 40, f: 70 };
    const current = { a: -3, b: 0, c: 0, d: 3, e: 400, f: 300 };
    const m = reprojectCamera(current, rendered)!;
    const x = 15, y = -20, rx = rendered.a * x + rendered.c * y + rendered.e, ry = rendered.b * x + rendered.d * y + rendered.f;
    expect(m.a * rx + m.c * ry + m.e).toBeCloseTo(current.a * x + current.e);
    expect(m.b * rx + m.d * ry + m.f).toBeCloseTo(current.d * y + current.f);
    expect(reprojectCamera(current, { ...rendered, a: 0, b: 0, c: 0, d: 0 })).toBeNull();
  });
});
