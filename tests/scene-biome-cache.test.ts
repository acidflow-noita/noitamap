import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

it.each([true, false])('preserves the generated sky/hell shop colours through memory and PNG-cache reuse (full=%s)', async fullPixels => {
  const root = resolve(import.meta.dirname, '..'), bundle = await mkdtemp('/tmp/noitamap-scene-biome-');
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), publicDir: false, logLevel: 'error',
      plugins: [{ name: 'scene-biome-cache-fixture', enforce: 'pre', transform(code, id) {
        if (id === root + '/src/telescope/telescope-osd-bridge.ts') return code + `
          const __originalComposite = compositeSceneBitmap;
          compositeSceneBitmap = (...args) => { globalThis.__sceneComposites++; return __originalComposite(...args); };
          export { sceneRenderKey, compositeSceneBitmap, getScenePngIndex };
          export function __clearSceneMemory() { liveSceneBitmaps.clear(); }
          export function __warmSceneBuild(result) { currentGenerationId++; return buildSceneBitmaps(result, currentGenerationId); }`;
        if (id === root + '/src/telescope/tile-cache.ts') return code
          .replace('export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> {',
            'export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> { return new Map(keys.filter(key => globalThis.__warmSceneStore.has(key)).map(key => [key, globalThis.__warmSceneStore.get(key)]));')
          .replace('export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> {',
            'export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> { globalThis.__warmSceneStore.set(key, {blob,width,height}); return;');
      } }], build: { outDir: bundle, rollupOptions: { input: root + '/tests/helpers/scene-biome-cache-fixture.ts',
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } },
    });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/watercave-scene-worker.mjs'), {
        workerData: { root, bundle, fullPixels }, stdout: true, stderr: true,
      });
      let result: any, logs = '';
      for (const stream of [worker.stdout, worker.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-7000); });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Scene biome check timed out\n' + logs)); }, 60000);
      worker.on('message', value => { result = value; });
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('exit', code => {
        clearTimeout(timer);
        if (code || !result || result.error) reject(new Error((result?.error || 'Exit ' + code) + '\n' + logs));
        else done(result);
      });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.differentPixels).toBeGreaterThan(0);
    for (const phase of ['cold', 'warm', 'disk']) {
      expect(result[phase].entries).toBe(2);
      expect(result[phase].matching).toBe(result[phase].total);
      expect(result[phase].total).toBe(2);
    }
    expect(result).toMatchObject({ coldComposites: 2, warmComposites: 0, diskComposites: 0, shared: true, legacyEntryKept: true });
    console.log('[Shop biome cache]', JSON.stringify({ fullPixels, ...result }));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 90000);
