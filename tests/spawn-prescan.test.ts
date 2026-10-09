import { expect, it } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from 'typescript';
import { browserTelescopeSource, telescopeBrowserPlugin } from '../build_scripts/vite-telescope-browser';

const root = resolve(import.meta.dirname, '..');
function functions(source: string, names: string[]) {
  const ast = createSourceFile('source.js', source, ScriptTarget.Latest);
  return ast.statements.filter(s => isFunctionDeclaration(s) && names.includes(s.name?.text ?? ''))
    .map(s => s.getText(ast).replace(/^export /, '')).join('\n');
}
async function fixture(fork: string) {
  const dir = resolve(root, 'lib', fork, 'js'), path = resolve(dir, 'poi_scanner.js');
  const source = await readFile(path, 'utf8');
  const transformed = (await browserTelescopeSource(source, path)).code;
  const helpers = (await readFile(resolve(dir, 'constants.js'), 'utf8')).replace(/\bexport /g, '')
    + '\n' + functions(await readFile(resolve(dir, 'utils.js'), 'utf8'), ['tileToWorldCoordinates', 'getWorldStride', 'getWorldSize']);
  const lookupSource = await readFile(resolve(dir, 'spawn_functions.js'), 'utf8');
  const lookup = functions(lookupSource, ['getSpawnFunctionIndex']);
  const compile = (body: string) => new Function('BIOME_SPAWN_FUNCTION_MAP', 'console',
    [helpers, lookup, functions(body, ['prescanSpawnFunctions']), 'return prescanSpawnFunctions;'].join('\n'));
  return { path, source, lookupSource, original: compile(source), current: compile(transformed) };
}
const grid = (biomeName: string, colors: number[], width = 13, mapH = 7) => {
  const backing = new Uint8Array((mapH + 8) * width * 3 + 9).fill(0xa5);
  const buffer = backing.subarray(5, -4);
  for (let y = 0; y < mapH + 8; y++) for (let x = 0; x < width; x++) {
    const color = colors[(x + y * width) % colors.length], i = (y * width + x) * 3;
    buffer[i] = color >>> 16; buffer[i + 1] = color >>> 8; buffer[i + 2] = color;
  }
  return { biomeName, width, mapH, minX: -13, minY: 9, buffer, backing };
};

it.each(['noita-telescope', 'noita-telescope-vm'])('preserves first-match colors, scan order/offsets and current tables in %s', async fork => {
  const f = await fixture(fork);
  const table = { sample: [
    { color: 0x123456, active: false }, { color: 0x123456, active: true },
    { color: 0x000000 }, { color: 0xffffff }, { color: 0xfedcba }, { color: '1193046' },
  ], empty: [] };
  const layers = [grid('sample', [0x123456, 0x000000, 0xffffff, 0xdddddd, 0xfedcba]),
    grid('empty', [0x123456]), grid('missing', [0x123456]),
    { biomeName: 'sample', isFill: true }, { biomeName: 'sample', isFill: false }];
  const before = structuredClone(layers);
  const old = f.original(table, { log() {} }), current = f.current(table, { log() {} });
  for (const isNGP of [false, true]) for (const mode of ['normal', 'nightmare']) {
    const expected = old(layers, isNGP, mode), actual = current(layers, isNGP, mode);
    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
    expect(new Set(actual.map((v: any) => v.spawnFunctionIndex))).toEqual(new Set([0, 4]));
  }
  // No memoized index may survive a table edit or replacement between calls.
  table.sample[0].color = 0x654321;
  expect(current(layers, false)).toEqual(old(layers, false));
  table.sample = [{ color: 0xfedcba, active: false }];
  expect(current(layers, true, 'nightmare')).toEqual(old(layers, true, 'nightmare'));
  expect(layers).toEqual(before);
  expect(await readFile(f.path, 'utf8')).toBe(f.source);
});

it.each(['noita-telescope', 'noita-telescope-vm'])('preserves randomized/truncated RGB views and refuses changed algorithms in %s', async fork => {
  const f = await fixture(fork), table: Record<string, any[]> = {};
  let state = 81231;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const layers = [];
  for (let i = 0; i < 48; i++) {
    const name = `biome${i}`, colors = [0, 0xffffff, ...Array.from({ length: 19 }, () => random() & 0xffffff)];
    table[name] = colors.slice(2).flatMap((color, index) => [{ color, active: index % 2 === 0 }, { color, active: true }]);
    layers.push(grid(name, colors, 1 + random() % 31, 1 + random() % 29));
    if (i % 3 === 0) layers.at(-1)!.buffer = layers.at(-1)!.buffer.subarray(0, random() % 30);
  }
  const before = structuredClone(layers);
  expect(f.current(table, { log() {} })(layers, false)).toEqual(f.original(table, { log() {} })(layers, false));
  expect(layers).toEqual(before);
  await expect(browserTelescopeSource(f.source.replace('y - 4, 0, 0', 'y - 3, 0, 0'), f.path))
    .rejects.toThrow('Review changed Telescope spawn prescan');
  const temporary = await mkdtemp('/tmp/noitamap-spawn-lookup-');
  try {
    await writeFile(resolve(temporary, 'spawn_functions.js'), f.lookupSource.replace('return i;', 'return i + 1;'));
    await expect(browserTelescopeSource(f.source, resolve(temporary, 'poi_scanner.js')))
      .rejects.toThrow('Review changed Telescope spawn-function lookup');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

it('registers the prescan transformation for both actual fork paths', async () => {
  const paths = ['noita-telescope', 'noita-telescope-vm'].map(fork => resolve(root, 'lib', fork, 'js'));
  const plugin = telescopeBrowserPlugin(paths);
  for (const directory of paths) {
    const path = resolve(directory, 'poi_scanner.js');
    const transformed = await (plugin.transform as any).call({}, await readFile(path, 'utf8'), path);
    expect(transformed.code).toContain('indexByColor.get(colorInt)');
  }
});
