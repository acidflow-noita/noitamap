import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ApproximateCompositeReuse, canShareApproximateComposites } from '../src/telescope/approximate-composite-reuse';

describe('approximate horizontal-world composite reuse', () => {
  const blob = new Blob(['same terrain']);
  const geometry = { blob, minX: -18020, minY: -7168, osdWidth: 36000 };
  it('shares only NG0 Wang-only terrain, preserving per-world noisy fill edges', () => {
    expect(canShareApproximateComposites({ isNGP: false, worldSize: 70, tileLayers: [{}] })).toBe(true);
    expect(canShareApproximateComposites({ isNGP: false, worldSize: 70, tileLayers: [{ isFill: true }] })).toBe(false);
    expect(canShareApproximateComposites({ isNGP: true, worldSize: 64, tileLayers: [{}] })).toBe(false);
    expect(canShareApproximateComposites({ isNGP: false, worldSize: 64, tileLayers: [{}] })).toBe(false);
  });
  it('reuses bytes at exact translated positions and isolates vertical planes', () => {
    const cache = new ApproximateCompositeReuse(35840, true);
    cache.remember(0, 0, geometry);
    for (const pw of [-2, -1, 0, 1, 2]) {
      expect(cache.get(pw, 0)).toEqual({ ...geometry, minX: geometry.minX + pw * 35840 });
      expect(cache.get(pw, 0)!.blob).toBe(blob);
      expect(cache.get(pw, -1)).toBeUndefined();
    }
  });
  it('reuses an older side-world cache entry when the main-world entry is absent', () => {
    const cache = new ApproximateCompositeReuse(35840, true);
    cache.remember(-1, 1, { ...geometry, minX: geometry.minX - 35840 });
    expect(cache.get(0, 1)).toEqual(geometry);
    expect(cache.get(1, 1)).toEqual({ ...geometry, minX: geometry.minX + 35840 });
  });
  it('keeps NG+ and nightmare worlds independent', () => {
    const cache = new ApproximateCompositeReuse(36864, false);
    cache.remember(1, 0, geometry);
    expect(cache.get(1, 0)).toEqual(geometry);
    expect(cache.get(0, 0)).toBeUndefined();
    expect(cache.get(-1, 0)).toBeUndefined();
  });
});

describe.sequential('real approximate terrain pixel parity and native timing', () => {
  const root = resolve(import.meta.dirname, '..');
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(resolve(tmpdir(), 'noitamap-composite-parity-'));
    await build({
      configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: output, rollupOptions: {
        input: resolve(root, 'tests/helpers/approximate-composite-fixture.ts'),
        preserveEntrySignatures: 'strict', output: { entryFileNames: 'fixture.js', manualChunks: () => undefined },
      } },
    });
  }, 120000);
  afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });
  for (const seed of [42, 786433191]) {
    it(`preserves every decoded pixel and placement across all nine regions, seed ${seed}`, async () => {
      const result: any = await new Promise((resolveResult, reject) => {
        const worker = new Worker(resolve(root, 'tests/helpers/telescope-worker-runtime.mjs'), {
          workerData: { root, output, entry: resolve(output, 'fixture.js'), mode: 'fixture', fullPixels: false, seed },
          stdout: true, stderr: true,
        });
        let logs = '', result: any;
        worker.stdout.on('data', chunk => { logs += chunk; });
        worker.stderr.on('data', chunk => { logs += chunk; });
        const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`Composite fixture timed out\n${logs}`)); }, 90000);
        worker.on('error', reject);
        worker.on('message', message => { result = message; });
        worker.on('exit', code => {
          clearTimeout(timeout);
          if (code || result?.type === 'fatal' || !result) reject(new Error(`${result?.error || `Fixture exited ${code}`}\n${logs}`));
          else resolveResult(result);
        });
      });
      expect(result.missing).toEqual([]);
      expect(result.data.reference.renders).toBe(9);
      expect(result.data.reference.encodes).toBe(9);
      expect(result.data.shared.renders).toBe(3);
      expect(result.data.shared.encodes).toBe(3);
      expect(result.data.shared.encodedBytes * 3).toBe(result.data.reference.encodedBytes);
      expect(result.data.reference.comparedPixels).toBeGreaterThan(40_000_000);
      expect(result.data.shared.comparedPixels).toBeGreaterThan(40_000_000);
      console.log('[Approximate composite native benchmark]', JSON.stringify(result.data));
    }, 120000);
  }
});
