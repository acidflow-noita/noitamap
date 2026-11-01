import { describe, expect, it } from 'vitest';
import { createPortalCardMarkers, usesDustAnimation } from '../src/portals/card-data';
import type { PortalSeed } from '../src/portals/placements';
import type { MarkerItem } from '../src/telescope/poi-spatial-index';
import english from '../src/locales/en/translation.json';
import russian from '../src/locales/ru/translation.json';

const seed = (extra: Partial<PortalSeed> = {}): PortalSeed => ({
  seed: 548901523, worldSize: 70, worldCenter: 35, parallelWorlds: [-1, 0, 1], ...extra,
});
describe('portal cards from rendered placements', () => {
  it('adds invisible Holy Mountain targets in each world without adding loot to the generation', () => {
    const input = seed({ poisByPW: { '-1,0': [], '0,0': [], '1,0': [] },
      pixelScenesByPW: Object.fromEntries([-1, 0, 1].map(pw => [`${pw},0`, [
        { key: 'temple/altar_top', x: pw * 35840, y: 984 },
      ]])),
    });
    const before = structuredClone(input), markers = createPortalCardMarkers(input, []);
    expect(markers).toHaveLength(3);
    expect(markers.map(marker => marker.pw)).toEqual([-1, 0, 1]);
    expect(new Set(markers.map(marker => marker.poi.id)).size).toBe(3);
    for (const marker of markers) {
      expect(marker).toMatchObject({ spriteKey: '', osdY: 1070, w: 64, h: 64,
        poi: { item: 'portal', clickOnly: true, nameKey: 'teleport_generic', wiki: 'https://noita.wiki.gg/wiki/Portal' },
      });
      expect(usesDustAnimation(marker.poi)).toBe(true);
    }
    expect(input).toEqual(before);
    expect(english.gameContent.ui.teleport_generic).toBe('Portal');
    expect(russian.gameContent.ui.teleport_generic).toBe('Портал');
  });

  it('credits the reported Eye Room card and preserves its deep link instead of covering it with another target', () => {
    const eye: MarkerItem = { poi: {
      id: 'd-pw_0_0_item_-3840_5376_12169', type: 'item', item: 'hourglass_chamber',
      name: 'Hourglass Chamber', x: -3840, y: 5376, clickOnly: true,
      wiki: 'https://noita.wiki.gg/wiki/The_Hourglass_Chamber',
    }, pw: 0, spriteKey: '', osdX: -3840, osdY: 5376, w: 64, h: 64 };
    const before = structuredClone(eye);
    const input = seed({ pixelScenesByPW: { '0,0': [
      { key: 'snowcastle/hourglass_chamber', x: -4096, y: 5120 },
    ] } });
    expect(usesDustAnimation(eye.poi)).toBe(true);
    expect(createPortalCardMarkers(input, [eye])).toEqual([]);
    expect(eye).toEqual(before);
  });

  it('creates targets from old baked biome metadata when scenes were omitted', () => {
    const pixels = new Uint32Array(70 * 48);
    pixels[16 * 70 + 35] = 0x93cb4c;
    expect(createPortalCardMarkers(seed({ biomeData: { pixels } }), []).map(marker => marker.pw))
      .toEqual([-1, 0, 1]);
  });

  it('does not credit teleport spells or unrelated pickups, or let them suppress a portal target', () => {
    expect(usesDustAnimation({ type: 'spell', item: 'teleport_projectile' })).toBe(false);
    expect(usesDustAnimation({ type: 'item', item: 'spell', name: 'Portal' })).toBe(false);
    expect(usesDustAnimation({ type: 'item', item: 'potion' })).toBe(false);
    const input = seed({ pixelScenesByPW: { '0,0': [{ key: 'temple/altar_top', x: 0, y: 984 }] } });
    const potion: MarkerItem = { poi: { type: 'item', item: 'potion', x: 264, y: 1070 },
      osdX: 264, osdY: 1070, pw: 0, spriteKey: 'item:potion', w: 16, h: 16 };
    expect(createPortalCardMarkers(input, [potion])).toHaveLength(1);
  });
});
