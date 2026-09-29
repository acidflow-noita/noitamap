import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createScenePreparation } from '../src/telescope/scene-preparation';
import { usesNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';

// Run the production bridge preparation boundary with explicit asset/decoder
// inputs, without initializing the unrelated application and viewer modules.
const file = ts.createSourceFile('bridge.ts', readFileSync(new URL(
  '../src/telescope/telescope-osd-bridge.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'buildSceneBitmaps')!;
const code = ts.transpileModule(declaration.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(compact: boolean, cached: boolean, native = false) {
  const scenes = Array.from({ length: 24 }, (_, index) => ({ key: `general/scene-${index}`, width: 2048, height: 2048 }));
  const records = new Map(scenes.map(scene => [scene.key, {
    blob: new Blob(['compressed-art']), width: 2048, height: 2048,
  }]));
  let active = 0, peak = 0;
  const decode = vi.fn(async () => ({ width: 2048, height: 2048, close: vi.fn() }));
  const composite = vi.fn(async (key, _scene, _index, retainBitmap) => {
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return { ...records.get(key), bitmap: retainBitmap ? await decode() : null, kind: 'composite' };
  });
  const nativeComposite = vi.fn(async (scene, _worldSize, _renderer, retainBitmap) =>
    composite(scene.key, scene, {}, retainBitmap));
  const dispose = vi.fn();
  const dependencies = {
    currentGenerationId: 42,
    renderableScenes: () => scenes,
    sceneBitmapRenderKey: (scene: { key: string }) => scene.key,
    getMapMemoryBudget: () => ({ profile: compact ? 'compact' : 'desktop' }),
    getScenePngIndex: async () => ({}),
    getCachedSceneBitmapsBulk: async () => cached ? records : new Map(),
    getCachedSceneBitmap: async (key: string) => cached ? records.get(key) : null,
    createScenePreparation,
    createImageBitmap: decode,
    compositeSceneBitmap: composite,
    usesNativeSceneBitmap,
    compositeNativeSceneBitmap: nativeComposite,
    NativeSceneRenderer: class { dispose = dispose; },
    cacheSceneBitmap: vi.fn(async () => {}),
  };
  const prepare = new Function('deps',
    `const {${Object.keys(dependencies).join(',')}} = deps; ${code}; return buildSceneBitmaps;`)(dependencies);
  return { records, decode, composite, nativeComposite, dispose, prepare: (generation: number | null = 42) => prepare({ worldSize: 70 }, generation, native), peak: () => peak };
}

it('does not decode an entire cached map of scene artwork on compact devices', async () => {
  const f = fixture(true, true), result = await f.prepare();
  expect(result.bitmapByKey.size).toBe(0);
  expect(result.blobByKey).toEqual(f.records);
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.composite).not.toHaveBeenCalled();
});

it('bounds cold scene preparation and retains compressed results without output bitmaps', async () => {
  const f = fixture(true, false), result = await f.prepare();
  expect(f.peak()).toBe(1);
  expect(result.blobByKey).toEqual(f.records);
  expect(result.bitmapByKey.size).toBe(0);
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.composite).toHaveBeenCalledTimes(f.records.size);
});

it('preserves direct scene artwork on desktop', async () => {
  const f = fixture(false, true), result = await f.prepare();
  expect(result.blobByKey).toBeUndefined();
  expect(result.bitmapByKey.size).toBe(f.records.size);
  expect(f.decode).toHaveBeenCalledTimes(f.records.size);
});

it('keeps scene artwork available to synchronous bake/export even on a compact device', async () => {
  const f = fixture(true, true), result = await f.prepare(null);
  expect(result.blobByKey).toBeUndefined();
  expect(result.bitmapByKey.size).toBe(f.records.size);
  expect(f.decode).toHaveBeenCalledTimes(f.records.size);
});

it('uses native material painting for every live material scene and bounds decoded memory on desktop too', async () => {
  const f = fixture(false, false, true), result = await f.prepare();
  expect(f.nativeComposite).not.toHaveBeenCalled(); // attachment does not await the whole map
  expect(result.blobByKey.size).toBe(0);
  await result.preparation.loadBitmap([...f.records.keys()][0]);
  expect(f.nativeComposite).toHaveBeenCalledOnce();
  await result.preparation.warmAll();
  expect(f.nativeComposite).toHaveBeenCalledTimes(f.records.size);
  expect(f.nativeComposite.mock.calls.every(call => call[3] === false)).toBe(true);
  expect(result.bitmapByKey.size).toBe(0);
  expect(result.blobByKey).toEqual(f.records);
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.peak()).toBe(1);
  result.preparation.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
});
