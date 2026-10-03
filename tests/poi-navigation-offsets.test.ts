import { describe, expect, it } from 'vitest';
import { poiNavigationOffsets } from '../src/telescope/poi-navigation-offsets';

describe('POI navigation uses the report’s uncovered map rectangle', () => {
  const canvas = { left: 100, top: 50, right: 1100, bottom: 850 };
  it('centers the destination left of a right sidebar', () => {
    expect(poiNavigationOffsets(1000, 800, { left: 700, top: 50, right: 1100, bottom: 850 }, canvas))
      .toEqual({ offsetXPx: 200, offsetYPx: 0 });
  });
  it('centers above a bottom sheet even when the caller explicitly passes zero sidebar width', () => {
    expect(poiNavigationOffsets(1000, 800, { left: 100, top: 530, right: 1100, bottom: 850 }, canvas, 0))
      .toEqual({ offsetXPx: 0, offsetYPx: 160 });
  });
  it('supports signed offsets for top and left panels', () => {
    expect(poiNavigationOffsets(1000, 800, { left: 100, top: 50, right: 400, bottom: 850 }, canvas))
      .toEqual({ offsetXPx: -150, offsetYPx: 0 });
    expect(poiNavigationOffsets(1000, 800, { left: 100, top: 50, right: 1100, bottom: 250 }, canvas))
      .toEqual({ offsetXPx: 0, offsetYPx: -100 });
  });
  it('reuses the geometry’s scaling when client and canvas dimensions differ', () => {
    expect(poiNavigationOffsets(500, 400, { left: 100, top: 530, right: 1100, bottom: 850 }, canvas))
      .toEqual({ offsetXPx: 0, offsetYPx: 80 });
  });
  it('does not shift for a panel outside the canvas, and retains the legacy width only without a measurable panel', () => {
    expect(poiNavigationOffsets(1000, 800, { left: 1200, top: 50, right: 1600, bottom: 850 }, canvas, 400))
      .toEqual({ offsetXPx: 0, offsetYPx: 0 });
    expect(poiNavigationOffsets(1000, 800, undefined, canvas, 400))
      .toEqual({ offsetXPx: 200, offsetYPx: 0 });
    expect(poiNavigationOffsets(1000, 800)).toEqual({ offsetXPx: 0, offsetYPx: 0 });
  });
});
