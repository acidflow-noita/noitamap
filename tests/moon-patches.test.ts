import { describe, expect, it, vi } from 'vitest';
import { MoonPatches } from '../src/portals/suns/moon-patches';

function fixture() {
  const base = { source: 'captured background' };
  const live = { source: 'live Moon scene' };
  const marker = { _isMarkerLayer: true };
  const items: any[] = [base, live, marker];
  const handlers = new Set<() => void>();
  const viewer = { addTiledImage: vi.fn(), world: {
    removeItem: vi.fn(item => { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); }),
    getItemCount: () => items.length, getItemAt: (index: number) => items[index],
    setItemIndex: vi.fn((item, index) => { items.splice(items.indexOf(item), 1); items.splice(index, 0, item); }),
    addHandler: vi.fn((_name: string, callback: () => void) => handlers.add(callback)),
    removeHandler: vi.fn((_name: string, callback: () => void) => handlers.delete(callback)),
  } }, failure = vi.fn();
  const patches = new MoonPatches(viewer, failure);
  const add = (item: any) => { items.push(item); handlers.forEach(callback => callback()); };
  return { viewer, failure, patches, items, base, live, marker, handlers, add, loaded(index = 0) {
    const item = { setOpacity: vi.fn() }; add(item);
    viewer.addTiledImage.mock.calls[index][0].success({ item }); return item;
  } };
}
describe('Moon replacement patches', () => {
  it('reuses one empty image at the two Moon footprints and keeps markers above it', () => {
    const f = fixture(); expect(f.viewer.addTiledImage).not.toHaveBeenCalled();
    f.patches.show(['sun', 'dark_sun']); const sun = f.loaded(), dark = f.loaded(1);
    const [first, second] = f.viewer.addTiledImage.mock.calls.map(call => call[0]);
    expect(first).toMatchObject({ x: 0, y: -26112, width: 512, opacity: 0, blendTime: 0 });
    expect(second).toMatchObject({ x: 0, y: 37512, width: 512, opacity: 0 });
    expect(first.tileSource).toEqual(second.tileSource);
    expect(first.tileSource).toMatchObject({ type: 'image', buildPyramid: false });
    expect(f.items).toEqual([f.base, f.live, sun, dark, f.marker]);
    expect(sun.setOpacity).toHaveBeenLastCalledWith(1);
    f.patches.show(['dark_sun']); expect(sun.setOpacity).toHaveBeenLastCalledWith(0);
    expect(dark.setOpacity).toHaveBeenLastCalledWith(1);
    const orders = f.viewer.world.setItemIndex.mock.calls.length;
    f.patches.show(['dark_sun']);
    expect(f.viewer.addTiledImage).toHaveBeenCalledTimes(2);
    expect(f.viewer.world.setItemIndex).toHaveBeenCalledTimes(orders);
    f.patches.destroy(); expect(f.items).toEqual([f.base, f.live, f.marker]);
    expect(f.handlers.size).toBe(0);
  });
  it('covers late baked terrain but never hides a newly rebuilt POI layer', async () => {
    const f = fixture(); f.patches.show(['sun', 'dark_sun']); const sun = f.loaded(), dark = f.loaded(1);
    const baked = { source: 'daily/map.dzi' }; f.add(baked);
    const marker: any = {}; f.add(marker);
    marker._isMarkerLayer = true; // assigned by OSD success after add-item
    await Promise.resolve();
    expect(f.items).toEqual([f.base, f.live, baked, sun, dark, f.marker, marker]);
    f.patches.destroy();
  });
  it('does not resurrect a patch after culling, changing unlocks or tearing down', async () => {
    const f = fixture(); f.patches.show(['sun']); f.patches.show([]);
    const hidden = f.loaded(); expect(hidden.setOpacity).not.toHaveBeenCalled();
    f.patches.show(['dark_sun']); f.patches.destroy();
    const late = f.loaded(1); await Promise.resolve();
    expect(late.setOpacity).not.toHaveBeenCalled(); expect(f.items).toEqual([f.base, f.live, f.marker]);
    f.viewer.addTiledImage.mock.calls[1][0].error(); expect(f.failure).not.toHaveBeenCalled();
  });
});
