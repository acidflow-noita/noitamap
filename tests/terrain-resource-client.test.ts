import { afterEach, expect, it, vi } from 'vitest';
import { buildTerrainInWorker } from '../src/telescope/terrain-resource-client';

afterEach(() => vi.useRealTimers());
function fixture() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as any;
  const lifetime = new AbortController();
  const request = { generation: { seed: 9281 } };
  const pending = buildTerrainInWorker(worker, request, lifetime.signal);
  return { worker, lifetime, request, pending };
}

it('waits through asynchronous imports, sends once on ready and returns built resources', async () => {
  vi.useFakeTimers();
  const { worker, pending, request } = fixture();
  await vi.advanceTimersByTimeAsync(500);
  expect(worker.postMessage).not.toHaveBeenCalled();
  worker.onmessage({ data: { type: 'ready' } });
  worker.onmessage({ data: { type: 'ready' } });
  expect(worker.postMessage.mock.calls).toEqual([[request]]);
  const result = { cpu: { seed: 9281 }, hostTable: 42 };
  worker.onmessage({ data: result });
  expect(await pending).toBe(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('identifies a stalled worker phase (ready=%s) and terminates it', async ready => {
  vi.useFakeTimers();
  const { worker, pending } = fixture();
  if (ready) worker.onmessage({ data: { type: 'ready' } });
  const failure = expect(pending).rejects.toThrow(ready ? 'building resources' : 'loading its modules/assets');
  await vi.advanceTimersByTimeAsync(60_000);
  await failure;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
});

it('cancels during startup without sending the generation', async () => {
  const { worker, pending, lifetime } = fixture();
  lifetime.abort(new Error('seed changed'));
  await expect(pending).rejects.toThrow('seed changed');
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(['onerror', 'onmessageerror'])('reports %s instead of waiting for a timeout', async handler => {
  const { worker, pending } = fixture();
  worker[handler]({ message: 'module failed' });
  await expect(pending).rejects.toThrow(handler === 'onerror' ? 'module failed' : 'could not be decoded');
  expect(worker.terminate).toHaveBeenCalledOnce();
});
