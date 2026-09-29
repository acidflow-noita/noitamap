import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { decode } from 'fast-png';
import { Worker as NodeWorker } from 'node:worker_threads';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSceneRenderer } from '../src/telescope/native-scene-renderer';
import { renderNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';
import { paintTerrainScene, readRGBA } from '../src/telescope/terrain-scenes';
import * as scenes from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { updateSettings } from '../lib/noita-telescope-vm/js/settings.js';

const root = resolve(import.meta.dirname, '..');
let output: string;
beforeAll(async () => {
  output = await mkdtemp(resolve(tmpdir(), 'noitamap-native-scenes-'));
  await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
    build: { outDir: output, rollupOptions: { input: resolve(root, 'src/telescope/native-scene-worker.ts'),
      output: { entryFileNames: 'scene-worker.js', manualChunks: () => undefined } } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(await readFile(
    new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url)))));
  updateSettings({ clearSpawnPixels: true, recolorMaterials: true });
  await scenes.loadPixelSceneData(); await scenes.initPixelSceneTextures();
}, 120000);
afterAll(async () => { vi.restoreAllMocks(); if (output) await rm(output, { recursive: true, force: true }); });

it('runs the built material worker without canvas/GPU globals or downloading the main archive', async () => {
  const observations: any[] = [];
  const renderer = new NativeSceneRenderer(() => {
    const native = new NodeWorker(resolve(root, 'tests/helpers/native-scene-worker-runtime.mjs'),
      { workerData: { root, output, entry: resolve(output, 'scene-worker.js') } });
    const port = { onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null, onmessageerror: null as ((event: MessageEvent) => void) | null,
      postMessage(message: unknown, transfer: Transferable[]) { native.postMessage(message, transfer as any); },
      terminate() { void native.terminate(); } };
    native.on('message', message => {
      if (message.fatal) { port.onerror?.({ message: message.fatal } as ErrorEvent); return; }
      observations.push(message); port.onmessage?.({ data: message.data } as MessageEvent);
    });
    native.on('error', error => port.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent));
    native.on('messageerror', () => port.onmessageerror?.({} as MessageEvent));
    return port;
  }, async () => { throw new Error('Native worker unexpectedly used its main-thread fallback'); });
  try {
    for (const key of ['coalmine/shop', 'vault/lab', 'general/solid_wall_hidden_cavern']) {
      const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[key];
      expect(raw).toBeTruthy(); await scenes.ensureScenePixels(raw);
      const name = key.split('/').at(-1)!;
      const scene = { key, name, x: -3102, y: 17, width: raw.width, height: raw.height,
        variantKey: `biome=${key.startsWith('general/') ? `general@${name}` : key.split('/')[0]}` };
      const source = { data: raw.imgElement, width: raw.width, height: raw.height, visualArt: raw.visualArt };
      let heartbeat = false;
      const pending = renderer.render({ scene, source, worldSize: 70 });
      setTimeout(() => { heartbeat = true; }, 0);
      const actual = decode(new Uint8Array(await (await pending).blob.arrayBuffer()));
      expect(actual.channels).toBe(4);
      const reference = renderNativeSceneBitmap(scene, source,
        (instance, pixels) => paintTerrainScene(instance, pixels, scenes), 70);
      expect(heartbeat).toBe(true);
      expect(actual.width).toBe(raw.width); expect(actual.height).toBe(raw.height);
      let mismatches = 0, opaque = 0, gold = 0;
      for (let i = 0; i < reference.length; i++) if (actual.data[i] !== reference[i]) mismatches++;
      for (let i = 0; i < reference.length; i += 4) {
        if (actual.data[i + 3]) opaque++;
        if (readRGBA(source.data, i) === 0xffebcd01 && actual.data[i + 3] === 255) gold++;
      }
      expect(mismatches, key).toBe(0); expect(opaque).toBeGreaterThan(0);
      if (name === 'solid_wall_hidden_cavern') expect(gold).toBe(628);
      expect(source.data.byteLength).toBe(raw.width * raw.height * 4);
    }
    const representativeKeys = ['coalmine/shop', 'snowcave/verticalobservatory', 'vault/lab'];
    const renderStart = performance.now();
    let nativePixels = 0, compressedBytes = 0;
    for (let n = 0; n < 100; n++) {
      const key = representativeKeys[n % representativeKeys.length];
      const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[key];
      expect(raw, key).toBeTruthy(); await scenes.ensureScenePixels(raw);
      const scene = { key, name: raw.name, x: 113 * n, y: 391 * n, width: raw.width, height: raw.height,
        variantKey: `biome=${key.split('/')[0]}` };
      const result = await renderer.render({ scene, worldSize: 70,
        source: { data: raw.imgElement, width: raw.width, height: raw.height, visualArt: raw.visualArt } });
      nativePixels += raw.width * raw.height; compressedBytes += result.blob.size;
    }
    console.info('[Native scene worker fixture]', { scenes: 100, nativePixels, compressedBytes, renderMs: Math.round(performance.now() - renderStart) });
    if (process.env.NOITAMAP_NATIVE_SCENE_BENCHMARK) {
      const placements = JSON.parse(await readFile(process.env.NOITAMAP_NATIVE_SCENE_BENCHMARK, 'utf8'));
      const began = performance.now();
      let count = 0, pixels = 0, bytes = 0;
      const missing = new Set<string>();
      for (const scene of placements) {
        if (scene.key.startsWith('static_tile/')) continue;
        const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[scene.key];
        if (!raw) { missing.add(scene.key); continue; }
        await scenes.ensureScenePixels(raw);
        const result = await renderer.render({ scene, worldSize: 70,
          source: { data: raw.imgElement, width: raw.width, height: raw.height,
            biome: raw.biome, visualArt: raw.visualArt } });
        pixels += raw.width * raw.height; bytes += result.blob.size; count++;
      }
      console.info('[Native scene world fixture]', { count, pixels, bytes, missing: [...missing],
        renderMs: Math.round(performance.now() - began) });
    }
    expect(renderer.stats).toMatchObject({ workersStarted: 1, fallbackJobs: 0 });
    if (!process.env.NOITAMAP_NATIVE_SCENE_BENCHMARK) expect(observations).toHaveLength(103);
    expect(observations.every(entry => !entry.canvasAvailable && !entry.imageAvailable)).toBe(true);
    const requests: string[] = observations.at(-1).requests;
    expect(requests.some(path => path.includes('material_atlas'))).toBe(true);
    expect(requests.filter(path => /(?:data|pixel_scenes|wang_tiles)\.zip/.test(path))).toEqual([]);
  } finally { renderer.dispose(); }
}, 60000);
