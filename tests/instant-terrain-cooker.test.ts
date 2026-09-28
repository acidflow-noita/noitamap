import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstantTerrainCooker, type CookSource } from '../src/telescope/instant-terrain-cooker';

let controller: AbortController;
let page: EventTarget & { hidden: boolean };
const completionLogs = () => vi.mocked(console.info).mock.calls.filter(([message]) =>
  String(message).startsWith('[Instant terrain] Full map terrain finished'));
const startLogs = () => vi.mocked(console.info).mock.calls.filter(([message]) =>
  message === '[Instant terrain] Native terrain cooking started');
beforeEach(() => {
  vi.useFakeTimers();
  controller = new AbortController();
  page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', page);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  controller.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(timing: { startedAt?: number; seed?: number } = {}) {
  let persistent = true, view = 0;
  const visited: string[] = [];
  const flush = vi.fn(async () => {}), failure = vi.fn();
  const cooker = createInstantTerrainCooker({
    signal: controller.signal,
    priority: (source, x, y) => Math.hypot(source.instantRegion.x + x * 512 - view, source.instantRegion.y + y * 512),
    viewKey: () => String(view), persistent: () => persistent, flush, onFailure: failure,
    ...timing,
  });
  function source(id: number, width = 1024, height = 512): CookSource {
    return { instantRegion: { x: id * 4096, y: 0, width, height },
      prepareNativeTile: vi.fn(async (x, y) => { visited.push(`${id}/${x}/${y}`); }),
    };
  }
  return { cooker, visited, flush, failure, source,
    loseStorage: () => { persistent = false; }, move: (x: number) => { view = x; } };
}

function messageTaskFixture() {
  const tasks: (() => void)[] = [];
  const channels: TestChannel[] = [];
  class TestChannel {
    port1 = { onmessage: null as (() => void) | null, close: vi.fn() };
    port2 = {
      close: vi.fn(),
      postMessage: vi.fn(() => {
        const receive = this.port1.onmessage;
        tasks.push(() => receive?.());
      }),
    };
    constructor() { channels.push(this); }
  }
  vi.stubGlobal('window', { MessageChannel: TestChannel });
  return {
    tasks, channels,
    async deliver() {
      const task = tasks.shift();
      expect(task).toBeTypeOf('function');
      task!();
      await Promise.resolve();
    },
  };
}

describe('continuous native terrain cooking', () => {
  it('logs elapsed time from the seed request once, only after the final write finishes', async () => {
    let now = 3000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture({ startedAt: 1000, seed: 42 });
    let finishWrite!: () => void;
    f.flush.mockImplementation(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    f.cooker.add(f.source(0, 512, 512));
    f.cooker.start();
    f.cooker.start();
    expect(startLogs()).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(f.cooker.stats.completed).toBe(1);
    expect(startLogs()).toEqual([[
      '[Instant terrain] Native terrain cooking started',
      { seed: 42, regions: 1, blocks: 1, sinceSeedRequestMs: 2000, sinceNavigationMs: 3000 },
    ]]);
    expect(completionLogs()).toHaveLength(0);
    now = 12450;
    finishWrite();
    await vi.runAllTimersAsync();
    expect(completionLogs()).toEqual([[
      '[Instant terrain] Full map terrain finished in 11.45 seconds',
      expect.objectContaining({ seed: 42, regions: 1, completed: 1, total: 1,
        elapsedMs: 11450, cookingElapsedMs: 9450, sinceNavigationMs: 12450 }),
    ]]);
    f.cooker.start();
    await vi.runAllTimersAsync();
    expect(completionLogs()).toHaveLength(1);
    expect(startLogs()).toHaveLength(1);
  });
  it('finishes all nine regions without any zoom or tile-download request, then flushes', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) f.cooker.add(f.source(i, 768, 513));
    await vi.runAllTimersAsync();
    expect(f.visited).toHaveLength(0); // first paint starts it
    f.cooker.start();
    await vi.runAllTimersAsync();
    expect(new Set(f.visited).size).toBe(36);
    expect(f.cooker.stats).toEqual({ state: 'complete', total: 36, completed: 36, active: 0 });
    expect(startLogs()).toEqual([[
      '[Instant terrain] Native terrain cooking started',
      expect.objectContaining({ regions: 9, blocks: 36 }),
    ]]);
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.failure).not.toHaveBeenCalled();
  });

  it('keeps only one native draw active and reprioritizes after navigation', async () => {
    const f = fixture(), main = f.source(0), east = f.source(1);
    let release!: () => void;
    vi.mocked(main.prepareNativeTile).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.cooker.add(main); f.cooker.add(east); f.cooker.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.cooker.stats.active).toBe(1);
    expect(main.prepareNativeTile).toHaveBeenCalledOnce();
    expect(east.prepareNativeTile).not.toHaveBeenCalled();
    f.move(4096); release();
    await vi.runAllTimersAsync();
    expect(f.visited.slice(0, 2)).toEqual(['1/0/0', '1/1/0']);
    expect(f.cooker.stats.completed).toBe(4);
  });

  it('pauses hidden tabs and resumes without rebuilding completed work', async () => {
    const f = fixture(); f.cooker.add(f.source(0));
    page.hidden = true; f.cooker.start();
    await vi.runAllTimersAsync();
    expect(f.cooker.stats.state).toBe('paused-hidden');
    expect(f.visited).toHaveLength(0);
    expect(startLogs()).toHaveLength(0);
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    expect(f.cooker.stats.state).toBe('complete');
    expect(f.visited).toHaveLength(2);
    expect(startLogs()).toHaveLength(1);
  });

  it('does not announce native cooking when storage is unavailable before the first task', async () => {
    const f = fixture(); f.cooker.add(f.source(0));
    f.cooker.start(); f.loseStorage();
    await vi.runAllTimersAsync();
    expect(f.cooker.stats.state).toBe('paused-storage');
    expect(f.visited).toHaveLength(0);
    expect(startLogs()).toHaveLength(0);
    expect(completionLogs()).toHaveLength(0);
  });

  it('stops on storage failure instead of churning away finished pixels or claiming completion', async () => {
    const f = fixture(), source = f.source(0);
    vi.mocked(source.prepareNativeTile).mockImplementationOnce(async () => { f.loseStorage(); });
    f.cooker.add(source); f.cooker.start();
    await vi.runAllTimersAsync();
    expect(source.prepareNativeTile).toHaveBeenCalledOnce();
    expect(f.cooker.stats).toEqual({ state: 'paused-storage', total: 2, completed: 1, active: 0 });
    expect(f.flush).not.toHaveBeenCalled();
    expect(completionLogs()).toHaveLength(0);
  });

  it('does not report complete when the final persistence flush fails', async () => {
    const f = fixture(); f.cooker.add(f.source(0, 256, 256));
    f.flush.mockImplementation(async () => { f.loseStorage(); });
    f.cooker.start(); await vi.runAllTimersAsync();
    expect(f.cooker.stats.state).toBe('paused-storage');
    expect(completionLogs()).toHaveLength(0);
  });

  it('cancels queued work on reseed even while a draw is unresolved', async () => {
    const f = fixture(), source = f.source(0);
    let release!: () => void;
    vi.mocked(source.prepareNativeTile).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.cooker.add(source); f.cooker.start();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(); release();
    await vi.runAllTimersAsync();
    expect(source.prepareNativeTile).toHaveBeenCalledOnce();
    expect(f.cooker.stats.state).toBe('cancelled');
    expect(f.cooker.stats.completed).toBe(0);
    expect(f.failure).not.toHaveBeenCalled();
    expect(startLogs()).toHaveLength(1);
    expect(completionLogs()).toHaveLength(0);
  });

  it('yields through one reusable message channel between fast leaves without nested timers', async () => {
    const messages = messageTaskFixture(), f = fixture();
    f.cooker.add(f.source(0, 512 * 32, 512));
    f.cooker.start(); f.cooker.start();
    expect(f.visited).toHaveLength(0);
    for (let i = 0; i < 33; i++) {
      expect(messages.tasks).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      await messages.deliver();
      expect(f.visited).toHaveLength(Math.min(i + 1, 32));
    }
    expect(f.cooker.stats).toEqual({ state: 'complete', total: 32, completed: 32, active: 0 });
    expect(messages.tasks).toHaveLength(0);
    expect(messages.channels).toHaveLength(1);
    expect(messages.channels[0].port1.close).toHaveBeenCalledOnce();
    expect(messages.channels[0].port2.close).toHaveBeenCalledOnce();
    expect(f.failure).not.toHaveBeenCalled();
    // A later distinct source can reopen the scheduler after completion.
    f.cooker.add(f.source(1, 512, 512));
    await messages.deliver(); await messages.deliver();
    expect(f.cooker.stats.completed).toBe(33);
    expect(messages.channels).toHaveLength(2);
    expect(messages.channels[1].port1.close).toHaveBeenCalledOnce();
    expect(messages.channels[1].port2.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('closes message ports and ignores late completion on abort (active=%s)', async active => {
    const messages = messageTaskFixture(), f = fixture(), source = f.source(0);
    let release: (() => void) | undefined;
    if (active) vi.mocked(source.prepareNativeTile).mockImplementationOnce(() =>
      new Promise<void>(resolve => { release = resolve; }));
    f.cooker.add(source); f.cooker.start();
    if (active) await messages.deliver();
    controller.abort();
    expect(messages.channels[0].port1.close).toHaveBeenCalledOnce();
    expect(messages.channels[0].port2.close).toHaveBeenCalledOnce();
    if (active) { release!(); await Promise.resolve(); }
    else await messages.deliver(); // A dispatched message may outlive close().
    expect(messages.tasks).toHaveLength(0);
    expect(source.prepareNativeTile).toHaveBeenCalledTimes(active ? 1 : 0);
    expect(f.cooker.stats.state).toBe('cancelled');
    expect(f.cooker.stats.completed).toBe(0);
    expect(f.failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes message ports after a renderer failure without scheduling another leaf', async () => {
    const messages = messageTaskFixture(), f = fixture(), source = f.source(0);
    const error = new Error('Fixture renderer failed');
    vi.mocked(source.prepareNativeTile).mockRejectedValueOnce(error);
    f.cooker.add(source); f.cooker.start();
    await messages.deliver();
    expect(f.cooker.stats.state).toBe('failed');
    expect(f.failure).toHaveBeenCalledWith(error);
    expect(messages.tasks).toHaveLength(0);
    expect(messages.channels[0].port1.close).toHaveBeenCalledOnce();
    expect(messages.channels[0].port2.close).toHaveBeenCalledOnce();
  });

  it('falls back to timers if the message-channel constructor is unavailable at runtime', async () => {
    vi.stubGlobal('window', { MessageChannel: class {
      constructor() { throw new Error('Fixture channel unavailable'); }
    } });
    const f = fixture();
    f.cooker.add(f.source(0)); f.cooker.start();
    await vi.runAllTimersAsync();
    expect(f.cooker.stats.state).toBe('complete');
    expect(f.visited).toHaveLength(2);
    expect(f.failure).not.toHaveBeenCalled();
  });
});
