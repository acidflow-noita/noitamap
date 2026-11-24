import { expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { browserTelescopeSource } from '../build_scripts/vite-telescope-browser';

it.each(['noita-telescope', 'noita-telescope-vm'])('matches the captured Snowy Chasm on %s', async fork => {
  const root = resolve(import.meta.dirname, '..');
  const dir = resolve(root, 'lib', fork);
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [{
      name: 'test-shipped-wang-generator',
      enforce: 'pre',
      transform(code, id) {
        if (id === resolve(dir, 'js/tile_generator.js')) return browserTelescopeSource(code, id);
      },
    }],
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  try {
    const load = (name: string) => server.ssrLoadModule(`/lib/${fork}/js/${name}.js`);
    const [{ generateBiomeTiles }, { generateBiomeData }, { GENERATOR_CONFIG }] = await Promise.all([
      load('tile_generator'), load('biome_generator'), load('generator_config'),
    ]);
    const image = async (name: string) => {
      const { data, info } = await sharp(resolve(dir, 'data', name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    };
    const seed = 786433191, template = await image('biome_maps/biome_map_nightmare.png');
    const { pixels } = generateBiomeData(seed, 0, 'nightmare', template.data, template.width, template.height);
    const config = { winter_caves: { ...GENERATOR_CONFIG.winter_caves, enabled: true, wangData: await image('wang_tiles/snowchasm.png') } };
    const layers = await generateBiomeTiles(pixels, template.width, template.height, config, seed, 0, 0, 'nightmare');
    const owners = (x: number, y: number) => layers.filter((l: any) => l.validChunks.has(`${x + 32},${y + 14}`))
      .map((l: any) => [l.minX - 32, l.minY - 14]);
    for (const [x, y] of [[8,8], [5,9], [6,9], [7,9], [8,9], [6,6]]) expect(owners(x, y)).toEqual([[4,5]]);
    expect(owners(8, 10)).toEqual([[5,8]]);
  } finally {
    vi.unstubAllGlobals();
    await server.close();
  }
}, 20000);
