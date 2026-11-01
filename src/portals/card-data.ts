import { collectPortals, type PortalSeed } from './placements';
import type { MarkerItem } from '../telescope/poi-spatial-index';

const portalItems = new Set([
  'portal', 'buried_eye_teleporter', 'meditation_cube', 'hourglass',
  'hourglass_chamber', 'buried_eye', 'buried_eye_chamber', 'meditation_chamber',
]);
const portalPlaces = new Set([
  'Meditation Cube Room', 'Meditation Chamber', 'Eye Spell Room', 'Hourglass Chamber',
  'Buried Eye', 'Buried Eye Room', 'Buried Eye Chamber',
  'Tower Portal Diamond', 'Hourglass', 'Desert Skull, Eye',
]);

/** Use the actual scene/POI identifiers as well as the renderer's effect names. */
export function usesDustAnimation(poi: {
  type?: string; item?: string; entity?: string; effect?: string; name?: string;
}): boolean {
  if (poi.type === 'spell' || poi.item === 'spell') return false;
  if (poi.type === 'eye_room' || portalItems.has(poi.item ?? '') || portalPlaces.has(poi.name ?? '')) return true;
  if (['holy_mountain', 'meditation', 'eye_room'].includes(poi.effect ?? '')) return true;
  return [poi.item, poi.entity, poi.effect].some(value => {
    const id = value?.split('/').at(-1)?.replace(/\.xml$/, '') ?? '';
    return /^(?:teleport|mystery_teleport)(?:_|$)/.test(id);
  });
}

/** Invisible interaction targets, derived from the same placements as Dust.
 * They belong only to the marker index, never the seed's loot/search/report data.
 * Existing room markers retain their IDs, titles and more specific Wiki links.
 */
export function createPortalCardMarkers(seed: PortalSeed, existing: readonly MarkerItem[]): MarkerItem[] {
  const known = existing.filter(marker => usesDustAnimation(marker.poi));
  return collectPortals(seed).flatMap(portal => {
    if (known.some(marker => Math.hypot(marker.osdX - portal.x, marker.osdY - portal.y) <= 8)) return [];
    const pw = seed.worldSize > 0 ? Math.floor((portal.x / 512 + seed.worldCenter) / seed.worldSize) : 0;
    return [{
      poi: {
        id: `d-portal_${portal.entity}_${portal.x}_${portal.y}`,
        type: 'item', item: 'portal', nameKey: 'teleport_generic', name: 'Portal',
        wiki: 'https://noita.wiki.gg/wiki/Portal',
        x: portal.x, y: portal.y, pw, clickOnly: true,
        portalEntity: portal.entity,
      },
      pw, spriteKey: '', osdX: portal.x, osdY: portal.y, w: 64, h: 64,
    }];
  });
}
