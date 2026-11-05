import { describe, expect, it } from 'vitest';
import { createPortalCardMarkers, usesDustAnimation } from '../src/portals/card-data';
import { particleIcon } from '../src/portals/icons';
import type { PortalSeed } from '../src/portals/placements';
import type { MarkerItem } from '../src/telescope/poi-spatial-index';
import english from '../src/locales/en/translation.json';
import russian from '../src/locales/ru/translation.json';

const seed = (extra: Partial<PortalSeed> = {}): PortalSeed => ({
  seed: 548901523, worldSize: 70, worldCenter: 35, parallelWorlds: [-1, 0, 1], ...extra,
});
describe('portal cards from rendered placements', () => {
  it('credits the existing Sun quest landmarks while leaving Sun spells unrelated', () => {
    for (const name of ['Moon', 'Dark Moon', 'Sun/Moon', 'Dark Sun/Dark Moon'])
      expect(usesDustAnimation({ type: 'pillar_place', name })).toBe(true);
    expect(usesDustAnimation({ type: 'spell', name: 'Sun/Moon', effect: 'sun' })).toBe(false);
    expect(usesDustAnimation({ type: 'item', entity: 'data/entities/items/pickup/sun/newsun_dark.xml' })).toBe(true);
  });
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
      expect(particleIcon(marker.poi)).toContain('/holy_mountain.png');
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
    expect(particleIcon(eye.poi)).toContain('/eye_room.png');
    expect(createPortalCardMarkers(input, [eye])).toEqual([]);
    expect(eye).toEqual(before);
  });

  it('uses the matching Dust portraits for portal shapes and Sun unlock states without changing loot icons', () => {
    const portal = (entity: string) => particleIcon({ type: 'item', item: 'portal', portalEntity: entity });
    expect(portal('teleport_meditation_cube_return')).toContain('/meditation.png');
    expect(portal('teleport_hourglass_return')).toContain('/eye_room.png');
    expect(portal('teleport_ending')).toContain('/red_portal.png');
    expect(portal('mystery_teleport')).toContain('/red_portal.png');
    expect(particleIcon({ type: 'pillar_place', name: 'Meditation Chamber' })).toContain('/meditation.png');
    expect(particleIcon({ type: 'pillar_place', name: 'Eye Spell Room' })).toContain('/eye_room.png');
    expect(particleIcon({ type: 'pillar_place', name: 'Sun/Moon' }, [])).toContain('/moon.png');
    expect(particleIcon({ type: 'pillar_place', name: 'Sun/Moon' }, ['sun'])).toContain('/sun.png');
    expect(particleIcon({ type: 'pillar_place', name: 'Dark Sun/Dark Moon' }, ['dark_sun'])).toContain('/dark_sun.png');
    expect(particleIcon({ type: 'spell', item: 'SUN' })).toBeNull();
    expect(particleIcon({ type: 'item', item: 'spell', effect: 'sun' })).toBeNull();
    expect(particleIcon({ type: 'item', item: 'potion' })).toBeNull();
    expect(particleIcon({ type: 'item', item: 'paha_silma' })).toBeNull();
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
