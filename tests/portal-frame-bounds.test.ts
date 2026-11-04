import { describe, expect, it } from 'vitest';
import { portalFrameBounds, portalZoomActive, visiblePortals } from '../src/portals/geometry';
import type { PortalPlacement } from '../src/portals/placements';
import { zoomFromLogZoom } from '../src/data_sources/url';
const portal = (x: number, y: number) => ({ x, y } as PortalPlacement);
describe('GPU bitmap crop bounds', () => {
  it('unions full render windows, clips at viewport edges and keeps a 1px blank frame', () => {
    const m = { a: 1, b: 0, c: 0, d: 1, e: 400, f: 300 };
    expect(portalFrameBounds([portal(0, 0)], m, 1920, 1080)).toEqual({ x: 160, y: 140, width: 480, height: 320 });
    expect(portalFrameBounds([portal(-300, 0), portal(400, 0)], m, 1000, 600)).toEqual({ x: 0, y: 140, width: 1000, height: 320 });
    expect(portalFrameBounds([], m, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it('includes all corners after rotation and horizontal flip', () => {
    for (const m of [{ a: 0, b: 2, c: -2, d: 0, e: 500, f: 500 },
      { a: -1, b: 0, c: 0, d: 1, e: 500, f: 500 }]) {
      const bounds = portalFrameBounds([portal(0, 0)], m, 2000, 2000);
      for (const x of [-240, 240]) for (const y of [-160, 160]) {
        const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
        expect(px).toBeGreaterThanOrEqual(bounds.x); expect(px).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(py).toBeGreaterThanOrEqual(bounds.y); expect(py).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
    }
  });
});

 it('enumerates visible geometry independently of the presenter animation gate', () => {
   const portals = ['eye_room', 'meditation'].map(effect => ({ x: 0, y: 0, effect } as PortalPlacement));
   for (const scale of [.1, .01, .001, .0001]) {
     const m = { a: scale, b: 0, c: 0, d: scale, e: 400, f: 300 };
     expect(visiblePortals(portals, m, 800, 600)).toEqual(portals);
     expect(visiblePortals(portals, m, 800, 600, 1.5).length).toBe(scale * 160 >= 1.5 ? 2 : 0);
     expect(visiblePortals(portals, { ...m, e: -1000 }, 800, 600)).toEqual([]);
   }
 });

it('uses consistent 18px/12px animation thresholds, including rotation, flips and explicit comparison overrides', () => {
  const matrix = (pixels: number) => ({ a: pixels / 160, b: 0, c: 0, d: pixels / 160, e: 0, f: 0 });
  expect(portalZoomActive(matrix(17), false)).toBe(false);
  expect(portalZoomActive(matrix(18), false)).toBe(true);
  expect(portalZoomActive(matrix(12), true)).toBe(true);
  expect(portalZoomActive(matrix(11), true)).toBe(false);
  expect(portalZoomActive({ ...matrix(20), a: 0, b: -.125, c: -.125, d: 0 }, false)).toBe(true);
  expect(portalZoomActive(matrix(.1), false, 0, 0)).toBe(true);
  expect(portalZoomActive(matrix(0), true, 0, 0)).toBe(false);
  expect(portalZoomActive(matrix(NaN), true)).toBe(false);
});

it.each([1280, 1920, 3440])('cuts off at URL zoom 1334 independently of a %ipx viewport width', width => {
  const active = (z: number, running: boolean, override?: number) => {
    const zoom = zoomFromLogZoom(z), scale = zoom * width;
    return portalZoomActive({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }, running,
      override, override === 0 ? 0 : undefined, zoom);
  };
  expect(active(1333, true)).toBe(true);
  expect(active(1334, true)).toBe(false);
  expect(active(1400, true)).toBe(false);
  expect(active(1334, false)).toBe(false);
  expect(active(1295, false)).toBe(false);
  expect(active(1294, false)).toBe(true);
  expect(active(1500, false, 0)).toBe(true);
});
