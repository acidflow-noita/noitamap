import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerationCheckpoint, runGenerationTask, yieldGenerationTask } from '../src/telescope/generation-task';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generation task boundaries', () => {
  it('only yields after its work budget and restarts the budget after resuming', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let resume!: () => void;
    const yieldTask = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
    vi.stubGlobal('scheduler', { yield: yieldTask });
    const checkpoint = createGenerationCheckpoint();
    for (now = 0; now < 8; now++) expect(checkpoint()).toBeUndefined();
    expect(yieldTask).not.toHaveBeenCalled();
    const pending = checkpoint();
    expect(yieldTask).toHaveBeenCalledOnce();
    now = 100; // Time spent waiting for input/painting is not generator work.
    resume(); await pending;
    now = 107; expect(checkpoint()).toBeUndefined();
    now = 108;
    const next = checkpoint();
    expect(yieldTask).toHaveBeenCalledTimes(2);
    resume(); await next;
  });

  it('uses the browser scheduler without adding a timer delay', async () => {
    const yieldTask = vi.fn(async () => {});
    vi.stubGlobal('scheduler', { yield: yieldTask });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      await yieldGenerationTask();
      expect(yieldTask).toHaveBeenCalledOnce();
      expect(timeout).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  it('leaves the microtask chain and closes both fallback message ports', async () => {
    vi.stubGlobal('scheduler', undefined);
    let channel: any;
    vi.stubGlobal('MessageChannel', class {
      port1 = { onmessage: null as any, close: vi.fn() };
      port2 = { postMessage: vi.fn(), close: vi.fn() };
      constructor() { channel = this; }
    });
    let resumed = false;
    const wait = yieldGenerationTask().then(() => { resumed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(channel.port2.postMessage).toHaveBeenCalledOnce();
    channel.port1.onmessage();
    await wait;
    expect(resumed).toBe(true);
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port2.close).toHaveBeenCalledOnce();
  });

  it('supports environments with neither task API', async () => {
    vi.stubGlobal('scheduler', undefined);
    vi.stubGlobal('MessageChannel', undefined);
    vi.useFakeTimers();
    try {
      let resumed = false;
      const wait = yieldGenerationTask().then(() => { resumed = true; });
      await Promise.resolve();
      expect(resumed).toBe(false);
      await vi.runAllTimersAsync();
      await wait;
      expect(resumed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('allows an input task while keeping a second seed away from shared state', async () => {
    let resume!: () => void;
    let yielded!: () => void;
    const paused = new Promise<void>(resolve => { yielded = resolve; });
    vi.stubGlobal('scheduler', { yield: () => new Promise<void>(resolve => { resume = resolve; yielded(); }) });
    let unlocks = '';
    const events: string[] = [];
    const first = runGenerationTask(async () => {
      unlocks = 'all'; events.push('first-start');
      await yieldGenerationTask();
      events.push(`first-finish-${unlocks}`);
      return 1;
    });
    const second = runGenerationTask(async () => {
      unlocks = 'restricted'; events.push('second');
      return 2;
    });
    await paused;
    events.push('input');
    expect(unlocks).toBe('all');
    expect(events).toEqual(['first-start', 'input']);
    resume();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first-start', 'input', 'first-finish-all', 'second']);
  });

  it('releases shared state after failure so the next seed can generate', async () => {
    const failure = new Error('bad generation');
    const failed = runGenerationTask(async () => { throw failure; });
    const next = runGenerationTask(async () => 42);
    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe(42);
  });
});
