import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
async function run(bundle: string): Promise<any> {
  return new Promise((done, reject) => {
    const worker = new Worker(resolve(root, 'tests/helpers/png-pipeline-worker.mjs'), {
      workerData: { root, bundle }, stdout: true, stderr: true,
    });
    let result: any, logs = '';
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', b => logs = (logs + b).slice(-8000));
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PNG pipeline timed out\n' + logs)); }, 90000);
    worker.on('message', value => result = value);
    worker.on('error', error => { clearTimeout(timer); reject(error); });
    worker.on('exit', code => { clearTimeout(timer);
      if (code || !result || result.error) reject(new Error((result?.error || 'Exit ' + code) + '\n' + logs));
      else done(result);
    });
  });
}

it('preserves real generation, scene masks and final composed artwork through cold and warm seeds', async () => {
  const directory = await mkdtemp('/tmp/noitamap-png-pipeline-');
  try {
    const results = [];
    for (const baseline of [true, false]) {
      const bundle = resolve(directory, baseline ? 'reference' : 'current');
      await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
        plugins: [{ name: 'png-reference-and-scene-probe', enforce: 'pre', transform(code, id) {
          if (baseline && id === resolve(root, 'src/telescope/png-rgba.ts'))
            return 'export const telescopePngRgba = (image, upng) => new Uint8Array(upng.toRGBA8(image)[0]);';
          if (id === resolve(root, 'src/telescope/telescope-osd-bridge.ts'))
            return code + '\nexport { instantSceneMasks }; export function __warmSceneBuild(result) { currentGenerationId++; return buildSceneBitmaps(result, currentGenerationId); }';
          // Only replace optional persistent I/O; actual scene decoding,
          // composition, masks, bitmap leases and PNG storage stay exercised.
          if (id === resolve(root, 'src/telescope/tile-cache.ts')) return code
            .replace('export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> {',
              'export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> { return new Map(keys.filter(k => globalThis.__warmSceneStore.has(k)).map(k => [k, globalThis.__warmSceneStore.get(k)]));')
            .replace('export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> {',
              'export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> { globalThis.__warmSceneStore.set(key, { blob, width, height }); return;');
        } }], build: { outDir: bundle, rollupOptions: {
          input: resolve(root, 'tests/helpers/png-pipeline-fixture.ts'), preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'fixture.js', manualChunks: () => undefined },
        } },
      });
      results.push(await run(bundle));
    }
    for (const result of results) expect(result.diagnostics).toEqual([]);
    const snapshots = (result: any) => result.samples.filter((s: any) => s.seed !== undefined);
    expect(snapshots(results[1])).toEqual(snapshots(results[0]));
    expect(snapshots(results[1])).toHaveLength(6);
    console.log('[PNG pipeline comparison]', JSON.stringify(results.map(r => r.samples)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 150000);
