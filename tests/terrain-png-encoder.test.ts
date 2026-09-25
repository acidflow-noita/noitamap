import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { Worker as NodeWorker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TerrainPngEncoder, clearTerrainPngEncoders } from '../src/telescope/terrain-png-encoder';
import { rgbaToPngBlob, decodePngToRgba } from '../src/telescope/png-decode';

describe('terrain PNG encoder lifecycle', () => {
  it('rejects unavailable workers without transferring source pixels', async () => {
    const pixels = new Uint8Array([1, 2, 3, 255]);
    const encoder = new TerrainPngEncoder(() => { throw new Error('Worker blocked'); });
    await expect(encoder.encode(pixels, 1, 1)).rejects.toThrow('Worker blocked');
    expect([...pixels]).toEqual([1, 2, 3, 255]);
    encoder.dispose();
  });
  it('cancels pending work, preserves source bytes and rejects later work', async () => {
    let terminated = 0, posted: any;
    const worker = { onmessage: null, onerror: null, postMessage(message: unknown) { posted = message; }, terminate() { terminated++; } };
    const encoder = new TerrainPngEncoder(() => worker);
    const pixels = new Uint8Array([1, 2, 3, 255]);
    const pending = encoder.encode(pixels, 1, 1);
    expect(posted.pixels.buffer).not.toBe(pixels.buffer);
    clearTerrainPngEncoders();
    await expect(pending).rejects.toThrow('disposed');
    await expect(encoder.encode(pixels, 1, 1)).rejects.toThrow('disposed');
    expect(terminated).toBe(1);
    expect([...pixels]).toEqual([1, 2, 3, 255]);
  });
});

describe('production PNG encoder in a native worker thread', () => {
  const root = resolve(import.meta.dirname, '..');
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(resolve(tmpdir(), 'noitamap-png-worker-'));
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', publicDir: false,
      build: { outDir: output, rollupOptions: { input: resolve(root, 'src/telescope/terrain-png-worker.ts'), output: { entryFileNames: 'png.js', manualChunks: () => undefined } } } });
  }, 120000);
  afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });
  it('produces identical PNG bytes and decoded pixels while the UI thread can continue', async () => {
    let native: NodeWorker;
    const encoder = new TerrainPngEncoder(() => {
      native = new NodeWorker(`
        const { parentPort, workerData } = require('node:worker_threads');
        globalThis.self = { postMessage(data, options) { parentPort.postMessage(data, options?.transfer); } };
        import(workerData.entry).then(() => parentPort.on('message', data => self.onmessage({ data })));
      `, { eval: true, workerData: { entry: pathToFileURL(resolve(output, 'png.js')).href } });
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage(message: unknown, transfer: Transferable[]) { native.postMessage(message, transfer as any); }, terminate() { void native.terminate(); } };
      native.on('message', data => port.onmessage?.({ data } as MessageEvent));
      native.on('error', error => port.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent));
      return port;
    });
    try {
      const width = 3200, height = 2400;
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = (i >>> 7) % 256; pixels[i + 1] = (i >>> 13) % 256; pixels[i + 2] = i % 251; pixels[i + 3] = 255;
      }
      const start = performance.now();
      const pending = encoder.encode(pixels, width, height);
      const submitMs = performance.now() - start;
      let timerRan = false;
      setTimeout(() => { timerRan = true; }, 0);
      const result = await pending;
      const workerWallMs = performance.now() - start;
      expect(timerRan).toBe(true);
      const referenceStart = performance.now();
      const reference = await rgbaToPngBlob(pixels, width, height);
      const localBlockingMs = performance.now() - referenceStart;
      const encoded = new Uint8Array(await result.arrayBuffer());
      const expected = new Uint8Array(await reference.arrayBuffer());
      expect(encoded.byteLength).toBe(expected.byteLength);
      expect(encoded.every((value, index) => value === expected[index])).toBe(true);
      const decoded = decodePngToRgba(await result.arrayBuffer());
      expect(decoded.width).toBe(width); expect(decoded.height).toBe(height);
      // Byte comparison outside an assertion avoids printing huge arrays on failure.
      expect(decoded.data.every((value, index) => value === pixels[index])).toBe(true);
      expect(pixels.byteLength).toBe(width * height * 4);
      console.log('[Terrain PNG worker native benchmark]', JSON.stringify({ pixels: width * height, submitMs, workerWallMs, localBlockingMs }));
    } finally { encoder.dispose(); }
  }, 60000);
});
