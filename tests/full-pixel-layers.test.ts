import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
const calls = vi.hoisted(() => ({ mount: vi.fn(), native: vi.fn(), gpu: vi.fn(), dispose: vi.fn(), created: vi.fn(), ensure: vi.fn() }));
vi.mock('../src/telescope/terrain-viewport', () => ({ mountTerrainViewport: calls.mount, renderTerrainFrame: calls.native }));
vi.mock('../src/telescope/terrain-planes', () => ({ prepareTerrainPlane: vi.fn() }));
vi.mock('../src/telescope/gl-terrain-tile-source', () => ({ clearGLTerrain: vi.fn(), ensureGLTerrain: calls.ensure, createGLTerrainTileSource: vi.fn() }));
vi.mock('../src/telescope/live-terrain-view', () => ({
  LiveTerrainUnavailable: class extends Error {},
  LiveTerrainView: class { constructor() { calls.created(); } render = calls.gpu; dispose = calls.dispose; },
}));
import { addFullPixelLayers } from '../src/telescope/full-pixel-layers';
import { LiveTerrainUnavailable } from '../src/telescope/live-terrain-view';
const deps = { GLTerrainRenderer: null, initMaterialAtlas: async () => {}, getWorldSize: () => 2, getWorldCenter: () => 1, GENERATOR_CONFIG: {} };
const generation = { seed: 1, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(96) }, parallelWorlds: [0] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { createElement: () => createCanvas(1,1) });
  const frame = createCanvas(16,16); frame.getContext('2d').fillRect(0,0,16,16);
  calls.gpu.mockResolvedValue(frame); calls.native.mockResolvedValue(frame);
});
afterEach(() => vi.unstubAllGlobals());
async function mount() {
  await addFullPixelLayers({ viewport: {} }, generation, deps, () => true, () => {});
  return calls.mount.mock.calls[0][1];
}
it('routes main-world cameras directly through a retained TerrainView, with no native tile requests', async () => {
  const render = await mount(), signal = new AbortController().signal;
  const bounds = { x: 0, y: 0, width: 16, height: 16 };
  await render(bounds, 1, signal); await render(bounds, 1, signal);
  expect(calls.created).toHaveBeenCalledTimes(1); expect(calls.gpu).toHaveBeenCalledTimes(2);
  expect(calls.native).not.toHaveBeenCalled(); expect(calls.ensure).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('fullPixelTerrainReset'));
  expect(calls.dispose).toHaveBeenCalledOnce();
});
it('preserves the vertical-world renderer without initializing main-world GPU data', async () => {
  const render = await mount();
  await render({ x: 0, y: -7200, width: 16, height: 16 }, 1, new AbortController().signal);
  expect(calls.created).not.toHaveBeenCalled(); expect(calls.native).toHaveBeenCalledOnce();
  expect(calls.native.mock.calls[0][0].every((r: any) => r.y !== -7168)).toBe(true);
});
it('uses native full pixels when WebGL2 is unavailable and does not retry a rejected context every camera', async () => {
  calls.gpu.mockRejectedValue(new LiveTerrainUnavailable('No GPU'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const render = await mount(), bounds = { x: 0, y: 0, width: 16, height: 16 }, signal = new AbortController().signal;
    await render(bounds, 1, signal); await render(bounds, 1, signal);
    expect(calls.gpu).toHaveBeenCalledOnce(); expect(calls.native).toHaveBeenCalledTimes(2);
    expect(calls.native.mock.calls[0][0].every((r: any) => r.y === -7168)).toBe(true);
  } finally { warning.mockRestore(); }
});
