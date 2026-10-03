import { it, expect, vi, afterEach } from 'vitest';
import { createCanvas, DOMMatrix } from '@napi-rs/canvas';
vi.mock('../src/telescope/terrain-backgrounds', () => ({
  loadTerrainBackgrounds: async (names: string[]) => new Map(names.map(name => [name, {
    width: 1, height: 1, data: new Uint8ClampedArray([36, 104, 172, 255]),
  }])),
}));
import { createLiveBackground } from '../src/telescope/live-terrain-background';
afterEach(() => vi.unstubAllGlobals());
it('keeps static material in the base map while authored air reveals the biome backdrop', async () => {
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal('DOMMatrix', DOMMatrix);
  const pixels = new Uint32Array(2 * 48); pixels[14 * 2 + 1] = 0x123456;
  const gen = { seed: 1, isNGP: false, biomeData: { pixels }, tileLayers: [{
    biomeName: 'coalmine', buffer: new Uint8Array(1), validChunks: new Set(['1,14']),
  }], sceneData: { scenes: [], sources: {}, staticMasks: [{
    x: 0, y: 0, width: 2, height: 1, bits: new Uint8Array([1]), airBits: new Uint8Array([2]),
  }] } };
  const compose = await createLiveBackground(gen, { GLTerrainRenderer: null,
    initMaterialAtlas: async () => {}, getWorldSize: () => 2, getWorldCenter: () => 1,
    GENERATOR_CONFIG: { coalmine: { wangFile: 'mine.png', color: 0x123456 } },
  });
  const foreground = createCanvas(2, 1), ctx = foreground.getContext('2d');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 2, 1);
  const frame = compose(foreground as any, { x: 0, y: 0, width: 2, height: 1 }, 1);
  expect([...frame.getContext('2d')!.getImageData(0, 0, 2, 1).data]).toEqual([0,0,0,0, 36,104,172,255]);
});
