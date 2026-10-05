import { expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function run(bundle: string, concurrent: boolean): Promise<any> {
  return new Promise((done, reject) => {
    const worker = new Worker(resolve(root, 'tests/helpers/generation-task-worker.mjs'), {
      workerData: { root, bundle, concurrent }, stdout: true, stderr: true,
    });
    let result: any, logs = '';
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { logs = (logs + data).slice(-8000); });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('Generation fixture timed out\n' + logs)); }, 90000);
    worker.on('message', data => { result = data; });
    worker.on('error', error => { clearTimeout(timeout); reject(error); });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code || !result || result.error) reject(new Error((result?.error || 'Worker exit ' + code) + '\n' + logs));
      else done(result);
    });
  });
}

it('preserves real generation output while letting tasks run and serializing concurrent seeds/unlocks', async () => {
  const directory = await mkdtemp('/tmp/noitamap-generation-tasks-');
  try {
    const results: any[] = [];
    for (const scheduled of [false, true]) {
      const bundle = resolve(directory, scheduled ? 'scheduled' : 'reference');
      await build({
        configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
        plugins: scheduled ? [] : [{ name: 'synchronous-generation-reference', enforce: 'pre',
          transform(code, id) {
            // Same generation algorithms and settings, with the original
            // uninterrupted execution. The reference runs seeds sequentially.
            if (id === resolve(root, 'src/telescope/generation-task.ts'))
              return 'export const yieldGenerationTask = () => Promise.resolve(); export const runGenerationTask = work => work();';
          } }],
        build: { outDir: bundle, rollupOptions: {
          input: resolve(root, 'tests/helpers/generation-task-fixture.ts'), preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'fixture.js', manualChunks: () => undefined },
        } },
      });
      results.push(await run(bundle, scheduled));
    }
    const [reference, scheduled] = results;
    expect(reference.diagnostics).toEqual([]);
    expect(scheduled.diagnostics).toEqual([]);
    expect(scheduled.snapshots).toEqual(reference.snapshots);
    expect(scheduled.snapshots).toHaveLength(6);
    expect(scheduled.snapshots.every((s: any) => s.pois > 20000 && s.scenes > 100)).toBe(true);
    expect(scheduled.stages.every((s: any) => s.inputBeforeComplete)).toBe(true);
    console.log('[Native generation task verification]', JSON.stringify({ snapshots: scheduled.snapshots, stages: scheduled.stages }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 150000);
