import type { PortalPlacement } from './placements';
import { getTileData } from '../data_sources/tile_data';

const rooms: Record<string, { url: string; markerX: number; markerY: number }> = {
  teleport_hourglass_return: {
    url: new URL('./assets/backgrounds/eye-room-interior.png', import.meta.url).href,
    markerX: 256, markerY: 255,
  },
  teleport_meditation_cube_return: {
    url: new URL('./assets/backgrounds/meditation-chamber-interior.png', import.meta.url).href,
    markerX: 261, markerY: 254,
  },
};
// Match only the actual captured base sources, not arbitrary DZI layers:
// daily/previous-daily/local bakes contain loot as well as terrain.
const capturedTileRoots = getTileData('dynamic-main-branch').map(({ url }) => url.replace(/\.dzi$/, '_files/'));
interface PatchItem {
  setOpacity(opacity: number): void;
  source?: { tilesUrl?: string; __simplisticBase?: boolean };
}
function isCapturedBase(item: PatchItem) {
  return item.source?.__simplisticBase || capturedTileRoots.some(root => item.source?.tilesUrl?.startsWith(root));
}
interface PatchViewer {
  addTiledImage(options: {
    tileSource: { type: 'image'; url: string; buildPyramid: boolean };
    x: number; y: number; width: number; opacity: number;
    success(event: { item: PatchItem }): void; error(): void;
  }): void;
  world: {
    removeItem(item: PatchItem): void;
    getItemCount(): number; getItemAt(index: number): PatchItem;
    setItemIndex(item: PatchItem, index: number): void;
    addHandler(name: 'add-item', callback: () => void): void;
    removeHandler(name: 'add-item', callback: () => void): void;
  };
}
interface Patch {
  id: string; x: number; y: number; url: string;
  requested: boolean; item?: PatchItem; opacity: number;
}

/** Static source-over images in OSD's existing drawer, BELOW the screen-blended
 * particle canvas AND every seed layer (including baked loot). RGB comes only
 * from clean authored art; surrounding rock/liquid stay intact.
 * Never erase a captured portal whose animated replacement is not displayed. */
export class PortalBackgroundPatches {
  private patches = new Map<string, Patch>();
  private displayed = new Set<string>();
  private destroyed = false;
  constructor(private viewer: PatchViewer, portals: PortalPlacement[], private failure: (error: Error) => void) {
    this.viewer.world.addHandler('add-item', this.orderLayers);
    for (const portal of portals) {
      const room = rooms[portal.entity];
      if (room) this.patches.set(portal.id, { id: portal.id,
        x: portal.x - room.markerX, y: portal.y - room.markerY, url: room.url,
        requested: false, opacity: 0 });
    }
  }
  showForPortals(ids: readonly string[]) {
    if (this.destroyed) return;
    this.displayed = new Set(ids);
    for (const patch of this.patches.values()) {
      const show = this.displayed.has(patch.id);
      if (show && !patch.requested) {
        patch.requested = true;
        this.viewer.addTiledImage({
          tileSource: { type: 'image', url: patch.url, buildPyramid: false },
          // OSD's default is source-over. Setting compositeOperation explicitly
          // would unnecessarily force its WebGL drawer through a 2D copy pass.
          x: patch.x, y: patch.y, width: 512, opacity: 0,
          success: ({ item }) => {
            // A queued OSD source may finish after toggle-off/reseed. It must
            // never resurrect a patch or remove someone else's map layer.
            if (this.destroyed) { this.viewer.world.removeItem(item); return; }
            patch.item = item;
            this.orderLayers();
            this.setOpacity(patch, this.displayed.has(patch.id) ? 1 : 0);
          },
          error: () => {
            if (!this.destroyed) this.failure(new Error('Unable to load portal-free room background. Toggle portals off and on to retry.'));
          },
        });
        if (this.destroyed) return;
      }
      this.setOpacity(patch, show ? 1 : 0);
    }
  }
  private orderLayers = () => {
    if (this.destroyed) return;
    const world = this.viewer.world;
    const items = Array.from({ length: world.getItemCount() }, (_, i) => world.getItemAt(i));
    const patches = [...this.patches.values()].flatMap(patch => patch.item && items.includes(patch.item) ? [patch.item] : []);
    // Captured backgrounds are opened first. Insert directly above them, not
    // just below _isMarkerLayer: baked DZIs embed spells/wands in their pixels.
    const withoutPatches = items.filter(item => !patches.includes(item));
    let baseEnd = 0;
    withoutPatches.forEach((item, i) => { if (isCapturedBase(item)) baseEnd = i + 1; });
    patches.forEach((item, offset) => {
      const index = baseEnd + offset;
      if (world.getItemAt(index) !== item) world.setItemIndex(item, index);
    });
  };
  private setOpacity(patch: Patch, opacity: number) {
    if (!patch.item || patch.opacity === opacity) return;
    patch.opacity = opacity;
    patch.item.setOpacity(opacity);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewer.world.removeHandler('add-item', this.orderLayers);
    for (const patch of this.patches.values()) if (patch.item) this.viewer.world.removeItem(patch.item);
    this.patches.clear(); this.displayed.clear();
  }
}
