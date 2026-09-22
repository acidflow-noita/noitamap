// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/data_sources/tile_data', () => ({ fetchMapVersions: vi.fn(), getTileData: vi.fn() }));
vi.mock('../src/data_sources/overlays', () => ({ createOverlays: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/simplistic-background', () => ({ isSimplisticBackground: () => false }));
import { AppOSD } from '../src/app_osd';
class Point { constructor(public x: number, public y: number) {} }
let now = 0, next = 0;
let frames: Map<number, FrameRequestCallback>;
let app: AppOSD;
let handlers: Map<string, Set<() => void>>;
let center: Point, zoom: number;
function frame(time: number) {
  now = time;
  const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn(time));
  handlers.get('update-viewport')?.forEach(fn => fn());
}
beforeEach(() => {
  now = 0; next = 0; frames = new Map(); handlers = new Map();
  center = new Point(0, 0); zoom = 1 / 512;
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('OpenSeadragon', { Point, Placement: { CENTER: 0 } });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const container = document.createElement('div'); document.body.append(container);
  Object.defineProperties(container, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } });
  app = Object.create(AppOSD.prototype);
  app.viewer = { container, canvas: container, viewport: {
    getCenter: vi.fn(() => center), getZoom: vi.fn(() => zoom),
    zoomTo: vi.fn((z: number) => { zoom = z; }), panTo: vi.fn((p: Point) => { center = p; }),
    viewportToViewerElementCoordinates: (p: Point) => new Point(600 + (p.x - center.x) * zoom * 1200, 400 + (p.y - center.y) * zoom * 1200),
  }, addHandler: (event: string, fn: () => void) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(fn); },
  removeHandler: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
  addOverlay: vi.fn(), removeOverlay: vi.fn() };
});
afterEach(() => { (app as any).cancelActivePan(); (app as any).removePanTrail(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
describe('goto camera and arrow', () => {
  it('uses one animation loop with no offscreen blur, and updates the arrow with the rendered camera', async () => {
    const done = app.panToTarget(30000, 9000, { offsetXPx: 300 });
    expect(frames.size).toBe(1);
    expect(document.querySelector('filter, [filter], [stroke-dasharray]')).toBeNull();
    expect(document.querySelector<SVGElement>('.pan-trail-svg')!.style.overflow).toBe('hidden');
    const scales: number[] = [];
    for (let t = 0; t <= 1800; t += 10) { frame(t); scales.push(zoom); expect(frames.size).toBeLessThanOrEqual(1); }
    expect(await done).toBe(true);
    expect(zoom).toBeCloseTo(600 / (1200 * 512), 12);
    expect(center.x).toBeCloseTo(30000 + 256, 8);
    expect(center.y).toBe(9000);
    expect(Math.max(...scales.slice(1).map((z, i) => Math.abs(Math.log(z / scales[i]))))).toBeLessThan(.2);
    expect(app.viewport.getCenter).toHaveBeenCalledWith(true);
    expect(app.viewer.addOverlay).toHaveBeenCalledOnce();
  });
  it.each([1 / 128, 1 / 512, 1 / 1024, 1 / 50000])('never reverses or overshoots zoom mid-pan from %f', async initialZoom => {
    zoom = initialZoom;
    const targetZoom = 1 / 1024;
    const done = app.panToTarget(30000, 9000, { offsetXPx: 300 });
    let previous = initialZoom;
    for (let t = 0; t <= 1800; t += 10) {
      frame(t);
      expect(zoom).toBeGreaterThanOrEqual(Math.min(initialZoom, targetZoom) - 1e-12);
      expect(zoom).toBeLessThanOrEqual(Math.max(initialZoom, targetZoom) + 1e-12);
      if (initialZoom > targetZoom) expect(zoom).toBeLessThanOrEqual(previous + 1e-12);
      else expect(zoom).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = zoom;
    }
    expect(await done).toBe(true);
    expect(zoom).toBe(targetZoom);
  });
  it('does not resolve short hops early or start a separate spring animation', async () => {
    const done = app.panToTarget(100, 50); const settled = vi.fn(); void done.then(settled);
    frame(50); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    frame(2000); expect(await done).toBe(true); expect(center.y).toBe(50);
    expect(app.viewport.panTo.mock.calls.every((call: any[]) => call[1] === true)).toBe(true);
  });
  it('settles superseded navigation as cancelled and cleans up input handlers', async () => {
    const first = app.panToTarget(30000, 0); frame(100);
    const second = app.panToTarget(-1000, 500); expect(await first).toBe(false);
    frame(2100); expect(await second).toBe(true);
    expect(handlers.get('canvas-drag')?.size).toBe(0);
    expect(app.viewer.addOverlay).toHaveBeenCalledOnce();
  });
  it.each(['canvas-drag', 'canvas-scroll', 'canvas-press', 'canvas-key', 'close'])('yields to %s without arriving or leaving an arrow behind', async event => {
    const done = app.panToTarget(20000, 0); frame(100);
    handlers.get(event)?.forEach(fn => fn());
    expect(await done).toBe(false); expect(frames.size).toBe(0);
    expect(document.querySelector('.pan-trail-svg')).toBeNull(); expect(app.viewer.addOverlay).not.toHaveBeenCalled();
  });
  it('honors reduced motion and rejects invalid coordinates', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(await app.panToTarget(900, 500)).toBe(true); expect(center.y).toBe(500); expect(frames.size).toBe(0);
    expect(await app.panToTarget(NaN, 2)).toBe(false);
  });
});
