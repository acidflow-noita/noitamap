import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { LiveTerrainClient } from '../src/telescope/live-terrain-client';
import { LiveTerrainUnavailable } from '../src/telescope/live-terrain-error';

class TestWorker {
  static latest: TestWorker;
  onmessage: any; onerror: any; onmessageerror: any;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { TestWorker.latest = this; }
  reply(data: any) { this.onmessage({ data }); }
}
const gen = { seed: 1, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array() }, pois: 'not a render input' };
const bounds = { x: 0, y: 0, width: 1, height: 1 };
let client: LiveTerrainClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  client = new LiveTerrainClient(gen);
});
afterEach(() => { client.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('waits for worker readiness and displays progress before detail finishes', async () => {
  const worker = TestWorker.latest, show = vi.fn();
  const pending = client.render(bounds, 1, new AbortController().signal, show);
  expect(worker.postMessage).not.toHaveBeenCalled();
  worker.reply({ type: 'ready' }); await Promise.resolve();
  expect(worker.postMessage.mock.calls.map(([data]) => data.type)).toEqual(['init', 'render']);
  expect(worker.postMessage.mock.calls[0][0].generation).not.toHaveProperty('pois');
  const frame = { type: 'frame', id: 1, width: 1, height: 1, pixels: new Uint8Array([23, 45, 67, 255]).buffer };
  worker.reply(frame);
  expect(show).toHaveBeenCalledOnce();
  worker.reply({ ...frame, done: true });
  const result = await pending;
  expect([...result.getContext('2d')!.getImageData(0, 0, 1, 1).data]).toEqual([23, 45, 67, 255]);
});
it('cancels immediately and closes stale transferred images', async () => {
  const worker = TestWorker.latest, control = new AbortController(), show = vi.fn();
  worker.reply({ type: 'ready' });
  const pending = client.render(bounds, 1, control.signal, show);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); control.abort(); await rejection;
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel', id: 1 });
  const bitmap = { close: vi.fn() }; worker.reply({ type: 'frame', id: 1, bitmap });
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled();
});
it('preserves WebGL unavailability as a typed CPU fallback signal', async () => {
  const worker = TestWorker.latest; worker.reply({ type: 'ready' });
  const pending = client.render(bounds, 1, new AbortController().signal);
  const rejection = expect(pending).rejects.toBeInstanceOf(LiveTerrainUnavailable);
  await Promise.resolve(); worker.reply({ type: 'error', id: 1, unavailable: true, error: 'WebGL2 refused' });
  await rejection;
  await expect(client.render(bounds, 1, new AbortController().signal)).rejects.toBeInstanceOf(LiveTerrainUnavailable);
});
it('rejects a worker startup failure without leaving a renderer request hanging', async () => {
  const pending = client.render(bounds, 1, new AbortController().signal);
  const rejection = expect(pending).rejects.toThrow('failed to start');
  await vi.advanceTimersByTimeAsync(60000); await rejection;
  expect(TestWorker.latest.terminate).toHaveBeenCalled();
});
