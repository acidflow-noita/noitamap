import Flatbush from 'flatbush';
import { describe, expect, it } from 'vitest';
import { supportsCapturedLiquidMask } from '../src/liquids/capture-identity';
import { liquidMarkerExclusions } from '../src/liquids/marker-exclusions';
import { getTileData } from '../src/data_sources/tile_data';
import type { MarkerData } from '../src/telescope/poi-spatial-index';

describe('liquid map inputs', () => {
  it('accepts the current capture and rejects other map geometry or an unreviewed seed', () => {
    expect(supportsCapturedLiquidMask()).toBe(true);
    expect(supportsCapturedLiquidMask(getTileData('regular-main-branch'))).toBe(false);
    const current = getTileData('dynamic-main-branch');
    expect(supportsCapturedLiquidMask(current.slice(0, 1))).toBe(false);
    expect(supportsCapturedLiquidMask(current.map(item => ({ ...item, url: item.url.replace('78633191', '123456') })))).toBe(false);
    expect(supportsCapturedLiquidMask(current.map(item => ({ ...item, url: item.url + '?v=new-cache' })))).toBe(true);
  });
  it('protects sprite hotspots, compound images and rotated wands, skipping click-only landmarks', () => {
    const items = [
      { osdX: -10, osdY: 20, w: 8, h: 20, spriteKey: ['card', 'extra'], poi: {}, pw: 0 },
      { osdX: 50, osdY: 60, w: 8, h: 20, spriteKey: 'wand', poi: { isTaikasauva: true }, pw: 0 },
      { osdX: 0, osdY: 0, w: 12, h: 12, spriteKey: 'missing', poi: {}, pw: 0 },
    ];
    const index = new Flatbush(3); for (const item of items) index.add(item.osdX + 100, item.osdY + 100, item.osdX + 101, item.osdY + 101); index.finish();
    const data = { index, items, originX: -100, originY: -100,
      atlas: { card: { x: 0, y: 0, w: 8, h: 20, ox: 0, oy: 19 }, extra: { x: 8, y: 0, w: 12, h: 24 },
        wand: { x: 20, y: 0, w: 8, h: 20 } } } as unknown as MarkerData;
    expect(liquidMarkerExclusions(data, { x: -50, y: -50, width: 200, height: 200 })).toEqual([
      { x: -12, y: -1, width: 12, height: 24 }, { x: -12, y: -1, width: 16, height: 28 },
      { x: 38, y: 54, width: 24, height: 12 },
    ]);
    expect(liquidMarkerExclusions(data, { x: 1000, y: 1000, width: 256, height: 256 })).toEqual([]);
  });
});
