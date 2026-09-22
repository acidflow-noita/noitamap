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
    for (let t = 0; t <= 2600; t += 10) { frame(t); scales.push(zoom); expect(frames.size).toBeLessThanOrEqual(1); }
    expect(await done).toBe(true);
    expect(zoom).toBeCloseTo(600 / (1200 * 512), 12);
    expect(center.x).toBeCloseTo(30000 + 256, 8);
    expect(center.y).toBe(9000);
    expect(Math.max(...scales.slice(1).map((z, i) => Math.abs(Math.log(z / scales[i]))))).toBeLessThan(.2);
    expect(app.viewport.getCenter).toHaveBeenCalledWith(true);
    expect(app.viewer.addOverlay).toHaveBeenCalledOnce();
  });
  it.each([1 / 128, 1 / 512, 1 / 1024, 1 / 500000])('zooms out once and in once without extra reversals from %f', async initialZoom => {
    zoom = initialZoom;
    const targetZoom = 1 / 1024;
    const done = app.panToTarget(30000, 9000, { offsetXPx: 300 });
    const route = (app as any).panTrailData;
    const duration = Math.max(1400, Math.min(2600, 1100 + Math.hypot(route.x2 - route.x1, route.y2 - route.y1) * .08));
    let previous = initialZoom, overview = initialZoom;
    for (let step = 0; step <= 180; step++) {
      frame(duration * step / 180);
      expect(zoom).toBeLessThanOrEqual(Math.max(initialZoom, targetZoom) + 1e-12);
      if (step <= 90) expect(zoom).toBeLessThanOrEqual(previous + 1e-12);
      else expect(zoom).toBeGreaterThanOrEqual(previous - 1e-12);
      if (step === 90) overview = zoom;
      previous = zoom;
    }
    frame(2600);
    expect(await done).toBe(true);
    expect(overview).toBeLessThan(targetZoom / 10);
    expect(zoom).toBe(targetZoom);
  });
  it.each([[30000, 0, 0], [0, 30000, 300], [-30000, -10000, 300]])(
    'keeps the visible camera center on the rendered arrow toward (%s, %s), sidebar offset %s',
    async (x, y, offset) => {
      const done = app.panToTarget(x, y, { offsetXPx: offset });
      const route = (app as any).panTrailData;
      const duration = Math.max(1400, Math.min(2600, 1100 + Math.hypot(route.x2 - route.x1, route.y2 - route.y1) * .08));
      const bezier = (a: number, c: number, b: number, u: number) => (1 - u) ** 2 * a + 2 * (1 - u) * u * c + u ** 2 * b;
      for (const time of [duration / 4, duration / 2]) {
        frame(time);
        const t = Math.max(0, Math.min(1, (time / duration - .25) / .5)), u = t * t * (3 - 2 * t);
        expect(center.x - offset / (1200 * zoom)).toBeCloseTo(bezier(route.x1, route.cxW, route.x2, u), 8);
        expect(center.y).toBeCloseTo(bezier(route.y1, route.cyW, route.y2, u), 8);
        const points = route.path.getAttribute('d').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi).map(Number);
        expect(bezier(points[0], points[2], points[4], u)).toBeCloseTo(600 - offset, 7);
        expect(bezier(points[1], points[3], points[5], u)).toBeCloseTo(400, 7);
      }
      // The original cinematic overview must reveal both ends of the arrow.
      frame(duration / 2);
      for (const point of [new Point(route.x1, route.y1), new Point(route.x2, route.y2)]) {
        const pixel = app.viewport.viewportToViewerElementCoordinates(point);
        expect(pixel.x).toBeGreaterThanOrEqual(0);
        expect(pixel.x).toBeLessThanOrEqual(1200 - offset * 2);
        expect(pixel.y).toBeGreaterThanOrEqual(0);
        expect(pixel.y).toBeLessThanOrEqual(800);
      }
      frame(2600); expect(await done).toBe(true);
    },
  );
  it.each([0, 300])('finishes zoom-out before travel and finishes travel before zoom-in (sidebar %s)', async offset => {
    const origin = new Point(center.x - offset / (1200 * zoom), center.y);
    const initialZoom = zoom;
    const done = app.panToTarget(30000, 9000, { offsetXPx: offset });
    const visibleCenter = () => new Point(center.x - offset / (1200 * zoom), center.y);
    // A far journey lasts 2600ms: out 0–650, travel 650–1950, in 1950–2600.
    for (const time of [100, 300, 600, 650]) {
      frame(time);
      expect(visibleCenter().x).toBeCloseTo(origin.x, 8);
      expect(visibleCenter().y).toBeCloseTo(origin.y, 8);
    }
    const overview = zoom;
    expect(overview).toBeLessThan(initialZoom / 10);
    for (const time of [700, 1000, 1300, 1700, 1950]) {
      frame(time);
      expect(zoom).toBe(overview);
    }
    expect(visibleCenter().x).toBeCloseTo(30000, 8);
    expect(visibleCenter().y).toBeCloseTo(9000, 8);
    for (const time of [2000, 2200, 2400, 2600]) {
      frame(time);
      expect(visibleCenter().x).toBeCloseTo(30000, 8);
      expect(visibleCenter().y).toBeCloseTo(9000, 8);
      expect(zoom).toBeGreaterThan(overview);
    }
    expect(await done).toBe(true);
  });
  it('skips the initial zoom phase when the view is already wide enough', async () => {
    zoom = 1 / 500000;
    const initialZoom = zoom;
    const done = app.panToTarget(30000, 9000);
    frame(100);
    expect(zoom).toBeCloseTo(initialZoom, 12);
    expect(center.x).toBeGreaterThan(0);
    frame(2600); expect(await done).toBe(true);
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
