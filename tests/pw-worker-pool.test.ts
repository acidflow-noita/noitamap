import { describe, expect, it, vi } from 'vitest';
import { ParallelWorldWorkerPool } from '../src/telescope/pw-worker-pool';

function harness() {
  const workers: any[] = [];
  const factory = () => {
    const worker: any = { onmessage: null, onerror: null, terminate: vi.fn(), messages: [],
      postMessage(data: any) { worker.messages.push(data); },
      done(success = true) {
        const input = worker.messages.at(-1);
        worker.onmessage({ data: { success, requestId: input.requestId, pw: input.pw, pois: [], pixelScenes: [], error: 'bad seed', phase: 'scanning' } });
      } };
    workers.push(worker); return worker;
  };
  const pool = new ParallelWorldWorkerPool(factory);
  const scenes = vi.fn(() => ({ version: 1 as const, fullPixels: false, data: { a: {} }, spawns: { a: [] } }));
  return { pool, workers, scenes };
}

describe('persistent parallel-world worker pool', () => {
  it('prepares both workers once without posting raw scene snapshots', async () => {
    const { pool, workers, scenes } = harness();
    const prepared = pool.prewarm(true);
    expect(pool.prewarm(true)).toBe(prepared);
    expect(workers).toHaveLength(2);
    expect(workers.every(worker => worker.messages[0].prepareOnly && !worker.messages[0].workerScenes)).toBe(true);
    const queued = pool.run({ pw: -1, seed: 42, fullPixels: true }, scenes);
    expect(pool.stats.queued).toBe(1);
    workers[0].done(); workers[1].done(); await prepared;
    expect(workers[0].messages[1].workerScenes).toBeUndefined();
    workers[0].done(); await queued;
    await pool.prewarm(true);
    expect(scenes).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ workers: 2, sceneSnapshots: 0, completed: 1 });
    pool.dispose();
  });
  it('bounds parallelism and sends each scene snapshot once across queued seeds', async () => {
    const { pool, workers, scenes } = harness();
    const pending = [-1, 1, -1, 1].map((pw, seed) => pool.run({ pw, seed, fullPixels: false }, scenes));
    expect(workers).toHaveLength(2); expect(pool.stats.queued).toBe(2);
    expect(workers.every(worker => worker.messages.length === 1)).toBe(true);
    workers[0].done(); workers[1].done();
    expect(workers.every(worker => worker.messages.length === 2)).toBe(true);
    expect(workers.every(worker => worker.messages[0].workerScenes && worker.messages[1].workerScenes === undefined)).toBe(true);
    workers[0].done(); workers[1].done(); await Promise.all(pending);
    expect(scenes).toHaveBeenCalledTimes(2);
    expect(pool.stats).toMatchObject({ workers: 2, busy: 0, queued: 0, sceneSnapshots: 2, completed: 4 });
    pool.dispose();
  });
  it('retires failed workers and gives replacements a complete scene snapshot', async () => {
    const { pool, workers, scenes } = harness();
    const first = pool.run({ pw: -1, fullPixels: false }, scenes);
    workers[0].done(false);
    await expect(first).rejects.toThrow('PW -1, scanning: bad seed');
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const next = pool.run({ pw: -1, fullPixels: false }, scenes);
    expect(workers[1].messages[0].workerScenes).toBeDefined();
    workers[1].done(); await next; pool.dispose();
  });
  it('replaces idle fork resources and rejects mismatched responses', async () => {
    const { pool, workers, scenes } = harness();
    const first = pool.run({ pw: 1, fullPixels: false }, scenes); workers[0].done(); await first;
    const next = pool.run({ pw: 1, fullPixels: true }, scenes);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(pool.stats.workers).toBe(1);
    workers[1].onmessage({ data: { requestId: -1, pw: 1, success: true } });
    await expect(next).rejects.toThrow('Mismatched'); pool.dispose();
  });
  it('disposes active and queued jobs without orphan threads', async () => {
    const { pool, workers, scenes } = harness();
    const jobs = [0, 1, 2].map(pw => pool.run({ pw, fullPixels: false }, scenes));
    pool.dispose();
    for (const job of jobs) await expect(job).rejects.toThrow('disposed');
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(pool.stats.workers).toBe(0); expect(pool.stats.queued).toBe(0);
    await expect(pool.run({ pw: 1, fullPixels: false }, scenes)).rejects.toThrow('disposed');
  });
});
