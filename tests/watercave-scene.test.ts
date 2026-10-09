import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isWaterCaveLayout } from '../src/telescope/terrain-policy';

it('limits the new scene path to the five layouts, excluding the static frame and other rooms', () => {
  for (let i = 1; i <= 5; i++) expect(isWaterCaveLayout(`general/watercave_layout_${i}`)).toBe(true);
  for (const key of ['general/watercave', 'spliced/watercave', 'general/friendroom', 'general/watercave_layout_6',
    'general/watercave_layout_1_visual', 'watercave_layout_1']) expect(isWaterCaveLayout(key)).toBe(false);
});

it.each([true, false])('paints all five real layouts and preserves their cache with full-pixel mode %s', async fullPixels => {
  const root = resolve(import.meta.dirname, '..'), bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-watercave-'));
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      plugins: [{ name: 'watercave-native-fixture', enforce: 'pre', transform(code, id) {
        const path = id.replace(/\\/g, '/');
        if (path.endsWith('/src/telescope/telescope-osd-bridge.ts'))
          return code + '\nexport { getScenePngIndex, compositeSceneBitmap, sceneRenderKey }; export function __warmSceneBuild(result) { currentGenerationId++; return buildSceneBitmaps(result, currentGenerationId); }';
        if (path.endsWith('/src/telescope/tile-cache.ts')) return code
          .replace('export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> {',
            'export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> { return new Map(keys.filter(key => globalThis.__warmSceneStore.has(key)).map(key => [key,globalThis.__warmSceneStore.get(key)]));')
          .replace('export async function getCachedSceneBitmapKeys(): Promise<Set<string>> {',
            'export async function getCachedSceneBitmapKeys(): Promise<Set<string>> { return new Set(globalThis.__warmSceneStore.keys());')
          .replace('export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> {',
            'export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> { globalThis.__warmSceneStore.set(key,{blob,width,height}); return;');
      } }], build: { outDir: bundle, rollupOptions: { input: resolve(root, 'tests/helpers/watercave-scene-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/watercave-scene-worker.mjs'), {
        workerData: { root, bundle, fullPixels, previewPath: `/tmp/noitamap-watercave-rendered-${fullPixels}.png` }, stdout: true, stderr: true,
      });
      let result: any, logs = '';
      for (const stream of [worker.stdout, worker.stderr]) stream!.on('data', data => { logs = (logs + data).slice(-8000); });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Water Cave test timed out\n' + logs)); }, 60000);
      worker.on('message', data => { result = data; });
      worker.on('error', reject);
      worker.on('exit', code => {
        clearTimeout(timer);
        if (code || result?.error || !result) reject(new Error((result?.error || 'Exit ' + code) + '\n' + logs));
        else done(result);
      });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.selected).toMatchObject({ key: 'general/watercave_layout_4', x: -2048, y: 515 });
    expect(result.samples).toHaveLength(5);
    for (const sample of result.samples) {
      expect(sample).toMatchObject({ width: 512, height: 512, mismatches: 0, rawVisualInIndex: false });
      expect(sample.air).toBeGreaterThan(20000);
      expect(sample.solid).toBeGreaterThan(100000);
      expect(sample.translucent).toBeGreaterThan(40000);
      expect(sample.colors).toBeGreaterThan(5);
      expect(sample.edgePixels).toBeGreaterThan(1000);
      expect(sample.changedStonePixels).toBeGreaterThan(1000);
      expect(sample.nonStoneChanges).toBe(0);
      expect(sample.renderKey).toContain('|watercave-edges-v2|12726363|');
    }
    expect(result.cache).toMatchObject({ sameBitmap: true, revisedCached: true, diskMatches: true, survivesRelease: true,
      addedPrefetchKeys: [], seedChangesPixels: true, seedKeyIsSeparate: true, oldKeysKept: true,
      shiftedKeyIsSeparate: true, backgroundKeyIsSeparate: true, forceAirOpaque: 0, disabled: true,
      unchangedKeys: { frame: 'general/watercave', friend: 'general/friendroom|friend-bg-v1|3072,5632', ordinary: 'coalmine/shop' } });
    console.log('[Water Cave native validation]', JSON.stringify(result));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 90000);
