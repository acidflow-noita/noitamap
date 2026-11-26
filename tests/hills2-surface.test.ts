import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
  correctSurfaceResolver, correctTerrainShaderBits, enableHills2MaterialField,
} from '../build_scripts/vite-terrain-shaders';
import { BIOME_ENGINE } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';

const directory = resolve(import.meta.dirname, '../lib/noita-telescope-vm/js');

it('reproduces the Hills2 height band from Noita’s surface-line instructions', async () => {
  const path = resolve(directory, 'engine_resolve/topo0_resolve.js');
  const source = correctSurfaceResolver(readFileSync(path, 'utf8')).replace(
    /from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, pathToFileURL(path)).href}'`,
  );
  const { surfaceLine, topo0Config, surfaceNoisePhase } = await import(
    /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const params = topo0Config(BIOME_ENGINE.find(entry => entry.color === 0x33e311));
  const phase = surfaceNoisePhase(1244794027);
  expect(phase).toBe(67557.578125);
  // Original i386 EvalSurfaceLine (0x0087eaf0) and its noise callees,
  // sampled in isolation from noita.exe SHA-256 a0d9f9ca...d17d914.
  for (const [x, top, bottom] of [
    [-98304.5, -1019.4334354204118, 1022.2727438099304],
    [-6144.5, -1025.9713647656522, 1004.4421831666384],
    [0.5, -1022.963696676434, 1028.1356532572531],
    [32768, -1024.1873738540537, 1002.9810932622992],
  ]) {
    expect(surfaceLine(params, phase, x)).toEqual([top, bottom]);
  }
});

it('enables only Hills2 in the full-pixel table and gives its top the existing four-octave shader', () => {
  const source = readFileSync(resolve(directory, 'engine_resolve/engine_data.js'), 'utf8');
  const patched = enableHills2MaterialField(source);
  const table = JSON.parse(patched.match(/export const BIOME_ENGINE = (.+);/)![1]);
  expect(table).toEqual(BIOME_ENGINE.map(entry =>
    entry.color === 0x33e311 ? { ...entry, supported: true } : entry));
  const shader = correctTerrainShaderBits(readFileSync(resolve(directory, 'gl/shaders.js'), 'utf8'));
  expect(shader).toContain('botY = magicNoise(sx, botB * t0.w) * t1.y + botB;');
  expect(shader).toContain('edge == 2 ? engFbm4(sx, topB * t0.w, 5) : magicNoise(sx, topB * t0.w)');
});
