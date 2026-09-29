import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { nativeSceneBitmapReplacesTerrain } from '../src/telescope/native-scene-bitmap';

// Exercise the live bridge selection boundary without booting the UI.
const file = ts.createSourceFile('bridge.ts', readFileSync(new URL(
  '../src/telescope/telescope-osd-bridge.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'instantSceneMasks')!;
const code = ts.transpileModule(declaration.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('retains terrain under native material scenes while preserving required and skipped-scene erasures', async () => {
  const room = { key: 'general/friendroom', name: 'friendroom', width: 512, height: 512,
    variantKey: 'biome=friend_1', x: 3072, y: 5632 };
  const gold = { ...room, key: 'general/solid_wall_hidden_cavern', name: 'solid_wall_hidden_cavern',
    variantKey: 'biome=general@solid_wall_hidden_cavern', x: -3102, y: 0 };
  const tank = { ...room, key: 'coalmine/oiltank_1', name: 'oiltank_1', width: 130, height: 260,
    variantKey: 'biome=coalmine' };
  const other = { ...room, key: 'general/shop', name: 'shop', variantKey: 'biome=general' };
  const skipped = { ...room, key: 'general/hourglass_chamber', name: 'hourglass_chamber' };
  const config = { skipNames: new Set([skipped.name]), skipBiomes: new Set(),
    layers: { background: true, mid: true }, layerOverrides: {} as Record<string, { background?: boolean; mid?: boolean }> };
  let full = true;
  const load = vi.fn(async (scenes: unknown[]) => scenes);
  const deps = { pixelSceneConfig: config, renderableScenes: () => [room, gold, tank, other],
    nativeSceneBitmapReplacesTerrain, useRenderPerfGeneration: () => full,
    loadInstantSceneMasks: load, ensurePixelSceneData: vi.fn() };
  const masks = new Function('deps', `const {${Object.keys(deps).join(',')}} = deps;
    ${code}; return instantSceneMasks;`)(deps);
  const result = { pixelScenesByPW: { '0,0': [room, gold, tank, other, skipped] } };
  expect(await masks(result)).toEqual([other, skipped]);
  config.layerOverrides.friendroom = { background: false };
  expect(await masks(result)).toEqual([room, other, skipped]);
  config.layerOverrides.solid_wall_hidden_cavern = { mid: false };
  expect(await masks(result)).toEqual([room, gold, other, skipped]);
  config.layerOverrides = {};
  full = false;
  expect(await masks(result)).toEqual([room, gold, tank, other, skipped]);
});
