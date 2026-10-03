import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
    { filename: 'unknown', svg_map_path: 'M -100 -100 L 100 -100 L 100 100 Z' }]);
  expect(result).toMatchObject({ originX: -17920, originY: -7168, width: 2048, height: 1024, phaseX: -17920, phaseY: -7168 });
  expect(result.regions).toHaveLength(2);
  expect(result.regions[0].rings).toEqual([
    [{ x: -17920, y: -7168 }, { x: -16896, y: -7168 }, { x: -16896, y: -6144 }, { x: -17920, y: -6144 }],
    [{ x: -17664, y: -6912 }, { x: -17664, y: -6656 }, { x: -17408, y: -6656 }, { x: -17408, y: -6912 }],
  ]);
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
  let current = true;
  const attached = vi.fn();
  attachBiomeBackgroundLayer(viewer, layer, [0], () => current, attached);
  current = false;
  const options = viewer.addTiledImage.mock.calls[0][0], item = {};
  options.success({ item });
  expect(viewer.world.removeItem).toHaveBeenCalledWith(item);
  expect(attached).not.toHaveBeenCalled();
  options.error();
  expect(options.tileSource.destroy).toHaveBeenCalledOnce();
  attachBiomeBackgroundLayer(viewer, layer, [0], () => current, attached);
  expect(viewer.addTiledImage).toHaveBeenCalledOnce();
});
