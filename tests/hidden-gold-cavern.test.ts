import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { decode } from 'fast-png';
import { addStaticPixelScenes } from '../lib/noita-telescope-vm/js/static_spawns.js';
import { loadPixelSceneData, initPixelSceneTextures } from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { updateSettings } from '../lib/noita-telescope-vm/js/settings.js';

// Exercise the production bridge's private selection policy without loading
// its unrelated UI, viewer and asset initialization in a browser environment.
const bridgePath = new URL('../src/telescope/telescope-osd-bridge.ts', import.meta.url);
const bridge = ts.createSourceFile('bridge.ts', readFileSync(bridgePath, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['pixelSceneConfig', 'getSceneCategory', 'renderableScenes']);
const policy = bridge.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) ? names.has(statement.name?.text ?? '') :
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(bridge))),
).map(statement => statement.getText(bridge).replace(/^export\s+/, '')).join('\n');
const renderableScenes = new Function(`${ts.transpileModule(policy, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText}\nreturn renderableScenes;`)();

let restore = () => {};
let biomeData: { pixels: Uint32Array; heavenPixels: Uint32Array; hellPixels: Uint32Array };
beforeAll(async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url));
    return new Response(await readFile(url));
  });
  restore = () => fetch.mockRestore();
  updateSettings({ enableStaticPixelScenes: 'all', clearSpawnPixels: true });
  await loadPixelSceneData();
  await initPixelSceneTextures();
  const png = decode(readFileSync(new URL('../lib/noita-telescope-vm/data/biome_maps/biome_map.png', import.meta.url)));
  const pixels = new Uint32Array(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * png.channels;
    pixels[i] = 0xff000000 | (png.data[offset] << 16) | (png.data[offset + 1] << 8) | png.data[offset + 2];
  }
  const heavenPixels = new Uint32Array(pixels.length), hellPixels = new Uint32Array(pixels.length);
  for (let y = 0; y < png.height; y++) {
    heavenPixels.set(pixels.subarray(0, png.width), y * png.width);
    hellPixels.set(pixels.subarray((png.height - 1) * png.width), y * png.width);
  }
  biomeData = { pixels, heavenPixels, hellPixels };
});
afterAll(() => restore());

it.each([
  [1, -3102, 0], // Ancient Laboratory, previously suppressed as static art.
  [4, -3102, 8192],
  [7, 2530, 8704],
  [3, -4126, 11264],
])('keeps the generated hidden gold room for seed %i in every horizontal world', (seed, x, y) => {
  expect(policy).toContain('skipNames');
  for (const pw of [-1, 0, 1]) {
    const { pixelScenes } = addStaticPixelScenes(seed, 0, pw, 0, biomeData, false, {}, false, 'normal');
    const drawn = renderableScenes({ pixelScenesByPW: { [`${pw},0`]: pixelScenes } });
    const stashes = drawn.filter((scene: any) => scene.key === 'general/solid_wall_hidden_cavern');
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toMatchObject({ x: x + pw * 35840, y, width: 512, height: 512 });
  }
});
