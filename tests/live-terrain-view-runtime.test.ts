import { it, expect } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync } from 'node:fs';

it.skipIf(process.platform !== 'linux').each([
  { seed: 9281, parallelWorlds: [-1, 0, 1], x: -3060, y: 3548, cachedLayers: false },
  { cpu: true, seed: 92, parallelWorlds: [-1, 0, 1], x: -3060, y: 3548, cachedLayers: true },
  { seed: 16981, parallelWorlds: [0], x: -800, y: 6980, cachedLayers: false },
  { seed: 92, parallelWorlds: [-1, 0, 1], x: -3060, y: 3548, cachedLayers: true },
])('renders seed $seed cpu=$cpu using actual TerrainView at full detail, zoomed out and revisited', async scenario => {
  const root = resolve(import.meta.dirname, '..');
  const bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-live-view-'));
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', build: {
      outDir: bundle, rollupOptions: { input: {
        live: resolve(root, 'tests/helpers/live-terrain-view.ts'),
        config: resolve(root, 'lib/noita-telescope-vm/js/generator_config.js'),
      }, preserveEntrySignatures: 'strict', output: { entryFileNames: '[name].js' } },
    } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, 'tests/helpers/live-terrain-view.mjs'), { workerData: {
        ...scenario, root, bundle, entry: resolve(bundle, 'live.js'), configEntry: resolve(bundle, 'config.js'),
      }, stdout: true, stderr: true });
      let logs = '', message: any;
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Live renderer timeout\n' + logs.slice(-8000))); }, 150_000);
      worker.stdout!.on('data', value => { logs += value; appendFileSync(resolve(bundle, 'runtime.log'), value); }); worker.stderr!.on('data', value => { logs += value; appendFileSync(resolve(bundle, 'runtime.log'), value); });
      worker.on('message', value => { message = value; });
      worker.on('error', reject);
      worker.on('exit', code => { clearTimeout(timer); message && !message.error && code === 0 ? done(message) : reject(new Error((message?.error ?? `Exit ${code}`) + '\n' + logs.slice(-8000))); });
    });
    if (result.cpu) expect(result.refusedContexts).toBe(4);
    if (!result.cpu) {
    expect(result.frames).toHaveLength(3);
    for (const frame of result.frames) { expect(frame.colors).toBeGreaterThan(5); expect(frame.visible).toBeGreaterThan(100); }
    expect(result.frames[0].hash).toBe(result.frames[2].hash);
    }
    if (scenario.seed === 92) {
      expect(result.overview.colors).toBeGreaterThan(100);
      expect(result.overview.visible).toBeGreaterThan(10000);
    }
    console.log('[TerrainView native]', JSON.stringify(result));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 210_000);
