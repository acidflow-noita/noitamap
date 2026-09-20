import { describe, expect, it } from 'vitest';
import { portalFrameBounds } from '../src/portals/geometry';
import type { PortalPlacement } from '../src/portals/placements';
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
