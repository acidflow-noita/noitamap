// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitReportHighlights, projectReportHighlights, ReportMapHighlights, uncoveredReportMapRect } from '../src/report-map-highlights';
const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
let overlay: ReportMapHighlights | undefined;
let frames: Map<number, FrameRequestCallback>;
let next = 0;
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map(); next = 0;
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { overlay?.destroy(); overlay = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); };
describe('temporary report map highlights', () => {
  it('keeps groups and their real POI anchor stable across panning, input order and viewport-edge clipping', () => {
    const targets = [{ worldX: 23, worldY: 12 }, { worldX: 25, worldY: 12 }];
    expect(projectReportHighlights(targets, m, 800, 600)).toEqual([{ x: 23, y: 12, count: 2, primary: false, mainPath: false }]);
    expect(projectReportHighlights([...targets].reverse(), { ...m, e: 2 }, 800, 600))
      .toEqual([{ x: 25, y: 12, count: 2, primary: false, mainPath: false }]);
    const edge = [{ worldX: 0, worldY: 0 }, { worldX: 2, worldY: 0, mainPath: true }];
    expect(projectReportHighlights(edge, { ...m, e: -1 }, 800, 600))
      .toEqual([{ x: 1, y: 0, count: 2, primary: true, mainPath: true }]);
  });
  it('groups by proximity across bucket edges and keeps separate context circles apart', () => {
    const close = [{ worldX: 39, worldY: 10 }, { worldX: 41, worldY: 10 }];
    expect(projectReportHighlights(close, m, 800, 600)).toEqual([{ x: 39, y: 10, count: 2, primary: false, mainPath: false }]);
    const targets = Array.from({ length: 120 }, (_, index) => ({ worldX: (index % 12) * 13, worldY: Math.floor(index / 12) * 17 }));
    const groups = projectReportHighlights(targets, m, 800, 600);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(targets.length);
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      expect(Math.hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y)).toBeGreaterThanOrEqual(40);
    }
    expect(projectReportHighlights([...targets].reverse(), m, 800, 600)).toEqual(groups);
  });
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
  it('uses canonical main-path classification when supplied, including an explicit false override', () => {
    const result = projectReportHighlights([
      { worldX: 50, worldY: 50, pw: 0, biome: 'temple_variant_custom', mainPath: true },
      { worldX: 150, worldY: 150, pw: 0, biome: 'coalmine', mainPath: false },
    ], m, 800, 600);
    expect(result).toEqual([
      { x: 150, y: 150, count: 1, mainPath: false, primary: false },
      { x: 50, y: 50, count: 1, mainPath: true, primary: true },
    ]);
  });
  it('draws without a perpetual animation loop and clears only its own layer', () => {
    const container = document.createElement('div'); document.body.append(container);
    const persistent = document.createElement('div'); persistent.className = 'persistent-high-value'; container.append(persistent);
    const handlers = new Map<string, () => void>();
    let dx = 0;
    const viewport = { pixelFromPoint: (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y }), panTo: vi.fn(), zoomTo: vi.fn() };
    const viewer = { container, canvas: { clientWidth: 800, clientHeight: 600 }, viewport,
      addHandler: (name: string, fn: () => void) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) };
    overlay = new ReportMapHighlights(viewer);
    overlay.setTargets([{ worldX: 100, worldY: 150, biome: 'coalmine', pw: 0 }], { camera: 'keep' });
    expect(frames.size).toBe(1); flush(); expect(frames.size).toBe(0);
    expect(container.querySelector('[data-layer="context"]')?.getAttribute('transform')).toBe('translate(100,150)');
    expect(container.querySelector('filter')).toBeNull();
    dx = 30; handlers.get('update-viewport')!(); handlers.get('update-viewport')!(); expect(frames.size).toBe(0);
    expect(container.querySelector('[data-layer="context"]')?.getAttribute('transform')).toBe('translate(130,150)');
    expect(viewport.panTo).not.toHaveBeenCalled(); expect(viewport.zoomTo).not.toHaveBeenCalled();
    overlay.setTargets([]); expect(container.querySelector('[data-layer]')).toBeNull(); expect(persistent.isConnected).toBe(true);
    overlay.setTargets([{ worldX: 20, worldY: 20 }]); handlers.get('close')!(); flush(); expect(container.querySelector('[data-layer]')).toBeNull();
  });
});

describe('stable report marker movement and navigation fades', () => {
  const closeTargets = [{ worldX: 0, worldY: 0 }, { worldX: 1, worldY: 0 }];
  const context = () => document.querySelector<SVGGElement>('.report-highlight-context')!;

  it('reuses group nodes and their contents during a pan instead of rebuilding or regrouping circles', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep' }); flush();
    const group = context().querySelector('[data-layer="context"]')!, circle = group.firstElementChild;
    expect(group.querySelector('text')?.textContent).toBe('2');
    fixture.viewport.panTo({ x: 0.25, y: 0 }, true); fixture.emit('update-viewport'); flush();
    expect(context().querySelector('[data-layer="context"]')).toBe(group);
    expect(group.firstElementChild).toBe(circle);
    expect(group.getAttribute('transform')).toBe('translate(398,300)');
    expect(group.querySelector('text')?.textContent).toBe('2');
  });

  it('splits on manual zoom while retaining every old anchor, and merges into existing anchors without lost counts', () => {
    const fixture = cameraFixture();
    const targets = [0, 4.5, 7, 12].map(worldX => ({ worldX, worldY: 0 }));
    const anchors = () => [...context().querySelectorAll('[data-layer="context"]')].map(node => node.getAttribute('data-location'));
    const total = () => [...context().querySelectorAll('[data-layer="context"]')]
      .reduce((sum, node) => sum + Number(node.querySelector('text')?.textContent ?? 1), 0);
    overlay!.setTargets(targets, { camera: 'keep' }); flush();
    const initial = anchors();
    expect(initial).toEqual(['0:0', '7:0', '12:0']); expect(total()).toBe(4);
    fixture.viewport.zoomTo(0.02, null, true); fixture.emit('update-viewport');
    expect(anchors()).toHaveLength(4);
    expect(initial.every(anchor => anchors().includes(anchor))).toBe(true); expect(total()).toBe(4);
    fixture.viewport.zoomTo(0.004, null, true); fixture.emit('update-viewport');
    expect(anchors()).toEqual(['0:0']); expect(total()).toBe(4);
    fixture.viewport.zoomTo(0.01, null, true); fixture.emit('update-viewport');
    expect(anchors()).toEqual(initial); expect(total()).toBe(4);
    expect(document.querySelector('.report-highlight-previous-context')).toBeNull();
    expect(vi.getTimerCount()).toBe(0); expect(frames.size).toBe(0);
  });

  it('keeps manual zoom groups through small scale changes instead of flickering at a bucket boundary', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep' }); flush();
    const group = context().firstElementChild;
    for (const zoom of [0.0101, 0.011, 0.0095, 0.0105]) {
      fixture.viewport.zoomTo(zoom, null, true); fixture.emit('update-viewport');
      expect(context().firstElementChild).toBe(group);
      expect(context().querySelector('text')?.textContent).toBe('2');
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does no marker DOM work or queued redraw for tile-only update events', () => {
    const fixture = cameraFixture();
    const targets = Array.from({ length: 50 }, (_, index) => ({ worldX: index - 25, worldY: 0 }));
    overlay!.setTargets(targets, { camera: 'keep' }); flush();
    const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
    const insertBefore = vi.spyOn(Node.prototype, 'insertBefore');
    for (let i = 0; i < 30; i++) fixture.emit('update-viewport');
    expect(setAttribute).not.toHaveBeenCalled(); expect(insertBefore).not.toHaveBeenCalled();
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    setAttribute.mockRestore(); insertBefore.mockRestore();
  });

  it('reuses group projection and leaves other markers untouched when the selected location changes', () => {
    cameraFixture();
    const targets = [-20, 0, 20].map(worldX => ({ worldX, worldY: 0 }));
    overlay!.setTargets(targets, { camera: 'keep', dimContext: true, activeTargets: [targets[0]] }); flush();
    const groups = [...context().children], untouched = context().querySelector('[data-location="20:0"]')!;
    const circles = [...untouched.children];
    const untouchedAttributes = vi.spyOn(untouched, 'setAttribute');
    const svgAttributes = vi.spyOn(document.querySelector('.report-map-highlights')!, 'setAttribute');
    // Once immutable targets are installed, changing selection must not read
    // their full coordinates again for identity keys or grouping.
    const targetRead = vi.fn(() => 20);
    Object.defineProperty(targets[2], 'worldX', { get: targetRead });
    overlay!.setTargets(targets, { camera: 'keep', dimContext: true, activeTargets: [targets[1]] }); flush();
    expect(targetRead).not.toHaveBeenCalled();
    expect(untouchedAttributes).not.toHaveBeenCalled(); expect(svgAttributes).not.toHaveBeenCalled();
    expect([...context().children]).toEqual(groups); expect([...untouched.children]).toEqual(circles);
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('data-location')).toBe('0:0');
    untouchedAttributes.mockRestore(); svgAttributes.mockRestore();
  });

  it('replaces cached context when a different category already fits the unchanged camera', () => {
    const fixture = cameraFixture();
    overlay!.setTargets([{ worldX: 0, worldY: 0 }], { camera: 'keep' }); flush();
    overlay!.setTargets([{ worldX: 10, worldY: 0 }]); vi.advanceTimersByTime(250); flush();
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    expect([...context().children].map(node => node.getAttribute('data-location'))).toEqual(['10:0']);
    expect(context().firstElementChild?.getAttribute('transform')).toBe('translate(480,300)');
  });

  it('projects in OSD draw order rather than one frame behind its next camera update', () => {
    const fixture = cameraFixture();
    overlay!.setTargets([{ worldX: 0, worldY: 0 }], { camera: 'keep' }); flush();
    const nextOSDFrame = () => {
      fixture.viewport.panTo({ x: fixture.view().x + 1, y: 0 }, true);
      fixture.emit('update-viewport');
      requestAnimationFrame(nextOSDFrame);
    };
    requestAnimationFrame(nextOSDFrame);
    for (let frame = 1; frame <= 3; frame++) {
      flush();
      expect(context().firstElementChild?.getAttribute('transform')).toBe(`translate(${400 - frame * 8},300)`);
      expect(frames.size).toBe(1); // Only OSD owns a continuing frame loop.
    }
    frames.clear();
  });

  it('skips per-marker context updates while Go hides it, while keeping the selected point exact', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep' }); flush();
    fixture.emit('report-navigation-start', { id: 1, target: closeTargets[1] }); flush();
    const marker = context().firstElementChild!;
    const setAttribute = vi.spyOn(marker, 'setAttribute');
    fixture.viewport.panTo({ x: 0.5, y: 0 }, true); fixture.emit('update-viewport');
    expect(setAttribute).not.toHaveBeenCalled();
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('transform')).toBe('translate(404,300)');
    setAttribute.mockRestore();
  });

  it.each([true, false])('fades only context during report Go and restores it on completion=%s', completed => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep', activeTargets: [closeTargets[1]] }); flush();
    fixture.emit('report-navigation-start', { id: 1, target: closeTargets[0] }); flush();
    expect(context().style.opacity).toBe('0');
    expect(context().style.transition).toBe('opacity 140ms ease');
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('data-location')).toBe('0:0');
    fixture.viewport.zoomTo(0.04, null, true); fixture.emit('update-viewport'); fixture.emit('animation-finish'); flush();
    expect(context().querySelector('text')?.textContent).toBe('2');
    overlay!.setTargets(closeTargets, { camera: 'keep', activeTargets: [closeTargets[1]] }); flush();
    expect(context().style.opacity).toBe('0');
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('data-location')).toBe('0:0');
    fixture.emit('report-navigation-end', { id: 1, completed }); flush();
    expect(context().style.opacity).toBe('1');
    expect(context().querySelectorAll('[data-layer="context"]')).toHaveLength(1);
    expect(context().querySelector('text')?.textContent).toBe('2');
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('data-location')).toBe('1:0');
  });

  it.each([true, false])('keeps explicit Go and its independent marker when a category hover is left, completion=%s', completed => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(closeTargets, { camera: 'keep', activeTargets: [closeTargets[0]] }); flush();
    fixture.emit('report-navigation-start', { id: 1, target: closeTargets[0] });
    fixture.viewport.panTo({ x: 10, y: 0 }, false); flush();
    const panCalls = fixture.viewport.panTo.mock.calls.length;
    overlay!.setTargets([{ worldX: 20, worldY: 0 }], { camera: 'keep' }); flush();
    overlay!.setTargets([]); flush();
    expect(context().children).toHaveLength(0);
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('data-location')).toBe('0:0');
    expect(context().style.opacity).toBe('0');
    fixture.progress(0.5); fixture.emit('update-viewport');
    expect(document.querySelector('[data-layer="active"]')?.getAttribute('transform')).toBe('translate(360,300)');
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(panCalls);
    expect(vi.getTimerCount()).toBe(0);
    fixture.settle();
    expect(fixture.view().x).toBe(10);
    fixture.emit('report-navigation-end', { id: 1, completed }); flush();
    expect(document.querySelector('[data-layer]')).toBeNull();
    expect(frames.size).toBe(0);
  });

  it.each(['explicit', 'map-close'] as const)('still removes an in-flight Go marker immediately on %s clear', action => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep' });
    fixture.emit('report-navigation-start', { id: 1, target: closeTargets[0] }); flush();
    if (action === 'explicit') overlay!.setTargets([], { restore: false });
    else fixture.emit('close');
    expect(document.querySelector('[data-layer]')).toBeNull();
    fixture.emit('report-navigation-end', { id: 1, completed: false }); flush();
    expect(document.querySelector('[data-layer]')).toBeNull();
  });

  it('ignores stale flight endings and clears layers without a late fade resurrecting them', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep' }); flush();
    fixture.emit('report-navigation-start', { id: 1, target: closeTargets[0] });
    fixture.emit('report-navigation-start', { id: 2, target: closeTargets[1] });
    fixture.emit('report-navigation-end', { id: 1, completed: false }); flush();
    expect(context().style.opacity).toBe('0');
    overlay!.setTargets([], { restore: false });
    fixture.emit('report-navigation-end', { id: 2, completed: false }); flush(); vi.advanceTimersByTime(1000);
    expect(document.querySelector('[data-layer]')).toBeNull();
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('reveals category context as fitting starts, without waiting for spring completion or another fade', () => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets([{ worldX: -1000, worldY: 0 }, { worldX: 1000, worldY: 0 }], fixture.options); flush();
    expect(context().style.opacity).toBe('0');
    vi.advanceTimersByTime(249); flush(); expect(context().style.opacity).toBe('0');
    vi.advanceTimersByTime(1); flush();
    expect(context().style.opacity).toBe('1'); expect(context().style.transition).toBe('none');
    expect(fixture.view()).toEqual(fixture.initial); // The spring has not advanced yet.
    fixture.progress(0.5); expect(context().style.opacity).toBe('1');
    fixture.settle(); flush(); expect(context().style.opacity).toBe('1');
    overlay!.setTargets([], { restore: false });
    const previous = fixture.view(); fixture.viewport.panTo.mockClear();
    overlay!.setTargets([{ worldX: previous.x - 20, worldY: previous.y }]); vi.advanceTimersByTime(250); flush();
    expect(context().style.opacity).toBe('1'); expect(fixture.view().zoom).toBe(previous.zoom);
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
  });

  it('shares one featured-wand preview through active-card changes without restarting the delay or flight', () => {
    const fixture = cameraFixture(); fixture.animate();
    const targets = [{ worldX: -1000, worldY: 0 }, { worldX: 1000, worldY: 0 }];
    overlay!.setTargets(targets, { ...fixture.options, activeTargets: [targets[0]] });
    vi.advanceTimersByTime(200);
    overlay!.setTargets(targets.map(target => ({ ...target })), { ...fixture.options, activeTargets: [targets[1]] });
    vi.advanceTimersByTime(50); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.progress(0.4);
    overlay!.setTargets(targets, { ...fixture.options, activeTargets: [targets[0]] });
    vi.advanceTimersByTime(1000); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.settle(); overlay!.setTargets([]); vi.advanceTimersByTime(120); fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
  });

  it('keeps selection at one fixed radius and suppresses its duplicate context ring', () => {
    cameraFixture();
    overlay!.setTargets(closeTargets, { camera: 'keep', activeTargets: [closeTargets[0]] }); flush();
    expect(context().querySelectorAll('circle')).toHaveLength(0);
    expect(context().querySelector('text')?.textContent).toBe('2');
    const selected = document.querySelector('[data-layer="active"]')!;
    expect([...selected.querySelectorAll('circle')].map(circle => circle.getAttribute('r'))).toEqual(['12', '12']);
  });

  it('prepares overview groups before fitting and keeps their identity through list, Go, arrival and Back', () => {
    const fixture = cameraFixture(); fixture.animate();
    const targets = [0, 10, 1000].map(worldX => ({ worldX, worldY: 0 }));
    overlay!.setTargets(targets, fixture.options); vi.advanceTimersByTime(250); flush();
    // 0 and 10 are far apart at the old zoom, but adjacent in the fitted view.
    const group = context().querySelector('[data-location="0:0"]')!;
    expect(group.querySelector('text')?.textContent).toBe('2');
    fixture.settle(); fixture.emit('update-viewport');
    const overview = fixture.view();
    overlay!.setTargets(targets, { camera: 'keep' }); flush();
    expect(context().querySelectorAll('[data-layer]')).toHaveLength(2);
    fixture.emit('report-navigation-start', { id: 1, target: targets[1] });
    fixture.viewport.panTo({ x: 0, y: 0 }, true); fixture.viewport.zoomTo(0.02, null, true);
    fixture.emit('update-viewport'); fixture.emit('report-navigation-end', { id: 1 }); flush();
    expect(context().querySelector('[data-location="0:0"]')).toBe(group);
    expect(group.querySelector('text')?.textContent).toBe('2');
    overlay!.restoreView(overview); fixture.progress(0.5); fixture.settle(); fixture.emit('update-viewport');
    expect(context().querySelector('[data-location="0:0"]')).toBe(group);
    expect(context().querySelectorAll('[data-layer]')).toHaveLength(2);
    expect(group.querySelector('text')?.textContent).toBe('2');
  });

  it('shows an explicit overview during the real OSD spring instead of waiting for animation-finish', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const OSD = (await import('openseadragon')).default;
    getContext.mockRestore();
    vi.stubGlobal('OpenSeadragon', OSD);
    const container = document.createElement('div'); document.body.append(container);
    Object.defineProperties(container, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } });
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800 } as DOMRect);
    const viewer = new OSD.EventSource() as any;
    Object.assign(viewer, { container, canvas: container });
    viewer.viewport = new OSD.Viewport({ containerSize: new OSD.Point(1200, 800), springStiffness: 50, animationTime: 1.2 });
    viewer.viewport.viewer = viewer;
    viewer.viewport.zoomTo(1 / 1013, null, true);
    viewer.viewport.panTo(new OSD.Point(7711, 6847), true); viewer.viewport.update();
    overlay = new ReportMapHighlights(viewer);
    // Actual wand positions from the retained three-world baked seed.
    overlay.setTargets([
      { worldX: -3428, worldY: 3814, pw: 0 }, { worldX: -39371, worldY: 3591, pw: -1 },
      { worldX: 32017, worldY: 4039, pw: 1 },
    ], { camera: 'overview', panelBounds: { left: 624, top: 0, right: 1200, bottom: 800 } });
    flush(); expect(context().style.opacity).toBe('1');
    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(1000 / 60); viewer.viewport.update(); viewer.raiseEvent('update-viewport');
    }
    expect(context().querySelector('[data-layer="context"]')).not.toBeNull();
    expect(viewer.viewport.getZoom(true)).not.toBe(viewer.viewport.getZoom(false));
    expect(context().style.opacity).toBe('1'); expect(vi.getTimerCount()).toBe(0);
  });
});

type View = { x: number; y: number; zoom: number };
function cameraMatrix(view: View, rotation = 0, flip = false) {
  const scale = 800 * view.zoom, radians = rotation * Math.PI / 180;
  const a = scale * Math.cos(radians), b = scale * Math.sin(radians), c = -b, d = a;
  const matrix = { a, b, c, d, e: 400 - a * view.x - c * view.y, f: 300 - b * view.x - d * view.y };
  if (flip) { matrix.a *= -1; matrix.c *= -1; matrix.e = 800 - matrix.e; }
  return matrix;
}

describe('report preview fit geometry', () => {
  it('subtracts the report from the actual canvas rectangle, including offset and scaled canvases', () => {
    expect(uncoveredReportMapRect(800, 600, { left: 500, top: 30, right: 900, bottom: 700 },
      { left: 100, top: 50, right: 900, bottom: 650 })).toEqual({ left: 0, top: 0, right: 400, bottom: 600 });
    expect(uncoveredReportMapRect(800, 600, { left: 300, top: 0, right: 700, bottom: 600 },
      { left: 100, top: 0, right: 500, bottom: 300 })).toEqual({ left: 0, top: 0, right: 400, bottom: 600 });
    expect(uncoveredReportMapRect(800, 600, { left: -10, top: -10, right: 810, bottom: 610 }))
      .toEqual({ left: 0, top: 0, right: 0, bottom: 600 });
    expect(uncoveredReportMapRect(800, 600, { left: 900, top: 0, right: 1000, bottom: 600 }))
      .toEqual({ left: 0, top: 0, right: 800, bottom: 600 });
    expect(uncoveredReportMapRect(800, 600, { left: 0, top: 400, right: 800, bottom: 600 }))
      .toEqual({ left: 0, top: 0, right: 800, bottom: 400 });
  });

  it.each([[0, false], [90, false], [37, false], [0, true], [37, true]] as const)(
    'fits all targets outside the panel with padding (rotation %s, flip %s)', (rotation, flip) => {
      const view = { x: 250, y: -350, zoom: 0.01 };
      const targets = [{ worldX: -1000, worldY: 300 }, { worldX: 800, worldY: 1200 },
        { worldX: 500, worldY: -900 }, { worldX: NaN, worldY: 20 }];
      const available = { left: 0, top: 0, right: 380, bottom: 600 };
      const next = fitReportHighlights(targets, cameraMatrix(view, rotation, flip), view, available)!;
      expect(next.zoom).toBeGreaterThan(0); expect(next.zoom).toBeLessThan(view.zoom);
      const projected = cameraMatrix(next, rotation, flip);
      for (const target of targets.slice(0, 3)) {
        const x = projected.a * target.worldX + projected.c * target.worldY + projected.e;
        const y = projected.b * target.worldX + projected.d * target.worldY + projected.f;
        expect(x).toBeGreaterThanOrEqual(available.left + 24 - 1e-7);
        expect(x).toBeLessThanOrEqual(available.right - 24 + 1e-7);
        expect(y).toBeGreaterThanOrEqual(available.top + 24 - 1e-7);
        expect(y).toBeLessThanOrEqual(available.bottom - 24 + 1e-7);
      }
    });

  it('retains zoom for a single location and skips visible, invalid or fully obscured previews', () => {
    const view = { x: 0, y: 0, zoom: 0.01 }, matrix = cameraMatrix(view);
    const available = { left: 0, top: 0, right: 400, bottom: 600 };
    const next = fitReportHighlights([{ worldX: 100, worldY: 50 }], matrix, view, available)!;
    expect(next.zoom).toBe(view.zoom);
    const projected = cameraMatrix(next);
    expect(projected.a * 100 + projected.e).toBeCloseTo(200);
    expect(projected.d * 50 + projected.f).toBeCloseTo(300);
    expect(fitReportHighlights([{ worldX: -20, worldY: 0 }], matrix, view, available)).toBeNull();
    expect(fitReportHighlights([{ worldX: NaN, worldY: 0 }], matrix, view, available)).toBeNull();
    expect(fitReportHighlights([{ worldX: 100, worldY: 0 }], matrix, view, { ...available, right: 0 })).toBeNull();
    expect(fitReportHighlights([{ worldX: 100, worldY: 0 }], matrix, view, { ...available, bottom: 64 })).toBeNull();
    expect(fitReportHighlights([{ worldX: 100, worldY: 0 }], matrix, view, { ...available, right: 96 })).toBeNull();
    expect(fitReportHighlights([{ worldX: 100, worldY: 0 }], { ...matrix, a: NaN }, view, available)).toBeNull();
  });
});

function cameraFixture() {
  const container = document.createElement('div'), canvas = document.createElement('div');
  document.body.append(container); container.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}) });
  const handlers = new Map<string, Set<(event?: any) => void>>();
  const emit = (name: string, event?: any) => { for (const fn of handlers.get(name) ?? []) fn(event); };
  const initial = { x: 0, y: 0, zoom: 0.01 };
  let current = { ...initial }, target = { ...initial }, animate = false;
  const viewport = {
    getCenter: (rendered: boolean) => ({ x: (rendered ? current : target).x, y: (rendered ? current : target).y }),
    getZoom: (rendered: boolean) => (rendered ? current : target).zoom,
    pixelFromPoint: (p: { x: number; y: number }) => {
      const matrix = cameraMatrix(current);
      return { x: matrix.a * p.x + matrix.e, y: matrix.d * p.y + matrix.f };
    },
    zoomTo: vi.fn((zoom: number, _ref: unknown, immediately: boolean) => {
      target.zoom = zoom; if (!animate || immediately) current.zoom = zoom; emit('zoom');
    }),
    panTo: vi.fn((point: { x: number; y: number }, immediately: boolean) => {
      target.x = point.x; target.y = point.y;
      if (!animate || immediately) { current.x = point.x; current.y = point.y; }
      emit('pan');
    }),
  };
  const viewer = { container, canvas, viewport,
    addHandler: (name: string, fn: (event?: any) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
    removeHandler: (name: string, fn: (event?: any) => void) => { handlers.get(name)?.delete(fn); },
  };
  overlay = new ReportMapHighlights(viewer);
  return { viewer, viewport, handlers, emit, initial, view: () => ({ ...current }),
    animate: () => { animate = true; },
    progress: (fraction: number) => {
      current = { x: current.x + (target.x - current.x) * fraction,
        y: current.y + (target.y - current.y) * fraction,
        zoom: current.zoom + (target.zoom - current.zoom) * fraction };
      emit('update-viewport');
    },
    settle: () => { current = { ...target }; emit('animation-finish'); },
    options: { panelBounds: { left: 500, top: 50, right: 900, bottom: 650 } },
  };
}

describe('delayed report preview camera lifecycle', () => {
  const distant = [{ worldX: -1000, worldY: -300 }, { worldX: 1000, worldY: 500 }];

  it('debounces fitting, retains the original view across row changes, and restores on leave', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options);
    vi.advanceTimersByTime(249); expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    const preview = fixture.view(); expect(preview.zoom).toBeLessThan(fixture.initial.zoom);
    overlay!.setTargets([]); vi.advanceTimersByTime(60);
    overlay!.setTargets([{ worldX: 5000, worldY: 200 }], fixture.options);
    vi.advanceTimersByTime(250); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(2);
    expect(fixture.view()).not.toEqual(preview);
    overlay!.setTargets([]); vi.advanceTimersByTime(119);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fixture.view()).toEqual(fixture.initial);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fit after a brief hover or an interaction during its delay', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(100);
    overlay!.setTargets([]); vi.advanceTimersByTime(300);
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    overlay!.setTargets(distant, fixture.options); fixture.emit('canvas-press'); vi.advanceTimersByTime(300);
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
  });

  it.each(['canvas-press', 'canvas-drag', 'canvas-scroll', 'canvas-key', 'canvas-pinch'])(
    'relinquishes camera ownership on %s and does not restore over the user view', event => {
      const fixture = cameraFixture();
      overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
      fixture.emit(event);
      fixture.viewport.panTo({ x: 120, y: 240 }, true);
      const chosen = fixture.view();
      overlay!.setTargets([]); vi.advanceTimersByTime(1000);
      expect(fixture.view()).toEqual(chosen);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('cancels return when explicit navigation starts, and can discard a preview before navigation', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    overlay!.setTargets([]);
    fixture.viewport.panTo({ x: 700, y: 200 }, true);
    vi.advanceTimersByTime(120); expect(fixture.view().x).toBe(700);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    const preview = fixture.view();
    overlay!.setTargets([], { restore: false }); vi.advanceTimersByTime(500);
    expect(fixture.view()).toEqual(preview);
  });

  it('does not take over an unfinished camera flight or a fully covered map', () => {
    const fixture = cameraFixture(); fixture.animate();
    fixture.viewport.panTo({ x: 700, y: 200 }, false);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.settle();
    overlay!.setTargets(distant, { panelBounds: { left: 0, top: 0, right: 1200, bottom: 900 } });
    vi.advanceTimersByTime(250); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it('freezes an unfinished preview on map input before the input moves the camera', () => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.emit('canvas-press'); fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
    expect(fixture.viewport.panTo).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0 }), true);
    overlay!.setTargets([]); vi.advanceTimersByTime(1000); expect(fixture.view()).toEqual(fixture.initial);
  });

  it('stops the previous preview flight if a new row already fits the rendered view', () => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    overlay!.setTargets([]); vi.advanceTimersByTime(50);
    overlay!.setTargets([{ worldX: -20, worldY: 0 }], fixture.options); vi.advanceTimersByTime(250);
    fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
    expect(fixture.viewport.panTo).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0 }), true);
    overlay!.setTargets([]); vi.advanceTimersByTime(120); fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
  });

  it('fits a new hover entered during its own return flight and still restores the original view', () => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250); fixture.settle();
    const preview = fixture.view();
    overlay!.setTargets([]); vi.advanceTimersByTime(120);
    overlay!.setTargets([{ worldX: 5000, worldY: 200 }], fixture.options);
    vi.advanceTimersByTime(250); fixture.settle();
    expect(fixture.view()).not.toEqual(fixture.initial);
    expect(fixture.view()).not.toEqual(preview);
    const projected = cameraMatrix(fixture.view());
    expect(projected.a * 5000 + projected.e).toBeCloseTo(200);
    expect(projected.d * 200 + projected.f).toBeCloseTo(300);
    overlay!.setTargets([]); vi.advanceTimersByTime(120); fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
  });

  it('restores after OSD completes the pan/zoom corrections following its resize event', async () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    const preview = fixture.view();
    fixture.emit('resize');
    fixture.viewport.zoomTo(preview.zoom, null, true);
    fixture.viewport.panTo(preview, true);
    expect(fixture.view()).toEqual(preview);
    await Promise.resolve();
    expect(fixture.view()).toEqual(fixture.initial);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued resize restoration on explicit navigation or destruction', async () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    fixture.emit('resize');
    overlay!.setTargets([], { restore: false });
    fixture.viewport.panTo({ x: 700, y: 200 }, true);
    await Promise.resolve();
    expect(fixture.view().x).toBe(700);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    fixture.emit('resize');
    overlay!.destroy(); overlay = undefined;
    const preview = fixture.view();
    await Promise.resolve();
    expect(fixture.view()).toEqual(preview);
  });

  it('drops return on map replacement and cleans up every timer, frame and listener', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    const preview = fixture.view();
    fixture.emit('close'); vi.advanceTimersByTime(1000); expect(fixture.view()).toEqual(preview);
    overlay!.setTargets(distant, fixture.options); expect(vi.getTimerCount()).toBe(1);
    overlay!.destroy(); overlay = undefined;
    expect(vi.getTimerCount()).toBe(0); expect(frames.size).toBe(0);
    expect([...fixture.handlers.values()].every(handlers => handlers.size === 0)).toBe(true);
    expect(fixture.viewer.container.querySelector('.report-map-highlights')).toBeNull();
  });
});

describe('expanded report context and active locations', () => {
  const distant = [{ worldX: -1000, worldY: -300 }, { worldX: 1000, worldY: 500 }];

  it.each(['pending fit', 'preview flight', 'pending return', 'return flight'])(
    'opening a list freezes a %s and abandons the old restore origin', phase => {
      const fixture = cameraFixture(); fixture.animate();
      overlay!.setTargets(distant, fixture.options);
      if (phase !== 'pending fit') {
        vi.advanceTimersByTime(250);
        if (phase === 'preview flight') fixture.progress(0.4);
        else {
          fixture.settle(); overlay!.setTargets([]);
          if (phase === 'return flight') { vi.advanceTimersByTime(120); fixture.progress(0.4); }
        }
      }
      const rendered = fixture.view();
      overlay!.setTargets(distant, { camera: 'keep', dimContext: true });
      expect(fixture.view()).toEqual(rendered);
      vi.advanceTimersByTime(2000); fixture.settle();
      expect(fixture.view()).toEqual(rendered);
      expect(vi.getTimerCount()).toBe(0);
      overlay!.setTargets([]); vi.advanceTimersByTime(2000); fixture.settle();
      expect(fixture.view()).toEqual(rendered);
      if (phase === 'pending fit') {
        expect(fixture.viewport.panTo).not.toHaveBeenCalled();
        expect(fixture.viewport.zoomTo).not.toHaveBeenCalled();
      }
    });

  it('keeps single green active rings distinct above context clusters without fading outlines or count labels', () => {
    const fixture = cameraFixture();
    const selected = [{ worldX: -0.5, worldY: 0.5, biome: 'desert' },
      { worldX: -0.25, worldY: 0.25, biome: 'desert' }];
    const targets = [...selected, { worldX: 0, worldY: 0, biome: 'coalmine', pw: 0 },
      { worldX: -20, worldY: 0, biome: 'coalmine', pw: 1 }, { worldX: -30, worldY: 0, biome: 'desert' }];
    overlay!.setTargets(targets, { camera: 'keep', dimContext: true, activeTargets: selected }); flush();
    const svg = fixture.viewer.container.querySelector('svg')!;
    const context = [...svg.querySelectorAll('[data-layer="context"]')];
    expect(context).toHaveLength(3);
    expect(context.every(group => !group.hasAttribute('opacity'))).toBe(true);
    for (const group of context) {
      expect(group.querySelector('circle[stroke-opacity]')?.getAttribute('stroke-opacity')).toBe('0.85');
      expect(group.querySelector('circle[stroke-width="5"]')?.hasAttribute('stroke-opacity')).toBe(false);
    }
    const primary = svg.querySelector('[data-primary="true"]')!;
    expect(primary.getAttribute('transform')).toBe('translate(400,300)');
    expect(primary.querySelector('text')?.textContent).toBe('3');
    expect(primary.querySelector('text')?.hasAttribute('opacity')).toBe(false);
    expect(primary.querySelector('circle[stroke-opacity]')?.getAttribute('r')).toBe('12');
    expect(primary.querySelector('circle[stroke-opacity]')?.getAttribute('stroke-width')).toBe('3');
    expect(svg.querySelector('[data-main-path="true"][data-primary="false"] circle[stroke-opacity]')?.getAttribute('r')).toBe('10');
    expect(svg.querySelector('[data-main-path="true"][data-primary="false"] circle[stroke-opacity]')?.getAttribute('stroke-width')).toBe('2.5');
    expect(svg.querySelector('[data-main-path="false"] circle[stroke-opacity]')?.getAttribute('r')).toBe('8');
    expect(svg.querySelector('[data-main-path="false"] circle[stroke-opacity]')?.getAttribute('stroke-width')).toBe('1.5');
    expect(new Set([...svg.querySelectorAll('[data-layer="context"] circle[stroke-opacity]')].map(circle => circle.getAttribute('stroke'))))
      .toEqual(new Set(['var(--report-marker-context, #94a3b8)']));
    const active = [...svg.querySelectorAll('[data-layer="active"]')];
    expect(active).toHaveLength(2);
    expect(active.map(group => group.getAttribute('transform'))).toEqual(['translate(396,304)', 'translate(398,302)']);
    for (const group of active) {
      expect(group.querySelectorAll('circle')).toHaveLength(2);
      expect(group.querySelectorAll('circle[stroke="var(--report-marker-selected, #6ee7b7)"]')).toHaveLength(1);
      expect(group.querySelector('circle[stroke-width="3"]')?.getAttribute('r')).toBe('12');
      expect(group.querySelector('circle[stroke-width="5"]')?.getAttribute('r')).toBe('12');
      expect(group.querySelector('text')).toBeNull();
      expect(group.hasAttribute('opacity')).toBe(false);
    }
    expect([...svg.lastElementChild!.children]).toEqual(active);
  });

  it('row traversal only changes the active accent, and manual pan preserves the full context', () => {
    const fixture = cameraFixture();
    const targets = [{ worldX: 0, worldY: 0 }, { worldX: -20, worldY: 0 }];
    const svg = fixture.viewer.container.querySelector('svg')!;
    for (const activeTargets of [[targets[0]], [], [targets[1]], []]) {
      overlay!.setTargets(targets, { camera: 'keep', dimContext: true, activeTargets });
      flush(); vi.advanceTimersByTime(1000);
      expect(svg.querySelectorAll('[data-layer="context"]')).toHaveLength(2);
      expect(svg.querySelectorAll('[data-layer="active"]')).toHaveLength(activeTargets.length);
      for (const circle of svg.querySelectorAll('[data-layer="context"] circle[stroke-opacity]')) {
        expect(circle.getAttribute('stroke-opacity')).toBe(activeTargets.length ? '0.85' : '1');
      }
    }
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    expect(fixture.viewport.zoomTo).not.toHaveBeenCalled();
    fixture.emit('canvas-drag'); fixture.viewport.panTo({ x: 2, y: 1 }, true);
    const chosen = fixture.view();
    fixture.emit('update-viewport'); flush();
    expect(svg.querySelectorAll('[data-layer="context"]')).toHaveLength(2);
    expect(svg.querySelector('[data-layer="context"][data-location="0:0"]')?.getAttribute('transform')).toBe('translate(384,292)');
    overlay!.setTargets(targets, { camera: 'keep', dimContext: true, activeTargets: [targets[1]] });
    flush(); vi.advanceTimersByTime(1000);
    expect(svg.querySelector('[data-layer="active"]')?.getAttribute('transform')).toBe('translate(224,292)');
    overlay!.setTargets([], { camera: 'keep' }); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(chosen);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(fixture.viewport.zoomTo).not.toHaveBeenCalled();
    expect(svg.querySelector('[data-layer]')).toBeNull();
  });

  it.each([{ camera: 'keep' as const }, { restore: false }])('clearing with %j cancels the flight without changing the rendered view', options => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250); fixture.progress(0.4);
    const rendered = fixture.view();
    overlay!.setTargets([], options); vi.advanceTimersByTime(1000); fixture.settle();
    expect(fixture.view()).toEqual(rendered);
    expect(fixture.viewer.container.querySelector('[data-layer]')).toBeNull();
  });

  it('opening a list cancels queued resize restoration', async () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    const preview = fixture.view();
    fixture.emit('resize');
    overlay!.setTargets(distant, { camera: 'keep' });
    await Promise.resolve(); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(preview);
    overlay!.clear(); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(preview);
  });
});

describe('committed report overview and Back camera', () => {
  const distant = [{ worldX: -1000, worldY: -300 }, { worldX: 1000, worldY: 500 }];

  it('starts a fresh category preview after a highlight-only card without requiring an empty clear', () => {
    const fixture = cameraFixture();
    overlay!.setTargets([{ worldX: 0, worldY: 0 }], { camera: 'keep' });
    overlay!.setTargets(distant, fixture.options);
    vi.advanceTimersByTime(249); expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(fixture.view().zoom).toBeLessThan(fixture.initial.zoom);
    overlay!.setTargets([]); vi.advanceTimersByTime(120);
    expect(fixture.view()).toEqual(fixture.initial);
  });

  it('waits for Back to finish before fitting a still-hovered category and returns to the saved view on leave', () => {
    const fixture = cameraFixture(); fixture.animate();
    fixture.viewport.panTo({ x: 300, y: 200 }, true);
    overlay!.restoreView(fixture.initial); fixture.progress(0.4);
    fixture.viewport.panTo.mockClear(); fixture.viewport.zoomTo.mockClear();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(1000);
    expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    fixture.settle();
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(fixture.view()).toEqual(fixture.initial);
    fixture.settle();
    expect(fixture.view().zoom).toBeLessThan(fixture.initial.zoom);
    expect(overlay!.getReturnView()).toEqual(fixture.initial);
    overlay!.setTargets([]); vi.advanceTimersByTime(120); fixture.settle();
    expect(fixture.view()).toEqual(fixture.initial);
  });

  it.each(['keep', 'clear', 'input', 'overview', 'restore'] as const)('cancels a deferred category preview on %s', action => {
    const fixture = cameraFixture(); fixture.animate();
    fixture.viewport.panTo({ x: 300, y: 200 }, true);
    overlay!.restoreView(fixture.initial);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    if (action === 'keep') overlay!.setTargets(distant, { camera: 'keep' });
    else if (action === 'clear') overlay!.setTargets([]);
    else if (action === 'input') fixture.emit('canvas-press');
    else if (action === 'overview') overlay!.setTargets([{ worldX: 5000, worldY: 0 }], { ...fixture.options, camera: 'overview' });
    else overlay!.restoreView({ x: 600, y: 700, zoom: 0.003 });
    fixture.viewport.panTo.mockClear(); fixture.viewport.zoomTo.mockClear();
    fixture.settle(); vi.advanceTimersByTime(1000);
    expect(fixture.viewport.panTo).not.toHaveBeenCalled(); expect(fixture.viewport.zoomTo).not.toHaveBeenCalled();
  });

  it('gives a newer category its own debounce instead of executing an older deferred fit', () => {
    const fixture = cameraFixture(); fixture.animate();
    fixture.viewport.panTo({ x: 300, y: 200 }, true);
    overlay!.restoreView(fixture.initial);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    overlay!.setTargets([{ worldX: 5000, worldY: 0 }], fixture.options);
    fixture.viewport.panTo.mockClear(); fixture.settle();
    vi.advanceTimersByTime(249); expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.settle();
    const matrix = cameraMatrix(fixture.view());
    expect(matrix.a * 5000 + matrix.e).toBeCloseTo(200);
    expect(fixture.view().zoom).toBe(fixture.initial.zoom);
  });

  it('does nothing when bounds already fit at half zoom, without shrinking the view again', () => {
    const fixture = cameraFixture();
    fixture.viewport.zoomTo(0.005, null, true); fixture.viewport.panTo({ x: 25, y: 0 }, true);
    fixture.viewport.zoomTo.mockClear(); fixture.viewport.panTo.mockClear();
    const existing = fixture.view();
    overlay!.setTargets([{ worldX: -40, worldY: -20 }, { worldX: 10, worldY: 20 }], { ...fixture.options, camera: 'overview' });
    vi.advanceTimersByTime(1000);
    expect(fixture.viewport.zoomTo).not.toHaveBeenCalled(); expect(fixture.viewport.panTo).not.toHaveBeenCalled();
    expect(fixture.view()).toEqual(existing);
  });

  it('commits one fit that finishes through row hover/leave updates without restoring on list exit', () => {
    const fixture = cameraFixture(); fixture.animate();
    const fitted = fitReportHighlights(distant, cameraMatrix(fixture.initial), fixture.initial,
      { left: 0, top: 0, right: 400, bottom: 600 })!;
    overlay!.setTargets(distant, { ...fixture.options, camera: 'overview' });
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    fixture.progress(0.4);
    overlay!.setTargets(distant, { camera: 'keep', dimContext: true, activeTargets: [distant[0]] });
    overlay!.setTargets(distant, { camera: 'keep', dimContext: true, activeTargets: [] });
    vi.advanceTimersByTime(1000); fixture.settle();
    expect(fixture.view()).toEqual(fitted);
    expect(fixture.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(fixture.viewport.zoomTo).toHaveBeenCalledTimes(1);
    expect(overlay!.getReturnView()).toEqual(fitted);
    overlay!.setTargets([], { restore: false }); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(fitted);
  });

  it('pans a single offscreen target at the existing zoom, and never zooms in for a small group', () => {
    const fixture = cameraFixture();
    overlay!.setTargets([{ worldX: 1000, worldY: 200 }], { ...fixture.options, camera: 'overview' });
    expect(fixture.view().zoom).toBe(fixture.initial.zoom);
    overlay!.setTargets([{ worldX: 2000, worldY: 100 }, { worldX: 2001, worldY: 101 }], { ...fixture.options, camera: 'overview' });
    expect(fixture.view().zoom).toBe(fixture.initial.zoom);
  });

  it('captures the pre-hover view for history, including during a return, and restores it after overview', () => {
    const fixture = cameraFixture(); fixture.animate();
    expect(overlay!.getReturnView()).toEqual(fixture.initial);
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250); fixture.progress(0.5);
    const saved = overlay!.getReturnView()!;
    expect(saved).toEqual(fixture.initial); expect(fixture.view()).not.toEqual(saved);
    overlay!.setTargets([]); vi.advanceTimersByTime(120); fixture.progress(0.3);
    expect(overlay!.getReturnView()).toEqual(saved);
    overlay!.setTargets(distant, { camera: 'keep' });
    overlay!.setTargets(distant, { ...fixture.options, camera: 'overview' }); fixture.settle();
    expect(fixture.view()).not.toEqual(saved);
    overlay!.restoreView(saved); fixture.progress(0.4);
    overlay!.setTargets(distant, { camera: 'keep', activeTargets: [distant[1]] });
    fixture.settle(); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(saved);
    expect(overlay!.getReturnView()).toEqual(saved);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Back replaces a pending temporary return and invalid saved views leave the camera alone', () => {
    const fixture = cameraFixture();
    overlay!.setTargets(distant, fixture.options); vi.advanceTimersByTime(250);
    overlay!.setTargets([]);
    const back = { x: 600, y: 700, zoom: 0.003 };
    overlay!.restoreView(back); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(back);
    fixture.viewport.panTo.mockClear(); fixture.viewport.zoomTo.mockClear();
    overlay!.restoreView({ ...back, x: NaN }); overlay!.restoreView({ ...back, zoom: 0 });
    expect(fixture.viewport.panTo).not.toHaveBeenCalled(); expect(fixture.viewport.zoomTo).not.toHaveBeenCalled();
  });

  it('manual map input can still stop a committed overview and leaves the selected view alone', () => {
    const fixture = cameraFixture(); fixture.animate();
    overlay!.setTargets(distant, { ...fixture.options, camera: 'overview' }); fixture.progress(0.4);
    const chosen = fixture.view();
    fixture.emit('canvas-press'); fixture.settle();
    overlay!.setTargets(distant, { camera: 'keep' }); vi.advanceTimersByTime(1000);
    expect(fixture.view()).toEqual(chosen);
    expect(overlay!.getReturnView()).toEqual(chosen);
  });
});
