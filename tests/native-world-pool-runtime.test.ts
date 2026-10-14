import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('joins actual persistent generation workers without changing geometry or nine-region decisions', async () => {
  const root = resolve(import.meta.dirname, '..'), bundle = await mkdtemp(resolve(tmpdir(), 'native-world-pool-'));
  let worker: Worker | undefined;
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: bundle, rollupOptions: { input: resolve(root, 'tests/helpers/native-world-pool-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined } } } });
    const report: any = await new Promise((done, reject) => {
      worker = new Worker(resolve(root, 'tests/helpers/watercave-scene-worker.mjs'), {
        workerData: { root, bundle, fullPixels: true, fixedDate: Date.UTC(2026, 9, 14, 12) }, stdout: true, stderr: true,
      });
      let output: any, logs = '';
      for (const stream of [worker.stdout, worker.stderr]) stream!.on('data', data => logs = (logs + data).slice(-12000));
      const timeout = setTimeout(() => { void worker?.terminate(); reject(Error('Native pool timeout\n' + logs)); }, 90000);
      worker.on('message', data => output = data);
      worker.on('error', error => { clearTimeout(timeout); reject(error); });
      worker.on('exit', code => {
        clearTimeout(timeout);
        if (code || output?.error || !output) reject(Error((output?.error ?? `Worker exit ${code}`) + '\n' + logs));
        else done(output);
      });
    });
    expect(report.diagnostics).toEqual([]); expect(report.rows).toHaveLength(6);
    for (const row of report.rows) {
      const serial = row.measured.find((m: any) => m.name === 'serial'), parallel = row.measured.find((m: any) => m.name === 'parallel');
      expect(parallel.hash, JSON.stringify(row.request)).toBe(serial.hash);
      expect(parallel.regions).toEqual(serial.regions);
      expect(parallel.regions).toHaveLength(row.request.parallelWorlds?.length === 1 ? 3 : 9);
      if (parallel.regions.length === 9) expect(parallel.timings.workers).toBe(3);
    }
    await writeFile('/tmp/noitamap-native-world-pool.json', JSON.stringify(report, null, 2));
    console.log('[Native world pool timings]', JSON.stringify(report.rows.map((row: any) => ({ request: row.request,
      samples: row.measured.map((m: any) => ({ mode: m.name, ms: Math.round(m.elapsedMs) })) }))));
  } finally { await worker?.terminate(); await rm(bundle, { recursive: true, force: true }); }
}, 120000);
