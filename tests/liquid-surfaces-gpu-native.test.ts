import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it.skipIf(process.platform !== 'linux')('levels the reported live pools with the bake rule, preserving other pixels and tile seams', async () => {
  const root = resolve(import.meta.dirname, '..'), bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-liquid-native-'));
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: bundle, rollupOptions: { input: resolve(root, 'tests/helpers/liquid-surfaces-gpu-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/terrain-pan-worker.mjs'), { workerData: { root, bundle }, stdout: true, stderr: true });
      let result: any, logs = '';
      for (const stream of [worker.stdout, worker.stderr]) stream!.on('data', data => logs = (logs + data).slice(-12000));
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Native liquids timed out\n' + logs)); }, 90000);
      worker.on('message', data => result = data); worker.on('error', reject);
      worker.on('exit', code => {
        clearTimeout(timer);
        if (code || result?.error || !result) reject(new Error((result?.error || 'Exit ' + code) + '\n' + logs));
        else done(result);
      });
    });
    await writeFile('/tmp/noitamap-liquid-native.json', JSON.stringify(result, null, 2));
    expect(result.diagnostics).toEqual([]);
    expect(result.samples).toHaveLength(9);
    expect(result.samples.filter((s: any) => s.plane === 0).every((s: any) => s.changed > 100)).toBe(true);
    for (const s of result.samples) {
      expect(s.alphaDifferences, JSON.stringify(s)).toBe(0);
      expect(s.untouchedDifferences, JSON.stringify(s)).toBe(0);
      expect(s.changedColorMaxError, JSON.stringify(s)).toBeLessThanOrEqual(2); // GL premultiplication/readback rounding
      expect(s.materialIdDifferences, JSON.stringify(s)).toBe(0);
      expect(s.seamDifferences, JSON.stringify(s)).toBe(0);
    }
    expect(result.resourceStats.liquidBytes).toBeLessThan(256 * 1024);
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 120000);
