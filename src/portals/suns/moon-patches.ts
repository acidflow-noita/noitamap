import type { SunEffect } from './placements';

const BACKGROUNDS = {
  sun: new URL('../assets/empty.svg', import.meta.url).href,
  dark_sun: new URL('../assets/backgrounds/dark-sun-hell.png', import.meta.url).href,
  dark_sun_baked: new URL('../assets/backgrounds/dark-sun-hell-baked.png', import.meta.url).href,
};
// Full scene origins from Noita's spliced/_moon.bat and _moon_dark.bat.
// These are terrain footprints, not the much larger particle/glow bounds.
export const MOON_BOUNDS = {
  sun: { x: 0, y: -26112, width: 512 },
  dark_sun: { x: 0, y: 37512, width: 512 },
} as const;

interface PatchItem {
  _isMarkerLayer?: boolean;
  setOpacity(opacity: number): void;
}
export interface MoonPatchViewer {
  addTiledImage(options: {
    tileSource: { type: 'image'; url: string; buildPyramid: boolean };
    x: number; y: number; width: number; opacity: number; blendTime: number;
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
type Patch = { item?: PatchItem; opacity: number };

/** Black sky for the Sun, world-aligned Hell texture for the Dark Sun.
 * Covers Moon art in live and baked rasters,
 * below POI markers. No animation, pixel copies, shader or tile pyramid. */
export class MoonPatches {
  private patches = new Map<SunEffect, Patch>();
  private visible = new Set<SunEffect>();
  private destroyed = false;
  private orderPending = false;
  constructor(private viewer: MoonPatchViewer, private failure: () => void, private baked = false) {
    viewer.world.addHandler('add-item', this.scheduleOrder);
  }
  show(effects: readonly SunEffect[]) {
    if (this.destroyed) return;
    if (effects.length === this.visible.size && effects.every(effect => this.visible.has(effect))) return;
    this.visible = new Set(effects);
    for (const effect of effects) {
      if (this.patches.has(effect)) continue;
      const patch: Patch = { opacity: 0 };
      this.patches.set(effect, patch);
      this.viewer.addTiledImage({
        tileSource: { type: 'image', url: BACKGROUNDS[effect === 'dark_sun' && this.baked ? 'dark_sun_baked' : effect], buildPyramid: false },
        ...MOON_BOUNDS[effect], opacity: 0, blendTime: 0,
        success: ({ item }) => {
          if (this.destroyed) { this.viewer.world.removeItem(item); return; }
          patch.item = item;
          this.orderLayers();
          this.setOpacity(patch, this.visible.has(effect) ? 1 : 0);
        },
        error: () => { if (!this.destroyed) this.failure(); },
      });
      if (this.destroyed) return;
    }
    for (const [effect, patch] of this.patches) this.setOpacity(patch, this.visible.has(effect) ? 1 : 0);
  }
  private setOpacity(patch: Patch, opacity: number) {
    if (!patch.item || patch.opacity === opacity) return;
    patch.opacity = opacity;
    patch.item.setOpacity(opacity);
  }
  private scheduleOrder = () => {
    if (this.orderPending || this.destroyed) return;
    this.orderPending = true;
    // OSD calls add-item before success assigns _isMarkerLayer. Order after
    // that callback so a freshly rebuilt marker layer stays above the patches.
    queueMicrotask(() => { this.orderPending = false; this.orderLayers(); });
  };
  private orderLayers() {
    if (this.destroyed) return;
    const world = this.viewer.world;
    const items = Array.from({ length: world.getItemCount() }, (_, i) => world.getItemAt(i));
    const patches = [...this.patches.values()].flatMap(p => p.item && items.includes(p.item) ? [p.item] : []);
    if (!patches.length) return;
    const rest = items.filter(item => !patches.includes(item));
    const ordered = [...rest.filter(item => !item._isMarkerLayer), ...patches, ...rest.filter(item => item._isMarkerLayer)];
    ordered.forEach((item, index) => {
      if (world.getItemAt(index) !== item) world.setItemIndex(item, index);
    });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewer.world.removeHandler('add-item', this.scheduleOrder);
    for (const patch of this.patches.values()) if (patch.item) this.viewer.world.removeItem(patch.item);
    this.patches.clear(); this.visible.clear();
  }
}
