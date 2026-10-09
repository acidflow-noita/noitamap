// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { biomeBoundaries } from '../src/drawing/biome-boundaries';
import { biomePathBounds } from '../src/data_sources/biome-path-bounds';
import { clearCreatureSpawnBiomeFocus, fitCreatureSpawnBiomeBounds, focusCreatureSpawnBiomes,
  frameCreatureSpawnBiomes, resolveCreatureSpawnBiomes } from '../src/data_sources/creature-spawn-biomes';
import { readCameraMatrix, type CameraMatrix } from '../src/portals/geometry';
import { uncoveredReportMapRect } from '../src/report-map-highlights';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('creature spawn region resolution', () => {
  it('maps the requested Pyramid, Temple of the Art and Tower to the existing main-world overlay', () => {
    const result = resolveCreatureSpawnBiomes('Pyramid, Temple of the Art, The Tower', 'dynamic-main-branch');
    expect(result.supported).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.matched).toEqual(expect.arrayContaining(['pyramid', 'pyramid_hallway', 'pyramid_right', 'crypt', 'solid_wall_tower_1', 'solid_wall_tower_10']));
    expect(result.matched).not.toContain('solid_wall_tower'); // enclosing EDR spans the whole map
    expect(result.bounds).toEqual({ x: -4608, y: -1024, width: 16384, height: 13824 });
  });

  it('preserves every unresolved original name alongside a valid match', () => {
    const result = resolveCreatureSpawnBiomes('Mines, Parallel Worlds, Treasure Chest, Unknown Place', 'regular-main-branch');
    expect(result.matched).toEqual(['coalmine']);
    expect(result.missing).toEqual(['Parallel Worlds', 'Treasure Chest', 'Unknown Place']);
  });

  it('uses wiki identities independently of language, including escaped apostrophes and display links', () => {
    const result = resolveCreatureSpawnBiomes('[[Pyramid]], [[Wizards Den|Wizards&#039; Den]], Overgrown Cavern', 'regular-beta');
    expect(result.missing).toEqual([]);
    expect(result.matched).toEqual(expect.arrayContaining(['pyramid', 'wizardcave', 'fungiforest']));
  });

  it('does not confuse the upper Lava Lake with the lower Lava biome or the two Works', () => {
    expect(resolveCreatureSpawnBiomes('Lava Lake', 'dynamic-main-branch').matched).toEqual(['lavalake']);
    expect(resolveCreatureSpawnBiomes('The Work (Sky)', 'dynamic-main-branch').matched).toEqual(['the_sky']);
    expect(resolveCreatureSpawnBiomes('The Work (Hell)', 'dynamic-main-branch').matched).toEqual(['the_end']);
  });

  it.each([['newgame-plus-main-branch', 0], ['dynamic-main-branch', 1], ['purgatory-main-branch', 0]])(
    'never offers authored NG0 geometry for unsupported map %s / NG+ %i', (map, ngPlus) => {
      expect(resolveCreatureSpawnBiomes('Pyramid', map, ngPlus)).toEqual({ supported: false, matched: [], missing: ['Pyramid'], bounds: null });
    });

  it('shares valid M/L/Z path bounds with every rendered boundary, including disconnected polygons', () => {
    for (const boundary of biomeBoundaries) expect(biomePathBounds(boundary.path)).not.toBeNull();
    expect(biomePathBounds('M -10 -20 L 20 -20 L 20 30 Z M 100 100 L 200 100 L 200 300 Z'))
      .toEqual({ x: -10, y: -20, width: 210, height: 320 });
    expect(biomePathBounds('')).toBeNull();
  });
});

describe('temporary spawn overlay focus', () => {
  function root() {
    document.body.innerHTML = '<div id="osContainer"><div class="biome-overlay-path" data-biome-name="pyramid"><svg><path style="color:red"/></svg></div><div class="biome-overlay-path" data-biome-name="coalmine"><svg><path style="color:blue"/></svg></div></div>';
    return document.getElementById('osContainer')!;
  }

  it('changes classes only and completely restores the original overlay when cleared', () => {
    const container = root(), original = container.outerHTML;
    expect(focusCreatureSpawnBiomes(resolveCreatureSpawnBiomes('Pyramid', 'dynamic-main-branch'), container)).toBe(true);
    expect(container.classList.contains('biome-spawn-focus')).toBe(true);
    expect(container.querySelector('[data-biome-name="pyramid"]')?.classList.contains('biome-spawn-match')).toBe(true);
    expect(container.querySelector('[data-biome-name="coalmine"]')?.classList.contains('biome-spawn-muted')).toBe(true);
    clearCreatureSpawnBiomeFocus(container);
    expect(container.outerHTML.replace(' class=""', '')).toBe(original);
  });

  it('replaces the previous selection and rejects unavailable geometry without dimming everything', () => {
    const container = root();
    focusCreatureSpawnBiomes(resolveCreatureSpawnBiomes('Pyramid', 'dynamic-main-branch'), container);
    focusCreatureSpawnBiomes(resolveCreatureSpawnBiomes('Mines', 'dynamic-main-branch'), container);
    expect(container.querySelector('[data-biome-name="pyramid"]')?.classList.contains('biome-spawn-muted')).toBe(true);
    expect(container.querySelectorAll('.biome-spawn-match')).toHaveLength(1);
    const prior = container.outerHTML;
    expect(focusCreatureSpawnBiomes(resolveCreatureSpawnBiomes('The Vault', 'dynamic-main-branch'), container)).toBe(false);
    expect(container.outerHTML).toBe(prior);
  });
});

describe('explicit spawn camera fit', () => {
  const bounds = { x: -800, y: 200, width: 2400, height: 1700 };
  const canvas = { left: 80, top: 40, right: 1280, bottom: 840 };
  const view = { x: -4000, y: 9000, zoom: 0.00002 };
  function matrix(angle: number, flip: boolean, scale: number): CameraMatrix {
    const radians = angle * Math.PI / 180, a = Math.cos(radians) * scale, b = Math.sin(radians) * scale;
    return readCameraMatrix((x, y) => ({ x: 600 + a * (x - view.x) - b * (y - view.y),
      y: 400 + b * (x - view.x) + a * (y - view.y) }), 1200, flip);
  }

  it.each([[0, false], [45, false], [90, true], [213, true]] as const)(
    'fits all corners under rotation %i / flip %s while excluding desktop or mobile report', (angle, flip) => {
      for (const panel of [{ left: 880, top: 40, right: 1280, bottom: 840 }, { left: 80, top: 500, right: 1280, bottom: 840 }]) {
        for (const scale of [0.01, 1]) { // Must zoom in as well as out.
          const m = matrix(angle, flip, scale), rect = uncoveredReportMapRect(1200, 800, panel, canvas)!;
          const fitted = fitCreatureSpawnBiomeBounds(bounds, m, view, rect)!;
          const ratio = fitted.zoom / view.zoom;
          expect(scale === .01 ? ratio > 1 : ratio < 1).toBe(true);
          const centerX = m.a * view.x + m.c * view.y + m.e, centerY = m.b * view.x + m.d * view.y + m.f;
          for (const x of [bounds.x, bounds.x + bounds.width]) for (const y of [bounds.y, bounds.y + bounds.height]) {
            const px = centerX + ratio * (m.a * (x - fitted.x) + m.c * (y - fitted.y));
            const py = centerY + ratio * (m.b * (x - fitted.x) + m.d * (y - fitted.y));
            expect(px).toBeGreaterThanOrEqual(rect.left + 24 - 1e-6);
            expect(px).toBeLessThanOrEqual(rect.right - 24 + 1e-6);
            expect(py).toBeGreaterThanOrEqual(rect.top + 24 - 1e-6);
            expect(py).toBeLessThanOrEqual(rect.bottom - 24 + 1e-6);
          }
        }
      }
    });

  it('rejects invalid geometry and respects the viewport zoom limits', () => {
    const m = matrix(0, false, .1), rect = { left: 0, top: 0, right: 1200, bottom: 800 };
    expect(fitCreatureSpawnBiomeBounds({ ...bounds, width: NaN }, m, view, rect)).toBeNull();
    expect(fitCreatureSpawnBiomeBounds(bounds, { ...m, a: 0, b: 0, c: 0, d: 0 }, view, rect)).toBeNull();
    expect(fitCreatureSpawnBiomeBounds(bounds, m, view, rect, view.zoom, view.zoom)?.zoom).toBe(view.zoom);
  });

  it('executes one explicit fit using the rendered camera and reduced-motion preference', () => {
    vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const m = matrix(45, true, .1);
    const viewport = {
      getCenter: () => view, getZoom: () => view.zoom, getFlip: () => false,
      pixelFromPoint: (p: { x: number; y: number }) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }),
      zoomTo: vi.fn(), panTo: vi.fn(),
    };
    expect(frameCreatureSpawnBiomes({ canvas: { clientWidth: 1200, clientHeight: 800, getBoundingClientRect: () => canvas }, viewport }, bounds)).toBe(true);
    expect(viewport.zoomTo).toHaveBeenCalledOnce();
    expect(viewport.panTo).toHaveBeenCalledOnce();
    expect(viewport.panTo.mock.calls[0][1]).toBe(true);
  });
});
