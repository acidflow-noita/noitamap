import { expect, it, vi } from 'vitest';
vi.mock('../src/telescope/daily-asset-worker?worker', () => ({ default: class {} }));
import { prepareDailyAssetsOffThread } from '../src/telescope/daily-asset-worker-client';

function fakeWorker() {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as any, onerror: null as any, onmessageerror: null as any };
}
const request = { baseUrl: 'https://maps.test/', fullPixels: true };

it('returns worker completion without transferring or cloning decoded worlds onto the main thread', async () => {
  const worker = fakeWorker(), controller = new AbortController(), failures = vi.fn();
  const ready = prepareDailyAssetsOffThread(request, controller.signal, failures, () => worker as any);
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(request);
  worker.onmessage({ data: { type: 'failure', asset: 'atlas', error: 'quota' } });
  expect(failures).toHaveBeenCalledOnce();
  const result = { type: 'done', prepared: 4, failures: 1, elapsedMs: 20 };
  worker.onmessage({ data: result });
  expect(await ready).toEqual(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
  controller.abort();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('terminates optional preparation immediately when foreground navigation takes over', async () => {
  const worker = fakeWorker(), controller = new AbortController();
  const ready = prepareDailyAssetsOffThread(request, controller.signal, vi.fn(), () => worker as any);
  controller.abort(new Error('replaced'));
  await expect(ready).rejects.toThrow('replaced');
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('fails without attempting a UI-thread fallback when worker startup is unavailable', async () => {
  await expect(prepareDailyAssetsOffThread(request, new AbortController().signal, vi.fn(), () => {
    throw new Error('worker denied');
  })).rejects.toThrow('worker denied');
});

it('cleans up workers after runtime or message deserialization failures', async () => {
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const worker = fakeWorker();
    const ready = prepareDailyAssetsOffThread(request, new AbortController().signal, vi.fn(), () => worker as any);
    worker[event]({ message: 'failed' });
    await expect(ready).rejects.toThrow();
    expect(worker.terminate).toHaveBeenCalledOnce();
  }
});
