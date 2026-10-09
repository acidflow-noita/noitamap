import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { referenceSpawnPrescan } from './helpers/spawn-prescan-reference';

const root = resolve(import.meta.dirname, '..');
function run(bundle: string): Promise<any> {
  return new Promise((done, reject) => {
    const worker = new Worker(resolve(root, 'tests/helpers/generation-task-worker.mjs'), {
      workerData: { root, bundle, concurrent: false }, stdout: true, stderr: true,
    });
    let result: any, logs = '';
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', bytes => logs = (logs + bytes).slice(-8000));
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('Prescan verification timed out\n' + logs)); }, 90000);
    worker.on('message', data => result = data);
    worker.on('error', error => { clearTimeout(timeout); reject(error); });
    worker.on('exit', code => { clearTimeout(timeout);
      if (code || !result || result.error) reject(new Error((result?.error || 'Exit ' + code) + '\n' + logs));
      else done(result);
    });
  });
}

it('preserves complete generated geometry, POIs and scenes across normal/restricted/daily/NG+/Nightmare/revisit cases', async () => {
  const temporary = await mkdtemp('/tmp/noitamap-prescan-generation-');
  try {
    const results = [];
    for (const reference of [true, false]) {
      const bundle = resolve(temporary, reference ? 'linear' : 'indexed');
      await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
        plugins: reference ? [referenceSpawnPrescan(root)] : [], build: { outDir: bundle, rollupOptions: {
          input: resolve(root, 'tests/helpers/generation-task-fixture.ts'), preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'fixture.js', manualChunks: () => undefined },
        } },
      });
      results.push(await run(bundle));
    }
    const [baseline, candidate] = results;
    expect(baseline.diagnostics).toEqual([]); expect(candidate.diagnostics).toEqual([]);
    expect(candidate.snapshots).toEqual(baseline.snapshots);
    expect(candidate.snapshots).toHaveLength(6);
    expect(candidate.snapshots.every((s: any) => s.pois > 20000 && s.scenes > 100)).toBe(true);
    expect(candidate.tileSnapshot).toEqual(baseline.tileSnapshot);
    console.log('[Prescan native output verification]', JSON.stringify(candidate.snapshots));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 150000);
