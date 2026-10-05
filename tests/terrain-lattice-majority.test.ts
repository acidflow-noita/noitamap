import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyTerrainLatticeMajority } from '../src/telescope/terrain-lattice-majority';
import { browserTelescopeSource } from '../build_scripts/vite-telescope-browser';

const path = new URL('../lib/noita-telescope-vm/js/engine_resolve/lattice_builder.js', import.meta.url).pathname;
const source = readFileSync(path, 'utf8');
const original = source.match(/function neighbourMajority\(cov, mat, w, h\) \{[\s\S]*?\n\}/)![0];
const reference = new Function(`${original}; return neighbourMajority;`)() as typeof applyTerrainLatticeMajority;

it('matches the pinned vote for every four-neighbour combination, including zeros and ties', () => {
  const values = [0, 1, 2, 32766, 65535];
  for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
    const mat = new Uint16Array([0,c,0,a,0,b,0,d,0]);
    const cov = new Float32Array(9).fill(1); cov[4] = 0;
    const expected = mat.slice(); reference(cov, expected, 3, 3);
    applyTerrainLatticeMajority(cov, mat, 3, 3);
    expect(mat, `${a},${b},${c},${d}`).toEqual(expected);
  }
  const tie = new Uint16Array([0,2,0,1,0,2,0,1,0]);
  applyTerrainLatticeMajority(new Float32Array(9), tie, 3, 3);
  expect(tie[4]).toBe(2); // 1,2,2,1: the second value reaches two first.
});

it.each([[1,1],[1,51],[52,1],[2,2],[51,52],[256,256]])('preserves snapshot reads, toroidal wrapping and coverage in %ix%i grids', (w,h) => {
  let state = 12345;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const mat = Uint16Array.from({length:w*h}, () => random()%4 === 0 ? random()%65535+1 : 0);
  const cov = Float32Array.from({length:w*h}, () => [0,-0,-1,.125,1][random()%5]);
  const before = cov.slice(), expected = mat.slice();
  reference(cov, expected, w, h);
  applyTerrainLatticeMajority(cov, mat, w, h);
  expect(mat).toEqual(expected); expect(cov).toEqual(before);
});

it('integrates through the existing host build boundary and rejects a changed upstream algorithm', async () => {
  const compiled = await browserTelescopeSource(source, path);
  expect(compiled.code).toContain('terrain-lattice-majority.ts');
  expect(compiled.code).not.toContain('counts.clear()');
  expect(compiled.code).toContain('export');
  await expect(browserTelescopeSource(source.replace('c > bestN', 'c >= bestN'), path))
    .rejects.toThrow('Review changed Telescope lattice neighbour vote');
});
