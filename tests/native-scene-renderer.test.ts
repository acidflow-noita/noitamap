import { afterEach, expect, it, vi } from 'vitest';
import { NativeSceneRenderer, clearNativeSceneRenderers } from '../src/telescope/native-scene-renderer';
import type { NativeSceneRenderInput } from '../src/telescope/native-scene-worker-core';

const input = (): NativeSceneRenderInput => ({
  scene: { key: 'coalmine/room', name: 'room', width: 1, height: 1, x: -512, y: 500 },
  source: { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]),
    visualArt: { width: 1, height: 1, data: new Uint8Array([5, 6, 7, 255]) },
    backgroundArt: { width: 1, height: 1, data: new Uint8Array([8, 9, 10, 255]) } },
  backdrop: { width: 1, height: 1, data: new Uint8ClampedArray([11, 12, 13, 255]) }, worldSize: 70,
});
const encoded = () => ({ png: new Uint8Array([1, 2, 3]), width: 1, height: 1 });
function factory() {
  const workers: any[] = [];
  return { workers, create: () => {
    const worker: any = { onmessage: null, onerror: null, onmessageerror: null,
      messages: [] as any[], terminate: vi.fn(), postMessage(message: any, transfer: any[]) {
        this.messages.push(structuredClone(message, { transfer }));
      }, reply(extra = {}) { this.onmessage?.({ data: { id: this.messages.at(-1).id, ...encoded(), ...extra } }); } };
    workers.push(worker); return worker;
  } };
}
afterEach(() => { clearNativeSceneRenderers(); vi.restoreAllMocks(); });

it('serializes transfer admission and never detaches caller-owned material/art buffers', async () => {
  const f = factory(), renderer = new NativeSceneRenderer(f.create), source = input();
  const one = renderer.render(source), two = renderer.render(source);
  expect(f.workers).toHaveLength(1); expect(f.workers[0].messages).toHaveLength(1);
  const admitted = f.workers[0].messages[0].input;
  expect([...admitted.source.data]).toEqual([...source.source.data]);
  expect([...admitted.source.visualArt.data]).toEqual([...source.source.visualArt!.data]);
  expect([...admitted.source.backgroundArt.data]).toEqual([...source.source.backgroundArt!.data]);
  expect([...admitted.backdrop.data]).toEqual([...source.backdrop!.data]);
  expect(source.source.data.byteLength).toBe(4);
  expect(source.source.visualArt!.data.byteLength).toBe(4);
  f.workers[0].reply(); expect((await one).blob.type).toBe('image/png');
  expect(f.workers[0].messages).toHaveLength(2);
  f.workers[0].reply(); await two;
  expect(renderer.stats).toMatchObject({ active: false, queued: 0, workersStarted: 1 });
});

it('cancels queued scenes before transfer and kills active CPU work on cancellation', async () => {
  const f = factory(), renderer = new NativeSceneRenderer(f.create);
  const active = new AbortController(), queued = new AbortController();
  const one = renderer.render(input(), active.signal), two = renderer.render(input(), queued.signal), three = renderer.render(input());
  const oneRejected = expect(one).rejects.toMatchObject({ name: 'AbortError' });
  const twoRejected = expect(two).rejects.toMatchObject({ name: 'AbortError' });
  queued.abort(); await twoRejected; expect(f.workers[0].messages).toHaveLength(1);
  active.abort(); await oneRejected;
  expect(f.workers[0].terminate).toHaveBeenCalledOnce();
  expect(f.workers).toHaveLength(2); expect(f.workers[1].messages).toHaveLength(1);
  f.workers[1].reply(); await three;
});

it('rejects native composition failures without falling back to raw artwork and continues the queue', async () => {
  const f = factory(), fallback = vi.fn(), renderer = new NativeSceneRenderer(f.create, fallback);
  const one = renderer.render(input()), two = renderer.render(input());
  const rejected = expect(one).rejects.toThrow('Bad material');
  f.workers[0].reply({ error: 'Bad material' }); await rejected;
  f.workers[0].reply(); await two;
  expect(fallback).not.toHaveBeenCalled();
});

it.each(['creation', 'startup', 'message'])('uses the same CPU material pipeline if worker %s is unavailable', async failure => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = factory(), fallback = vi.fn(async () => encoded());
  const renderer = new NativeSceneRenderer(failure === 'creation' ? () => { throw new Error('Worker denied'); } : f.create, fallback);
  const one = renderer.render(input()), two = renderer.render(input());
  if (failure === 'startup') f.workers[0].onerror({ message: 'Worker blocked', preventDefault() {} });
  if (failure === 'message') f.workers[0].onmessageerror({});
  expect(fallback).not.toHaveBeenCalled(); // an actual task yield precedes CPU fallback
  await one; await two;
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(renderer.stats.fallbackJobs).toBe(2);
});

it('disposes queued work and ignores a stale completion after generation retirement', async () => {
  const f = factory(), renderer = new NativeSceneRenderer(f.create);
  const one = renderer.render(input()), two = renderer.render(input());
  const rejected = Promise.all([expect(one).rejects.toMatchObject({ name: 'AbortError' }),
    expect(two).rejects.toMatchObject({ name: 'AbortError' })]);
  const late = f.workers[0].onmessage;
  clearNativeSceneRenderers(); await rejected;
  late({ data: { id: 1, ...encoded() } });
  await expect(renderer.render(input())).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.workers[0].terminate).toHaveBeenCalledOnce();
  expect(renderer.stats).toMatchObject({ queued: 0, active: false });
});
