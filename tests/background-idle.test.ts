import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundAssetYield, prepareAssetJobs } from '../src/telescope/background-idle';

function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function idleFixture() {
  let sequence = 0;
  const callbacks = new Map<number, IdleRequestCallback>();
  const request = vi.fn((callback: IdleRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  vi.stubGlobal('requestIdleCallback', request);
  vi.stubGlobal('cancelIdleCallback', cancel);
  return {
    callbacks, request, cancel,
    run() {
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback({ didTimeout: false, timeRemaining: () => 20 });
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('optional asset task yielding', () => {
  it('waits for an idle opportunity and releases its signal listener afterward', async () => {
    const idle = idleFixture(), controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const done = vi.fn();
    const result = backgroundAssetYield(controller.signal).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(idle.request).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
    idle.run(); await result;
    expect(done).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(idle.cancel).toHaveBeenCalledOnce();
  });

  it('does not schedule an idle task for an already-promoted signal', async () => {
    const idle = idleFixture(), controller = new AbortController();
    controller.abort();
    await backgroundAssetYield(controller.signal);
    expect(idle.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('releases the timer fallback normally or by promotion (promoted=%s)', async promoted => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
    const controller = new AbortController(), done = vi.fn();
    const result = backgroundAssetYield(controller.signal).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    if (promoted) controller.abort();
    else await vi.advanceTimersByTimeAsync(0);
    await result;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('shared background asset loading', () => {
  it('loads only one job per idle opportunity and waits for the final job', async () => {
    const idle = idleFixture(), controller = new AbortController();
    const waits = [deferred(), deferred(), deferred()];
    const load = vi.fn((job: number) => waits[job].promise), done = vi.fn();
    const result = prepareAssetJobs([0, 1, 2], load, controller.signal).then(done);
    expect(load).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      expect(idle.callbacks.size).toBe(1);
      idle.run(); await Promise.resolve();
      expect(load.mock.calls).toEqual(Array.from({ length: i + 1 }, (_, n) => [n]));
      expect(idle.callbacks.size).toBe(0);
      expect(done).not.toHaveBeenCalled();
      waits[i].resolve(); await Promise.resolve();
    }
    await result;
    expect(done).toHaveBeenCalledOnce();
    expect(idle.request).toHaveBeenCalledTimes(3);
  });

  it.each(['idle', 'loading'] as const)('promotes shared work to eight slots while %s and awaits every unique job', async phase => {
    const idle = idleFixture(), controller = new AbortController();
    const jobs = Array.from({ length: 12 }, (_, n) => n), waits = jobs.map(deferred);
    let active = 0, maximum = 0;
    const load = vi.fn(async (job: number) => {
      active++; maximum = Math.max(maximum, active);
      await waits[job].promise;
      active--;
    });
    const done = vi.fn();
    const result = prepareAssetJobs(jobs, load, controller.signal).then(done);
    if (phase === 'loading') { idle.run(); await Promise.resolve(); expect(active).toBe(1); }
    controller.abort();
    await Promise.resolve();
    expect(active).toBe(8);
    expect(load).toHaveBeenCalledTimes(8);
    expect(idle.callbacks.size).toBe(0);
    // Finish out of order so the last returned promise is not a proxy for
    // completion of the whole pool. Four queued jobs fill the released slots.
    for (const job of [7, 5, 3, 1]) waits[job].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(12);
    expect(new Set(load.mock.calls.map(([job]) => job)).size).toBe(12);
    expect(maximum).toBe(8);
    for (const job of jobs.filter(job => job !== 0)) waits[job].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    expect(active).toBe(1);
    waits[0].resolve(); await result;
    expect(done).toHaveBeenCalledOnce();
    expect(active).toBe(0);
    expect(idle.request).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'promoted'] as const)('uses foreground capacity without idle scheduling (%s)', async mode => {
    const idle = idleFixture(), controller = new AbortController();
    controller.abort();
    const waits = Array.from({ length: 9 }, deferred);
    const load = vi.fn((job: number) => waits[job].promise);
    const result = prepareAssetJobs(waits.map((_, n) => n), load,
      mode ? controller.signal : undefined);
    expect(load).toHaveBeenCalledTimes(8);
    expect(idle.request).not.toHaveBeenCalled();
    for (const wait of waits) wait.resolve();
    await result;
    expect(load).toHaveBeenCalledTimes(9);
  });

  it.each([new Error('decode failed'), undefined, null, 0])('propagates any rejection value and stops queued jobs (%s)', async reason => {
    const jobs = Array.from({ length: 12 }, (_, n) => n), waits = jobs.map(deferred);
    const load = vi.fn((job: number) => waits[job].promise);
    const result = prepareAssetJobs(jobs, load);
    const rejected = expect(result).rejects.toBe(reason);
    waits[0].reject(reason);
    await rejected;
    for (const wait of waits.slice(1)) wait.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(8);
  });

  it('propagates a failed idle wait without starting any decoder', async () => {
    const controller = new AbortController(), error = new Error('idle failed');
    const load = vi.fn(async () => {});
    await expect(prepareAssetJobs([1, 2], load, controller.signal,
      async () => { throw error; })).rejects.toBe(error);
    expect(load).not.toHaveBeenCalled();
    controller.abort();
    expect(load).not.toHaveBeenCalled();
  });

  it('finishes empty input without installing a lasting promotion listener', async () => {
    const idle = idleFixture(), controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const load = vi.fn(async () => {});
    await prepareAssetJobs([], load, controller.signal);
    controller.abort();
    expect(load).not.toHaveBeenCalled();
    expect(idle.request).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
