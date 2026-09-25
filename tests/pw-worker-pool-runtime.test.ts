import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe.sequential('persistent PW worker output parity with fresh workers', () => {
  const root = resolve(import.meta.dirname, '..');
  let bundle: string;
  beforeAll(async () => {
    bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-pw-pool-'));
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: bundle, rollupOptions: { input: resolve(root, 'tests/helpers/pw-pool-runtime-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } } });
  }, 120000);
  afterAll(async () => { if (bundle) await rm(bundle, { recursive: true, force: true }); });
  for (const fullPixels of [false, true]) it(`${fullPixels ? 'render-perf' : 'legacy'} seeds42→43→42 and all→none→all unlocks`, async () => {
    const result: any = await new Promise((resolveResult, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/pw-pool-runtime-worker.mjs'), { workerData: { root, bundle, fullPixels }, stdout: true, stderr: true });
      let logs = '', result: any;
      worker.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
      worker.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`PW pool timed out\n${logs}`)); }, 120000);
      worker.on('message', message => { result = message; });
      worker.on('error', error => { clearTimeout(timeout); reject(error); });
      worker.on('exit', code => { clearTimeout(timeout);
        if (code || result?.error || !result) reject(new Error(`${result?.error || `Worker exited ${code}`}\n${logs}`));
        else resolveResult(result); });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.stats).toMatchObject({ workers: 2, busy: 0, queued: 0, sceneSnapshots: 0, completed: 6 });
    expect(result.metrics).toHaveLength(3);
    expect(result.metrics[0].hashes).toEqual(result.metrics[2].hashes);
    console.log('[Persistent PW pool native benchmark]', JSON.stringify(result));
  }, 150000);
});
