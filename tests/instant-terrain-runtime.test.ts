import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe.skipIf(process.platform !== 'linux')('production instant-terrain tile source with native GLES', () => {
  const root = resolve(import.meta.dirname, '..');
  let bundle: string;
  beforeAll(async () => {
    bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-instant-runtime-'));
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: bundle, rollupOptions: { input: resolve(root, 'tests/helpers/instant-terrain-runtime-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } } });
  }, 120000);
  afterAll(async () => { if (bundle) await rm(bundle, { recursive: true, force: true }); });
  it('matches direct shader pixels at overview/detail across three worlds, with ownership, sparse scenes and cancellation', async () => {
    const result: any = await new Promise((resolveResult, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/instant-terrain-runtime-worker.mjs'), {
        workerData: { root, bundle }, stdout: true, stderr: true,
      });
      let logs = '', result: any;
      worker.stdout.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
      worker.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`Native runtime timed out\n${logs}`)); }, 120000);
      worker.on('message', message => { result = message; });
      worker.on('error', error => { clearTimeout(timeout); reject(error); });
      worker.on('exit', code => {
        clearTimeout(timeout);
        if (code || result?.error || !result) reject(new Error(`${result?.error || `Native runtime exited ${code}`}\n${logs}`));
        else resolveResult(result);
      });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.samples).toHaveLength(6);
    expect(result.rendererUploads).toBe(2); // One shared upload per lifecycle, including masked rerender.
    expect(result.samples.every((sample: any) => sample.draws === 1 && sample.visible > 25)).toBe(true);
    expect(result.comparedPixels).toBeGreaterThan(200_000);
    expect(result.reuse).toMatchObject({ requests: 12, shaderDraws: 0 });
    expect(result.reuse.comparedPixels).toBeGreaterThan(200_000);
    expect(result.sparseMaskPreserved).toBe(true);
    expect(result.cancellationPreserved).toBe(true);
    expect(result.firstPaintEvents).toBe(1);
    expect(result.failures).toBe(0);
    console.log('[Instant terrain actual TileSource native verification]', JSON.stringify(result));
  }, 150000);
});
