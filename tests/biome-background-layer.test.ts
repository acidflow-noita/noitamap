import { readFileSync } from 'node:fs';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decode } from 'fast-png';
import { BIOME_BACKGROUND_MAP, createBackgroundOwnership, createTerrainOwnership, WORLD_HEIGHT, WORLD_TOP } from '../src/telescope/terrain-policy';
import { GENERATOR_CONFIG } from '../lib/noita-telescope-vm/js/generator_config.js';

const state = vi.hoisted(() => ({
  revisions: { 'background_coalmine.png': 'coal-revision', 'background_wandcave.png': 'wand-revision' },
  cache: vi.fn(),
  tiles: vi.fn(),
}));
vi.mock('virtual:noitamap-data-archives', () => ({ biomeBackgroundRevisions: state.revisions }));
vi.mock('../src/data/biome_boundries_py.json', () => ({ default: { biomes: [
  { filename: 'coalmine', svg_map_path: 'M 0 0 L 2 0 L 2 2 L 0 2 Z M 0.5 0.5 L 0.5 1 L 1 1 L 1 0.5 Z' },
  { filename: 'wandcave', svg_map_path: 'M 3 0 L 4 0 L 4 1 L 3 1 Z' },
] } }));
vi.mock('../src/telescope/biome-background-tile-source', () => ({ createBiomeBackgroundTiles: state.tiles }));
vi.mock('../src/telescope/immutable-assets', async () => {
  const actual = await vi.importActual<any>('../src/telescope/immutable-assets');
  return { ...actual, immutableTelescopeAssets: { fetch: state.cache } };
});
beforeEach(() => {
  vi.resetModules();
  state.cache.mockReset().mockImplementation((_key, _revision, download) => download());
  state.tiles.mockReset().mockReturnValue({ createSource: vi.fn(() => ({ destroy: vi.fn() })) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('png')));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains native world coordinates, compound holes, and static-biome exclusions', async () => {
  const { biomeBackgroundGeometry } = await import('../src/telescope/biome-background-layer');
  const { default: boundaries } = await import('../src/data/biome_boundries_py.json');
  const result = biomeBackgroundGeometry([...boundaries.biomes,
    { filename: 'temple_altar', svg_map_path: 'M -100 -100 L 100 -100 L 100 100 Z' },
    ...Array.from({ length: 6 }, (_, i) => ({ filename: `friend_${i + 1}`, svg_map_path: 'M -100 -100 L 100 -100 L 100 100 Z' })),
    { filename: 'solid_wall_hidden_cavern', svg_map_path: 'M -100 -100 L 100 -100 L 100 100 Z' },
    { filename: 'unknown', svg_map_path: 'M -100 -100 L 100 -100 L 100 100 Z' }]);
  expect(result).toMatchObject({ originX: -17920, originY: -7168, width: 2048, height: 1024, phaseX: -17920, phaseY: -7168 });
  expect(result.regions).toHaveLength(2);
  expect(result.regions[0].rings).toEqual([
    [{ x: -17920, y: -7168 }, { x: -16896, y: -7168 }, { x: -16896, y: -6144 }, { x: -17920, y: -6144 }],
    [{ x: -17664, y: -6912 }, { x: -17664, y: -6656 }, { x: -17408, y: -6656 }, { x: -17408, y: -6912 }],
  ]);
});

it('leaves the reported EDR chunk at -2842,8492 uncovered by biome backdrops', async () => {
  const { biomeBackgroundGeometry } = await import('../src/telescope/biome-background-layer');
  const { biomes } = JSON.parse(readFileSync('src/data/biome_boundries_py.json', 'utf8'));
  const cavern = biomes.find((biome: { filename: string }) => biome.filename === 'solid_wall_hidden_cavern');
  const context = createCanvas(1, 1).getContext('2d');
  const x = -2842, y = 8492;
  expect(context.isPointInPath(new Path2D(cavern.svg_map_path), (x + 17920) / 512, (y + 7168) / 512)).toBe(true);
  for (const region of biomeBackgroundGeometry(biomes).regions) {
    const path = new Path2D();
    for (const ring of region.rings) {
      path.moveTo(ring[0].x, ring[0].y);
      for (const point of ring.slice(1)) path.lineTo(point.x, point.y);
      path.closePath();
    }
    expect(context.isPointInPath(path, x, y), region.textureKey).toBe(false);
  }
});

it('matches the baker background footprint throughout hell, including gaps without generated terrain', async () => {
  const { biomeBackgroundGeometry } = await import('../src/telescope/biome-background-layer');
  const { biomes } = JSON.parse(readFileSync('src/data/biome_boundries_py.json', 'utf8'));
  const map = decode(readFileSync('lib/noita-telescope-vm/data/biome_maps/biome_map.png'));
  expect([map.width, map.height, map.channels]).toEqual([70, 48, 3]);
  const pixels = new Uint32Array(map.width * map.height);
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const i = ((map.height - 1) * map.width + x) * 3;
    pixels[y * map.width + x] = (map.data[i] << 16) | (map.data[i + 1] << 8) | map.data[i + 2];
  }
  const terrain = createTerrainOwnership([], pixels, {}, map.width);
  const baked = createBackgroundOwnership(terrain, pixels, GENERATOR_CONFIG, 1);
  const geometry = biomeBackgroundGeometry(biomes);
  const paths = geometry.regions.map(region => {
    const path = new Path2D();
    for (const ring of region.rings) {
      path.moveTo(ring[0].x, ring[0].y);
      for (const point of ring.slice(1)) path.lineTo(point.x, point.y);
      path.closePath();
    }
    return { path, key: region.textureKey };
  });
  const context = createCanvas(1, 1).getContext('2d');
  for (let y = 0; y < 48; y++) for (let x = 0; x < 70; x++) {
    const wx = (x - 35) * 512 + 256, localY = WORLD_TOP + y * 512 + 256;
    const owner = baked.at(wx, localY);
    const expected = owner < 0 ? [] : [BIOME_BACKGROUND_MAP[baked.names[owner]]];
    expect(paths.filter(({ path }) => context.isPointInPath(path, wx, localY + WORLD_HEIGHT))
      .map(({ key }) => key), `hell cell ${x},${y}`).toEqual(expected);
    expect(terrain.at(wx, localY)).toBe(-1);
  }
  expect(geometry.originY + geometry.height).toBe(WORLD_TOP + 2 * WORLD_HEIGHT);
  for (const { path } of paths) {
    expect(context.isPointInPath(path, -160, WORLD_TOP + 2 * WORLD_HEIGHT + .5)).toBe(false);
    expect(context.isPointInPath(path, -160, WORLD_TOP - .5)).toBe(false);
  }
});

it('extends only the bottom-row coverage while preserving holes and winding', async () => {
  const { biomeBackgroundGeometry } = await import('../src/telescope/biome-background-layer');
  const geometry = biomeBackgroundGeometry([
    { filename: 'the_end', svg_map_path: 'M 27 46 L 42 46 L 42 48 L 27 48 Z M 30 46 L 30 48 L 32 48 L 32 46 Z M 35 46 L 37 46 L 37 48 L 35 48 Z' },
    { filename: 'coalmine', svg_map_path: 'M 0 45 L 5 45 L 5 47 L 0 47 Z' },
  ]);
  const region = geometry.regions[0], path = new Path2D();
  for (const ring of region.rings) {
    path.moveTo(ring[0].x, ring[0].y);
    for (const point of ring.slice(1)) path.lineTo(point.x, point.y);
    path.closePath();
  }
  const context = createCanvas(1, 1).getContext('2d');
  for (let x = 26; x < 43; x++) {
    expect(context.isPointInPath(path, (x - 35) * 512 + 256, 20116))
      .toBe(x >= 27 && x < 42 && !(x >= 30 && x < 32));
  }
  expect(geometry.regions[1].rings).toHaveLength(1);
});

it('shares native artwork preparation and requests only revisioned local PNGs', async () => {
  const { prepareBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const [first, second] = await Promise.all([prepareBiomeBackgroundLayer(), prepareBiomeBackgroundLayer()]);
  expect(first).toBe(second);
  expect(await prepareBiomeBackgroundLayer()).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith('./biome_bg/background_coalmine.png?noitamap_revision=coal-revision', { signal: expect.any(AbortSignal) });
  expect(fetch).toHaveBeenCalledWith('./biome_bg/background_wandcave.png?noitamap_revision=wand-revision', { signal: expect.any(AbortSignal) });
  expect(state.cache.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['biome-background/background_coalmine.png', 'coal-revision'],
    ['biome-background/background_wandcave.png', 'wand-revision'],
  ]);
  expect(state.tiles).toHaveBeenCalledOnce();
  expect(state.tiles.mock.calls[0][0].textures.size).toBe(2);
});

it('closes partial artwork after a download failure and permits a clean retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('missing', { status: 404 }));
  const { prepareBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  await expect(prepareBiomeBackgroundLayer()).rejects.toThrow('404');
  expect(state.tiles).not.toHaveBeenCalled();
  const bitmap = await vi.mocked(createImageBitmap).mock.results[0].value;
  expect(bitmap.close).toHaveBeenCalledOnce();
  await prepareBiomeBackgroundLayer();
  expect(state.tiles).toHaveBeenCalledOnce();
});

it('places independently phased PW sources below subsequent terrain layers', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 5, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const attached = vi.fn();
  attachBiomeBackgroundLayer(viewer, layer, [-35840, 0, 35840], () => true, attached);
  expect(vi.mocked(layer.tiles.createSource).mock.calls).toEqual([[-35840], [0], [35840]]);
  expect(viewer.addTiledImage.mock.calls.map(([options]) => [options.x, options.y, options.width, options.index])).toEqual([
    [-53760, -7168, 2048, 5], [-17920, -7168, 2048, 5], [17920, -7168, 2048, 5],
  ]);
  const item = {};
  viewer.addTiledImage.mock.calls[0][0].success({ item });
  expect(attached).toHaveBeenCalledWith(item);
});

it('removes late attachments after reseeding and disposes failed attachments', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 0, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const destroy = vi.fn();
  vi.mocked(layer.tiles.createSource).mockReturnValueOnce({ destroy });
  let current = true;
  const attached = vi.fn();
  attachBiomeBackgroundLayer(viewer, layer, [0], () => current, attached);
  current = false;
  const options = viewer.addTiledImage.mock.calls[0][0], item = {};
  options.success({ item });
  expect(viewer.world.removeItem).toHaveBeenCalledWith(item);
  expect(attached).not.toHaveBeenCalled();
  options.error();
  expect(destroy).toHaveBeenCalledOnce();
  attachBiomeBackgroundLayer(viewer, layer, [0], () => current, attached);
  expect(viewer.addTiledImage).toHaveBeenCalledOnce();
});

it('shares pending and attached backgrounds across seeds without keeping an obsolete callback', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 4, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const first = vi.fn(), next = vi.fn();
  let current = true;
  attachBiomeBackgroundLayer(viewer, layer, [0], () => current, first);
  current = false;
  attachBiomeBackgroundLayer(viewer, layer, [0], () => true, next);
  const item = {};
  viewer.addTiledImage.mock.calls[0][0].success({ item });
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledExactlyOnceWith(item);
  expect(viewer.world.removeItem).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) attachBiomeBackgroundLayer(viewer, layer, [0], () => true, next);
  expect(layer.tiles.createSource).toHaveBeenCalledOnce();
  expect(viewer.addTiledImage).toHaveBeenCalledOnce();
});

it('clears attached and pending backgrounds on baked/static navigation and rejects late callbacks', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer, clearBiomeBackgroundLayers } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 0, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const attached = vi.fn();
  const disposals: ReturnType<typeof vi.fn>[] = [];
  vi.mocked(layer.tiles.createSource).mockImplementation(() => {
    const destroy = vi.fn(); disposals.push(destroy); return { destroy };
  });
  attachBiomeBackgroundLayer(viewer, layer, [-35840, 0, 35840], () => true, attached);
  const options = viewer.addTiledImage.mock.calls.map(([options]) => options);
  const first = {}, late = {};
  options[0].success({ item: first });
  clearBiomeBackgroundLayers(viewer);
  clearBiomeBackgroundLayers(viewer);
  options[1].success({ item: late });
  expect(viewer.world.removeItem.mock.calls).toEqual([[first], [late]]);
  expect(attached).toHaveBeenCalledExactlyOnceWith(first);
  for (const destroy of disposals) expect(destroy).toHaveBeenCalledOnce();
  attachBiomeBackgroundLayer(viewer, layer, [0], () => true, attached);
  expect(layer.tiles.createSource).toHaveBeenCalledTimes(4);
});

it('keeps the middle background when light mode changes and rebuilds removed sources only', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 0, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const attached = vi.fn();
  attachBiomeBackgroundLayer(viewer, layer, [-35840, 0, 35840], () => true, attached);
  const items = viewer.addTiledImage.mock.calls.map(([options]) => {
    const item = { source: options.tileSource }; options.success({ item }); return item;
  });
  attachBiomeBackgroundLayer(viewer, layer, [0], () => true, attached);
  expect(viewer.world.removeItem.mock.calls).toEqual([[items[0]], [items[2]]]);
  expect(attached).toHaveBeenLastCalledWith(items[1]);
  attachBiomeBackgroundLayer(viewer, layer, [-35840, 0, 35840], () => true, attached);
  expect(layer.tiles.createSource).toHaveBeenCalledTimes(5);
  items[1].source.destroy();
  attachBiomeBackgroundLayer(viewer, layer, [-35840, 0, 35840], () => true, attached);
  expect(layer.tiles.createSource).toHaveBeenCalledTimes(6);
});

it('allows retry after both asynchronous and synchronous attachment failures', async () => {
  const { prepareBiomeBackgroundLayer, attachBiomeBackgroundLayer } = await import('../src/telescope/biome-background-layer');
  const layer = await prepareBiomeBackgroundLayer();
  const viewer = { world: { getItemCount: () => 0, removeItem: vi.fn() }, addTiledImage: vi.fn() };
  const attach = () => attachBiomeBackgroundLayer(viewer, layer, [0], () => true, () => {});
  attach(); viewer.addTiledImage.mock.calls[0][0].error();
  viewer.addTiledImage.mockImplementationOnce(() => { throw new Error('OSD stopped'); });
  expect(attach).toThrow('OSD stopped');
  attach();
  expect(layer.tiles.createSource).toHaveBeenCalledTimes(3);
});
