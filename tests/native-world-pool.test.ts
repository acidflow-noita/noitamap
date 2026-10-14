import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/native-map/world-worker?worker', () => ({ default: class {} }));
import { NativeWorldPool, nativeWorldWorkerLimit } from '../src/native-map/world-pool';
import type { NativeWorldDescription, WorldRequest } from '../src/native-map/world';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function result(request: WorldRequest): NativeWorldDescription {
  return { kind: 'native-world-description', revision: 'v1', seed: request.seed, ngPlus: request.ngPlus ?? 0,
    gameMode: request.gameMode ?? 'normal', calendar: request.calendar!, worldSize: 70, worldCenter: 35,
    biomeData: { pixels: new Uint32Array([1]) }, tileLayers: [{ buffer: new Uint8Array([2]) }], elevatorShafts: [],
    regions: request.parallelWorlds!.flatMap(horizontal => [0, -1, 1].map(vertical => ({ horizontal, vertical: vertical as -1 | 0 | 1, pois: [], scenes: [] }))),
    timings: { geometryMs: 2, placementsMs: 3, totalMs: 5 } };
}
function fixture(limit = 3) {
  const clients: any[] = [], jobs: any[] = [];
  const pool = new NativeWorldPool(() => {
    const create = (full: boolean) => vi.fn((input: WorldRequest, signal: AbortSignal) => {
      const pending = deferred<any>(); jobs.push({ input, signal, full, ...pending }); return pending.promise;
    });
    const client = { prepare: vi.fn(async () => {}), generate: create(true), generateRegions: create(false), dispose: vi.fn() };
    clients.push(client); return client;
  }, limit);
  return { pool, clients, jobs };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function finish(job: any) {
  const world = result(job.input);
  if (!job.full) { const { biomeData, tileLayers, elevatorShafts, ...regions } = world; job.resolve(regions); }
  else job.resolve(world);
}

describe('native world pool', () => {
  it.each([[undefined, undefined, 1], [2, 8, 1], [4, undefined, 2], [8, 2, 1], [8, 4, 2], [8, 8, 3], [32, undefined, 3]])(
    'bounds workers for %s cores and %s GiB', (cores, memory, expected) => expect(nativeWorldWorkerLimit(cores, memory)).toBe(expected));

  it('starts independent scans concurrently, joins in original order and keeps primary geometry', async () => {
    const f = fixture(), pending = f.pool.generate({ seed: 618, parallelWorlds: [1, 0, -1] });
    await flush(); expect(f.jobs).toHaveLength(3);
    expect(f.jobs.map(j => j.full)).toEqual([true, false, false]);
    let completed = false; void pending.then(() => completed = true);
    finish(f.jobs[2]); finish(f.jobs[1]); await flush(); expect(completed).toBe(false);
    const primary = result(f.jobs[0].input); f.jobs[0].resolve(primary);
    const world = await pending;
    expect(world.tileLayers).toBe(primary.tileLayers); expect(world.biomeData).toBe(primary.biomeData);
    expect(world.regions.map(r => [r.horizontal, r.vertical])).toEqual([1, 0, -1].flatMap(pw => [0, -1, 1].map(pv => [pw, pv])));
    expect(world.timings.workers).toBe(3);
    const next = f.pool.generate({ seed: 1103 }); await flush();
    f.jobs.slice(3).forEach(finish); await next; expect(f.clients).toHaveLength(3);
    f.pool.dispose(); expect(f.clients.every(c => c.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('uses one worker in Light mode and snapshots inputs before initialization', async () => {
    const f = fixture(), ready = deferred<void>();
    const prep = f.pool.prepare([0]); await prep;
    f.clients[0].prepare.mockImplementation(() => ready.promise);
    const input = { seed: 618, parallelWorlds: [0], unlocks: ['a'], calendar: { month: 2, day: 14 } };
    const pending = f.pool.generate(input);
    input.parallelWorlds[0] = -4; input.unlocks[0] = 'b'; input.calendar.day = 15;
    ready.resolve(); await flush(); expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0].input).toMatchObject({ parallelWorlds: [0], unlocks: ['a'], calendar: { month: 2, day: 14 } });
    finish(f.jobs[0]); await pending; f.pool.dispose();
  });

  it('cancels every sibling, rejects late completion and permits a subsequent seed', async () => {
    const f = fixture(), lifetime = new AbortController();
    const pending = f.pool.generate({ seed: 1 }, lifetime.signal); await flush();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    lifetime.abort(); expect(f.jobs.every(j => j.signal.aborted)).toBe(true);
    f.jobs.forEach(finish); await rejected;
    const next = f.pool.generate({ seed: 2 }); await flush();
    expect(f.jobs.slice(3).every(j => !j.signal.aborted)).toBe(true);
    f.jobs.slice(3).forEach(finish); expect((await next).seed).toBe(2); f.pool.dispose();
  });

  it('stops siblings on failure and rejects wrong identities or incomplete regions', async () => {
    for (const failure of ['worker', 'identity', 'region']) {
      const f = fixture(), pending = f.pool.generate({ seed: 618 }); await flush();
      const rejected = expect(pending).rejects.toThrow();
      if (failure === 'worker') f.jobs[1].reject(new Error('Worker failed'));
      else {
        const wrong = result(f.jobs[1].input);
        if (failure === 'identity') wrong.seed++;
        else wrong.regions.pop();
        f.jobs[1].resolve(wrong);
      }
      finish(f.jobs[0]); finish(f.jobs[2]); await rejected;
      expect(f.jobs.every(j => j.signal.aborted)).toBe(true); f.pool.dispose();
    }
  });

  it('does not resurrect a disposed pool or accept an in-flight result afterward', async () => {
    const f = fixture(), pending = f.pool.generate({ seed: 1 }); await flush();
    const rejected = expect(pending).rejects.toThrow('disposed');
    f.pool.dispose(); f.jobs.forEach(finish); await rejected;
    await expect(f.pool.prepare()).rejects.toThrow('disposed');
    await expect(f.pool.generate({ seed: 2 })).rejects.toThrow('disposed');
    expect(f.clients).toHaveLength(3);
  });
});
