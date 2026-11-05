import type { MarkerData } from '../telescope/poi-spatial-index';
import type { MaskBounds } from './mask-index';

/** The frozen raster includes sprites on both baked and live maps. Exclude
 * their actual atlas footprints so refraction never moves a POI's icon. */
export function liquidMarkerExclusions(data: MarkerData | null | undefined, bounds: MaskBounds): MaskBounds[] {
  if (!data) return [];
  const out: MaskBounds[] = [];
  const hits = data.index.search(bounds.x - data.originX - 64, bounds.y - data.originY - 64,
    bounds.x + bounds.width - data.originX + 64, bounds.y + bounds.height - data.originY + 64);
  for (const id of hits) {
    const item = data.items[id]; if (!item) continue;
    const keys = Array.isArray(item.spriteKey) ? item.spriteKey : [item.spriteKey];
    const root = data.atlas[keys[0]]; if (!root) continue;
    const left = item.osdX - (root.ox ?? item.w / 2), top = item.osdY - (root.oy ?? item.h / 2);
    for (const key of keys) {
      const sprite = data.atlas[key]; if (!sprite) continue;
      const rotated = !!(item.poi as any)?.isTaikasauva;
      const width = rotated ? sprite.h : sprite.w, height = rotated ? sprite.w : sprite.h;
      const x = rotated ? left + (sprite.w - sprite.h) / 2 : left;
      const y = rotated ? top + (sprite.h - sprite.w) / 2 : top;
      out.push({ x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: Math.ceil(width) + 4, height: Math.ceil(height) + 4 });
    }
  }
  return out;
}
