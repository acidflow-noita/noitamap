// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectReportHighlights, ReportMapHighlights } from '../src/report-map-highlights';
const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
let overlay: ReportMapHighlights | undefined;
let frames: Map<number, FrameRequestCallback>;
let next = 0;
beforeEach(() => {
  frames = new Map(); next = 0;
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { overlay?.destroy(); overlay = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); };
describe('temporary report map highlights', () => {
  it('emphasizes main-path/main-world locations, clusters nearby targets and ignores duplicates/offscreen/invalid coordinates', () => {
    const result = projectReportHighlights([
      { worldX: 50, worldY: 50, pw: 1, biome: 'coalmine' },
      { worldX: 51, worldY: 51, pw: 0, biome: 'coalmine' },
      { worldX: 51, worldY: 51, pw: 0, biome: 'coalmine' },
      { worldX: 150, worldY: 150, pw: 0, biome: 'desert' },
      { worldX: -10, worldY: 50 }, { worldX: NaN, worldY: 0 },
    ], m, 800, 600);
    expect(result).toHaveLength(2);
    expect(result.at(-1)).toEqual({ x: 51, y: 51, count: 2, primary: true, mainPath: true });
    expect(result[0].mainPath).toBe(false);
    expect(projectReportHighlights([], { ...m, a: NaN }, 800, 600)).toEqual([]);
  });
  it('has no camera changes or perpetual animation loop, and clears only its own layer', () => {
    const container = document.createElement('div'); document.body.append(container);
    const persistent = document.createElement('div'); persistent.className = 'persistent-high-value'; container.append(persistent);
    const handlers = new Map<string, () => void>();
    let dx = 0;
    const viewport = { pixelFromPoint: (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y }), panTo: vi.fn(), zoomTo: vi.fn() };
    const viewer = { container, canvas: { clientWidth: 800, clientHeight: 600 }, viewport,
      addHandler: (name: string, fn: () => void) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) };
    overlay = new ReportMapHighlights(viewer);
    overlay.setTargets([{ worldX: 100, worldY: 150, biome: 'coalmine', pw: 0 }]);
    expect(frames.size).toBe(1); flush(); expect(frames.size).toBe(0);
    expect(container.querySelector('g')?.getAttribute('transform')).toBe('translate(100,150)');
    expect(container.querySelector('filter')).toBeNull();
    dx = 30; handlers.get('update-viewport')!(); handlers.get('update-viewport')!(); expect(frames.size).toBe(1); flush();
    expect(container.querySelector('g')?.getAttribute('transform')).toBe('translate(130,150)');
    expect(viewport.panTo).not.toHaveBeenCalled(); expect(viewport.zoomTo).not.toHaveBeenCalled();
    overlay.setTargets([]); expect(container.querySelector('g')).toBeNull(); expect(persistent.isConnected).toBe(true);
    overlay.setTargets([{ worldX: 20, worldY: 20 }]); handlers.get('close')!(); flush(); expect(container.querySelector('g')).toBeNull();
  });
});
