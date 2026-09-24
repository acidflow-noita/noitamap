import Flatbush from 'flatbush';
import type { MarkerData } from './poi-spatial-index';
import { getMimicEntityId, MIMIC_SPRITES_VERSION } from './poi-mimics';

/** Old decoration bakes omitted these sprites completely. Existing heart and
 * potion disguises stay in their pixels; overlaying them would draw twice. */
export function legacyMimicMarkerData(data: MarkerData, versions?: Record<number, number>): MarkerData | null {
  const items = data.items.filter(({ poi, pw }) => {
    if (Number.isSafeInteger(versions?.[pw]) && versions![pw] >= MIMIC_SPRITES_VERSION) return false;
    if (poi.type === 'item') return ['mimic', 'chest_leggy', 'refresh_mimic'].includes(String(poi.item));
    // The corresponding illusion entity keys were also absent in the old atlas.
    if (poi.type === 'entity') return ['dark_alchemist', 'shaman_wind'].includes(getMimicEntityId(poi) ?? '');
    return false;
  });
  if (!items.length) return null;
  // Retain the existing layer coordinates, but index only the few missing
  // sprites so the tile source does no work for already-baked map contents.
  const index = new Flatbush(items.length);
  for (const item of items) index.add(
    item.osdX - item.w / 2 - data.originX, item.osdY - item.h / 2 - data.originY,
    item.osdX + item.w / 2 - data.originX, item.osdY + item.h / 2 - data.originY,
  );
  index.finish();
  return { ...data, items, index };
}
