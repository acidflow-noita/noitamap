import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
let bundle: string;
beforeAll(async () => {
  bundle = await mkdtemp(resolve(tmpdir(), 'noitamap-production-gold-'));
  await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
    build: { outDir: bundle, rollupOptions: {
      input: resolve(root, 'tests/helpers/production-gold-layer-fixture.ts'), preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'fixture.js', manualChunks: () => undefined },
    } } });
}, 120000);
afterAll(async () => { if (bundle) await rm(bundle, { recursive: true, force: true }); });

it.each([
  {seed:2391,x:-3102,y:0},
  {seed:14171523,x:-4126,y:11264,camera:{x:-2810,y:211,z:1044}},
])('keeps generated hidden gold visible through production lazy scene attachment and the OSD direct drawer (seed=$seed)', async fixture => {
  const result: any = await new Promise((resolveResult, reject) => {
    const worker = new Worker(resolve(root, 'tests/helpers/production-gold-layer-worker.mjs'), {
      workerData: { root, bundle, seed: fixture.seed, camera: fixture.camera }, stdout: true, stderr: true,
    });
    let logs = '', result: any;
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { logs = (logs + data).slice(-20000); });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`Production scene draw timed out\n${logs}`)); }, 60000);
    worker.on('message', message => { result = message; });
    worker.on('error', error => { clearTimeout(timeout); reject(error); });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code || !result || result.error) reject(new Error(`${result?.error ?? `Worker exited ${code}`}\n${logs}`));
      else resolveResult(result);
    });
  });
  expect(result.gold).toEqual({ key: 'general/solid_wall_hidden_cavern', x: fixture.x, y: fixture.y });
  expect(result.scenes).toBeGreaterThan(10000);
  expect(result.directGold).toBe(628);
  expect(result.goldCells).toBe(628);
  expect(result.shownGold).toBe(628);
  expect(result.colors.length).toBeGreaterThan(1);
  expect(result.tiles).toHaveLength(4);
  expect(result.stats.viewport.failed).toBe(false);
  expect(result.stats.viewport.pending).toBe(0);
  expect(result.stats.viewport.bytes).toBeLessThanOrEqual(result.stats.viewport.maxBytes);
  expect(result.stats.bitmapCache.loadedScenes).toBeLessThan(300);
  expect(result.frames.at(-1)).toMatchObject({ name: 'native-stash-after-zoom', stats: { level: 0, pending: 0 } });
  expect(result.frames.at(-1).stats.nativeBytes).toBeGreaterThan(0);
  if (fixture.camera) {
    // This URL covers a possible cavern cell. Its captured base image contains
    // the other seed's room; the selected seed correctly owns solid EDR here.
    expect(result.cameraAudit.biomeColor).toBe(0xff42244d);
    expect(result.cameraAudit.owner).toBe('solid_wall_hidden_cavern');
    expect(result.cameraAudit.scenes.some((scene: any) =>
      scene.key === 'general/solid_wall_hidden_cavern' || scene.name === 'secret_lab')).toBe(false);
    expect(result.frames[0]).toMatchObject({ name: 'reported-camera', stats: { pending: 0, failed: false } });
    expect(result.frames[0].width).toBeCloseTo(2 ** (fixture.camera.z / 100));
  }
}, 120000);
