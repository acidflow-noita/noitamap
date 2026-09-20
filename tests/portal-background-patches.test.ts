import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decode } from 'fast-png';
import { PortalBackgroundPatches } from '../src/portals/background-patches';
import type { PortalPlacement } from '../src/portals/placements';
import sources from '../src/portals/assets/backgrounds/sources.json';
import { getTileData } from '../src/data_sources/tile_data';

function portal(entity: string, x: number, y: number): PortalPlacement {
  return { id: `${entity}:${x}:${y}`, entity, x, y, effect: 'meditation', condition: 'return', phase: 0 };
}
const cube = portal('teleport_meditation_cube_return', -4347, 2302);
const eye = portal('teleport_hourglass_return', -3840, 5375);
function fixture(portals = [cube, eye]) {
  const base = { source: { tilesUrl: getTileData('dynamic-main-branch')[0].url.replace(/\.dzi$/, '_files/') }, setOpacity: vi.fn() };
  const items: any[] = [base];
  const handlers = new Map<string, () => void>();
  const viewer = { addTiledImage: vi.fn(), world: {
    removeItem: vi.fn(item => { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); }),
    getItemCount: () => items.length, getItemAt: (index: number) => items[index],
    setItemIndex: vi.fn((item, index) => { items.splice(items.indexOf(item), 1); items.splice(index, 0, item); }),
    addHandler: vi.fn((name: string, callback: () => void) => handlers.set(name, callback)),
    removeHandler: vi.fn((name: string) => handlers.delete(name)),
  } }, failure = vi.fn();
  const patches = new PortalBackgroundPatches(viewer, portals, failure);
  return { viewer, failure, patches, items, base, handlers, loaded(index = 0) {
    const item = { setOpacity: vi.fn() };
    items.push(item); handlers.get('add-item')?.();
    viewer.addTiledImage.mock.calls[index][0].success({ item });
    return item;
  } };
}
describe('toggle-bound portal backgrounds', () => {
  it('places only displayed destination-room patches at scene origins with normal source-over', () => {
    const pw = 70 * 512;
    const side = portal(cube.entity, cube.x + pw, cube.y);
    const f = fixture([cube, eye, side, portal('teleport_meditation_cube', 1, 2)]);
    expect(f.viewer.addTiledImage).not.toHaveBeenCalled();
    f.patches.showForPortals([cube.id, side.id]);
    expect(f.viewer.addTiledImage).toHaveBeenCalledTimes(2);
    expect(f.viewer.addTiledImage.mock.calls[0][0]).toMatchObject({
      x: -4608, y: 2048, width: 512, opacity: 0,
      tileSource: { type: 'image', buildPyramid: false },
    });
    expect(f.viewer.addTiledImage.mock.calls[0][0].compositeOperation).toBeUndefined(); // OSD's normal source-over
    expect(f.viewer.addTiledImage.mock.calls[1][0].x).toBe(-4608 + pw);
    const item = f.loaded(); expect(item.setOpacity).toHaveBeenLastCalledWith(1);
    f.patches.showForPortals([cube.id]); expect(f.viewer.addTiledImage).toHaveBeenCalledTimes(2);
    f.patches.showForPortals([]); expect(item.setOpacity).toHaveBeenLastCalledWith(0);
    f.patches.showForPortals([cube.id]); expect(item.setOpacity).toHaveBeenLastCalledWith(1);
    f.patches.destroy(); expect(f.viewer.world.removeItem).toHaveBeenCalledWith(item);
  });
  it('does not resurrect patches when image loading finishes after culling, toggle-off or reseed', () => {
    const f = fixture(); f.patches.showForPortals([eye.id]);
    expect(f.viewer.addTiledImage.mock.calls[0][0]).toMatchObject({ x: -4096, y: 5120 });
    f.patches.showForPortals([]);
    const hidden = f.loaded(); expect(hidden.setOpacity).not.toHaveBeenCalled();
    f.patches.showForPortals([cube.id]);
    f.patches.destroy();
    const late = f.loaded(1); expect(late.setOpacity).not.toHaveBeenCalled();
    expect(f.viewer.world.removeItem).toHaveBeenCalledWith(late);
    f.patches.showForPortals([cube.id]); expect(f.viewer.addTiledImage).toHaveBeenCalledTimes(2);
  });
  it.each([
    'https://daily-middle.acidflow.stream/map_files/',
    'https://previous-daily-middle.acidflow.stream/map_files/',
    '/__local-bake/middle/map_files/',
    'marker-tile://live',
  ])('keeps both room patches below seed loot, even without a marker flag: %s', tilesUrl => {
    const f = fixture();
    const loot = { source: { tilesUrl }, setOpacity: vi.fn() };
    f.items.push(loot);
    f.patches.showForPortals([cube.id, eye.id]);
    const first = f.loaded(), second = f.loaded(1);
    expect(f.items).toEqual([f.base, first, second, loot]);
    // New seed content stays above both patches; no per-frame world reshuffling.
    const late = { source: {}, setOpacity: vi.fn() };
    f.items.push(late); f.handlers.get('add-item')!();
    expect(f.items).toEqual([f.base, first, second, loot, late]);
    const calls = f.viewer.world.setItemIndex.mock.calls.length;
    f.patches.showForPortals([cube.id, eye.id]);
    expect(f.viewer.world.setItemIndex).toHaveBeenCalledTimes(calls);
    f.patches.destroy(); expect(f.items).toEqual([f.base, loot, late]);
    expect(f.handlers.size).toBe(0);
  });
  it('recognizes the simplified base without treating a seed image as background', () => {
    const f = fixture(); f.base.source = { __simplisticBase: true } as any;
    const seed = { source: {}, setOpacity: vi.fn() }; f.items.push(seed);
    f.patches.showForPortals([cube.id]); const item = f.loaded();
    expect(f.items).toEqual([f.base, item, seed]);
  });
  it('reports load failures while active but ignores late failures after cleanup', () => {
    const f = fixture(); f.patches.showForPortals([cube.id]);
    f.viewer.addTiledImage.mock.calls[0][0].error(); expect(f.failure).toHaveBeenCalledOnce();
    f.patches.destroy(); f.viewer.addTiledImage.mock.calls[0][0].error(); expect(f.failure).toHaveBeenCalledOnce();
  });
  it.each(sources)('ships clean authored art with no spawn-colored holes for $name', source => {
    const file = new URL(`../src/portals/assets/backgrounds/${source.name}-interior.png`, import.meta.url);
    const image = decode(readFileSync(file));
    expect([image.width, image.height]).toEqual([512, 512]);
    let opaque = 0; const alphas = new Set<number>();
    for (let i = 3; i < image.data.length; i += 4) {
      alphas.add(image.data[i]);
      if (image.data[i] === 255) opaque++;
    }
    expect([...alphas].sort((a, b) => a - b)).toEqual(source.alphaValues);
    expect(opaque).toBe(source.opaquePixels);
    const [x, y] = source.portalMarker;
    expect(image.data[(y * 512 + x) * 4 + 3]).toBe(255);
    expect(image.data[3]).toBe(0); // surrounding captured map is untouched
    const forbidden = new Set([0x366178, 0x00ff00, 0x55af8c, 0x50a0f0]);
    for (const [sx, sy] of source.coveredSpawnPoints) {
      const offset = (sy * 512 + sx) * 4;
      expect(image.data[offset + 3]).toBe(255); // no holes at ANY spawn marker
      const color = image.data[offset] << 16 | image.data[offset + 1] << 8 | image.data[offset + 2];
      expect(forbidden.has(color)).toBe(false);
    }
    for (const [mx, my] of source.preservedMetalSamples) {
      expect(image.data[(my * 512 + mx) * 4 + 3]).toBe(0);
    }
    if (source.name === 'eye-room') expect(source.preservedMetalPixels).toBe(6956);
    const visual = Object.keys(source.inputs).some(path => path.endsWith('_visual.png'));
    expect(visual).toBe(source.name === 'meditation-chamber');
  });
});
