import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import scheme from '../src/sage/seed-scheme.json';
import { decodeSageRecord, createBakedSageSnapshot, readBakedSageSnapshot, readBakedSageComparison } from '../src/sage/records';
import { attachSageToBake, resolveDailySageComparison } from '../build_scripts/bake-sage-seed.mjs';
const worlds = ['left', 'middle', 'right'];
const roots: string[] = [];
function record(seed = 20) {
  const bytes = new Uint8Array(scheme.recordBytes * 2), view = new DataView(bytes.buffer);
  view.setUint32(0, seed, true); view.setUint32(scheme.recordBytes, seed + 1, true);
  return { ...decodeSageRecord(bytes, seed), populationRevision: 4 };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'baked-sage-')); roots.push(root);
  await writeFile(join(root, 'seed.txt'), '20');
  for (const world of worlds) {
    await mkdir(join(root, world)); await writeFile(join(root, world, 'generation.json'), JSON.stringify({ seed: 20, poisByPW: { keep: true } }));
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Sage data delivered with a daily bake', () => {
  it('fetches once, preserves generation data and ships identical seed-matched snapshots in all worlds', async () => {
    const root = await fixture(), reader = { read: vi.fn(async () => record()) };
    const snapshot = await attachSageToBake(root, { reader });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(20);
    expect(snapshot.status).toBe('ready'); expect(snapshot.populationRevision).toBe(4);
    for (const world of worlds) {
      const generation = JSON.parse(await readFile(join(root, world, 'generation.json'), 'utf8'));
      expect(generation.poisByPW).toEqual({ keep: true });
      expect(generation.sage).toEqual(snapshot);
      expect(JSON.parse(await readFile(join(root, world, 'sage.json'), 'utf8'))).toEqual(snapshot);
      expect(readBakedSageSnapshot(generation.sage, 20)).toEqual(record());
    }
  });
  it('records unavailability without fabricating values; strict mode does not overwrite output', async () => {
    const root = await fixture(), reader = { read: vi.fn(async () => { throw new Error('offline'); }) };
    await expect(attachSageToBake(root, { reader, required: true })).rejects.toThrow('offline');
    expect(JSON.parse(await readFile(join(root, 'middle/generation.json'), 'utf8')).sage).toBeUndefined();
    const snapshot = await attachSageToBake(root, { reader });
    expect(snapshot).toMatchObject({ status: 'unavailable', seed: 20 }); expect(snapshot.record).toBeUndefined();
    expect(readBakedSageSnapshot(snapshot, 20)).toBeNull();
  });
  it('rejects wrong seeds, wrong layouts and malformed counts', async () => {
    const snapshot = createBakedSageSnapshot(20, record());
    expect(readBakedSageSnapshot(snapshot, 21)).toBeNull();
    expect(readBakedSageSnapshot({ ...snapshot, schema: { ...scheme, recordBytes: 1 } }, 20)).toBeNull();
    expect(readBakedSageSnapshot({ ...snapshot, capturedAt: 'not-a-date' }, 20)).toBeNull();
    expect(readBakedSageSnapshot({ ...snapshot, capturedAt: undefined }, 20)).toBeNull();
    const bad = structuredClone(snapshot); bad.record!.axes[0].wands = -1;
    expect(readBakedSageSnapshot(bad, 20)).toBeNull();
    const root = await fixture();
    const result = await attachSageToBake(root, { reader: { read: async () => record(21) } });
    expect(result.status).toBe('unavailable');
  });
  it('checks all world seeds before making a request or modifying any generation file', async () => {
    const root = await fixture(); await writeFile(join(root, 'right/generation.json'), '{"seed":99}');
    const reader = { read: vi.fn(async () => record()) };
    await expect(attachSageToBake(root, { reader })).rejects.toThrow('Mismatched right');
    expect(reader.read).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(root, 'left/generation.json'), 'utf8')).sage).toBeUndefined();
  });
  it('reuses matching validated snapshots on an offline resume and repairs the sidecar', async () => {
    const root = await fixture();
    const saved = await attachSageToBake(root, { reader: { read: async () => record() } });
    await rm(join(root, 'right/sage.json'));
    const offline = { read: vi.fn(async () => { throw new Error('offline'); }) };
    const resumed = await attachSageToBake(root, { reader: offline, required: true });
    expect(offline.read).not.toHaveBeenCalled();
    expect(resumed).toEqual(saved);
    for (const world of worlds) {
      expect(JSON.parse(await readFile(join(root, world, 'generation.json'), 'utf8')).sage).toEqual(saved);
      expect(JSON.parse(await readFile(join(root, world, 'sage.json'), 'utf8'))).toEqual(saved);
    }
  });
  it('does not reuse invalid or inconsistent existing snapshots, and strict failure preserves them', async () => {
    const root = await fixture();
    const saved = await attachSageToBake(root, { reader: { read: async () => record() } });
    const inconsistent = structuredClone(saved); inconsistent.record!.axes[0].wands = 5;
    const file = join(root, 'right/generation.json');
    await writeFile(file, JSON.stringify({ seed: 20, sage: inconsistent }));
    const offline = { read: vi.fn(async () => { throw new Error('offline'); }) };
    await expect(attachSageToBake(root, { reader: offline, required: true })).rejects.toThrow('offline');
    expect(offline.read).toHaveBeenCalledExactlyOnceWith(20);
    expect(JSON.parse(await readFile(file, 'utf8')).sage).toEqual(inconsistent);
    const invalid = structuredClone(saved); invalid.record!.axes[0].wands = -1;
    for (const world of worlds) await writeFile(join(root, world, 'generation.json'), JSON.stringify({ seed: 20, sage: invalid }));
    const reader = { read: vi.fn(async () => record()) };
    const repaired = await attachSageToBake(root, { reader, required: true });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(20);
    expect(readBakedSageSnapshot(repaired, 20)).toEqual(record());
  });
  it('refetches a resumed census whose capture timestamp is invalid or missing', async () => {
    const root = await fixture();
    for (const capturedAt of ['not-a-date', undefined]) {
      const invalid = { ...createBakedSageSnapshot(20, record()), capturedAt };
      for (const world of worlds) await writeFile(join(root, world, 'generation.json'), JSON.stringify({ seed: 20, sage: invalid }));
      const reader = { read: vi.fn(async () => record()) };
      const repaired = await attachSageToBake(root, { reader, required: true });
      expect(reader.read).toHaveBeenCalledExactlyOnceWith(20);
      expect(readBakedSageSnapshot(repaired, 20)).toEqual(record());
    }
  });
});

type Pair = { current: number; previous: number };
function dailyFetcher({ pairs = [{ current: 20, previous: 10 }], daily, previous }: {
  pairs?: Array<Pair | null>; daily?: unknown; previous?: unknown;
} = {}) {
  const calls = { current: 0, previous: 0 };
  return vi.fn(async (input: Parameters<typeof fetch>[0], _options?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const pointer = /\/(current|previous)_seed\.txt$/.exec(url)?.[1] as keyof Pair | undefined;
    if (pointer) {
      const pair = pairs[Math.min(calls[pointer]++, pairs.length - 1)];
      if (!pair) throw new Error('pointer service offline');
      return new Response(String(pair[pointer]));
    }
    const snapshot = url.startsWith('https://daily-middle.') ? daily : previous;
    return snapshot === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(snapshot));
  });
}
function withComparison(previousSeed = 10) {
  return { ...createBakedSageSnapshot(20, record()), comparison: {
    kind: 'previous-daily' as const, currentSeed: 20, previousSeed, observedAt: '2026-09-23T01:00:00.000Z',
    snapshot: createBakedSageSnapshot(previousSeed, record(previousSeed)),
  } };
}
const observedAt = '2026-09-23T02:00:00.000Z';
const now = () => new Date(observedAt);
describe('previous-daily Sage census attached during the bake', () => {
  it('reuses a verified worker sidecar and strips its older comparison chain', async () => {
    const prior = { ...createBakedSageSnapshot(10, record(10)), comparison: {
      kind: 'previous-daily', currentSeed: 10, previousSeed: 5, observedAt,
      snapshot: createBakedSageSnapshot(5, record(5)),
    } };
    const fetcher = dailyFetcher({ daily: prior });
    const reader = { read: vi.fn() };
    const comparison = await resolveDailySageComparison(20, { fetcher, reader, now });
    expect(comparison).toMatchObject({ kind: 'previous-daily', currentSeed: 20, previousSeed: 10, observedAt });
    expect(comparison!.snapshot.comparison).toBeUndefined();
    expect(readBakedSageSnapshot(comparison!.snapshot, 10)).toEqual(record(10));
    expect(prior.comparison.previousSeed).toBe(5);
    expect(reader.read).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.cache).toBe('no-store');
    }
  });
  it('falls back to the small archive record when worker snapshots are old, mismatched or too large', async () => {
    for (const daily of [createBakedSageSnapshot(99, record(99)), { seed: 10 }, 'x'.repeat(256 * 1024)]) {
      const fetcher = dailyFetcher({ daily });
      const reader = { read: vi.fn(async () => record(10)) };
      const comparison = await resolveDailySageComparison(20, { fetcher, reader, now });
      expect(reader.read).toHaveBeenCalledExactlyOnceWith(10);
      expect(readBakedSageSnapshot(comparison!.snapshot, 10)).toEqual(record(10));
    }
  });
  it('accepts an already-embedded matching previous census from the current daily worker', async () => {
    const saved = withComparison();
    const reader = { read: vi.fn() };
    const comparison = await resolveDailySageComparison(20, { fetcher: dailyFetcher({ daily: saved }), reader, now });
    expect(comparison?.snapshot).toEqual(saved.comparison.snapshot);
    expect(reader.read).not.toHaveBeenCalled();
  });
  it('reuses the matching resumed pair after checking pointers twice, without looking up census records', async () => {
    const saved = withComparison(), before = structuredClone(saved);
    const fetcher = dailyFetcher(), reader = { read: vi.fn() };
    const comparison = await resolveDailySageComparison(20, { fetcher, reader, existing: saved, now });
    expect(comparison).toEqual({ ...saved.comparison, observedAt });
    expect(comparison).not.toHaveProperty('record');
    expect(saved).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(reader.read).not.toHaveBeenCalled();
  });
  it('preserves only a verified saved pair during a pointer outage, without renewing its observation date', async () => {
    const saved = withComparison();
    const reader = { read: vi.fn() };
    const fetcher = dailyFetcher({ pairs: [null] });
    expect(await resolveDailySageComparison(20, { fetcher, reader, existing: saved, now })).toEqual(saved.comparison);
    expect(await resolveDailySageComparison(20, { fetcher, reader, now })).toBeUndefined();
    expect(reader.read).not.toHaveBeenCalled();
  });
  it('uses successful partial pointer observations to reject known rollover before or after lookup', async () => {
    const saved = withComparison();
    for (const recheck of [false, true]) for (const [failed, observed, keep] of [
      ['previous', 30, false], ['current', 9, false], ['previous', 20, true], ['current', 10, true],
    ] as const) {
      const calls = { current: 0, previous: 0 };
      const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        const kind = /\/(current|previous)_seed\.txt$/.exec(url)?.[1] as keyof Pair;
        const first = calls[kind]++ === 0;
        if (first && recheck) return new Response(String(kind === 'current' ? 20 : 10));
        if (kind === failed) throw new Error('one pointer offline');
        return new Response(String(observed));
      });
      const comparison = await resolveDailySageComparison(20, { fetcher, reader: { read: vi.fn() }, existing: saved, now });
      expect(comparison).toEqual(keep ? saved.comparison : undefined);
    }
  });
  it('drops a newly resolved pair if rollover occurs or final pointer verification fails', async () => {
    const ready = createBakedSageSnapshot(10, record(10));
    for (const after of [{ current: 30, previous: 20 }, { current: 20, previous: 9 }, null]) {
      const fetcher = dailyFetcher({ pairs: [{ current: 20, previous: 10 }, after], daily: ready });
      expect(await resolveDailySageComparison(20, { fetcher, reader: { read: vi.fn() }, now })).toBeUndefined();
    }
    const saved = withComparison();
    expect(await resolveDailySageComparison(20, { existing: saved, now,
      fetcher: dailyFetcher({ pairs: [{ current: 20, previous: 10 }, null] }), reader: { read: vi.fn() },
    })).toEqual(saved.comparison);
    expect(await resolveDailySageComparison(20, { existing: withComparison(9), now,
      fetcher: dailyFetcher({ pairs: [{ current: 20, previous: 10 }, null], daily: ready }), reader: { read: vi.fn() },
    })).toBeUndefined();
  });
  it.each([{ current: 30, previous: 10 }, { current: 20, previous: 0 }, { current: 20, previous: 20 }, { current: 20, previous: 0xffffffff }])(
    'does not look up a wrong, empty, self or uncovered previous pair: %j', async pair => {
      const fetcher = dailyFetcher({ pairs: [pair] }), reader = { read: vi.fn() };
      expect(await resolveDailySageComparison(20, { fetcher, reader, existing: withComparison(), now })).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reader.read).not.toHaveBeenCalled();
    });
  it('ships explicit previous unavailability without making the current required census fail', async () => {
    const root = await fixture();
    const reader = { read: vi.fn(async seed => { if (seed === 20) return record(); throw new Error('previous record offline'); }) };
    const snapshot = await attachSageToBake(root, { reader, required: true,
      resolveComparison: (seed, options) => resolveDailySageComparison(seed, { ...options, fetcher: dailyFetcher(), now }),
    });
    expect(snapshot.status).toBe('ready');
    expect(snapshot.comparison).toMatchObject({ currentSeed: 20, previousSeed: 10, observedAt,
      snapshot: { seed: 10, status: 'unavailable', reason: 'previous record offline' } });
    expect(readBakedSageComparison(snapshot, 20)).toBeNull();
    for (const world of worlds) {
      expect(JSON.parse(await readFile(join(root, world, 'generation.json'), 'utf8')).sage).toEqual(snapshot);
      expect(JSON.parse(await readFile(join(root, world, 'sage.json'), 'utf8'))).toEqual(snapshot);
    }
  });
  it('keeps the ready current and comparison snapshots intact during an offline resume', async () => {
    const root = await fixture();
    const saved = await attachSageToBake(root, { reader: { read: async () => record() },
      resolveComparison: (seed, options) => resolveDailySageComparison(seed, { ...options,
        fetcher: dailyFetcher({ previous: createBakedSageSnapshot(10, record(10)) }), now }),
    });
    const offline = { read: vi.fn(async () => { throw new Error('offline'); }) };
    const resumed = await attachSageToBake(root, { reader: offline, required: true,
      resolveComparison: (seed, options) => resolveDailySageComparison(seed, { ...options, fetcher: dailyFetcher({ pairs: [null] }), now }),
    });
    expect(resumed).toEqual(saved);
    expect(offline.read).not.toHaveBeenCalled();
    expect(readBakedSageComparison(resumed, 20)?.record).toEqual(record(10));
  });
  it('preserves the ready previous census even when the current census remains unavailable on resume', async () => {
    const root = await fixture();
    const saved = { ...createBakedSageSnapshot(20, null, 'current offline'), comparison: withComparison().comparison };
    for (const world of worlds) await writeFile(join(root, world, 'generation.json'), JSON.stringify({ seed: 20, sage: saved }));
    const reader = { read: vi.fn(async () => { throw new Error('still offline'); }) };
    const resumed = await attachSageToBake(root, { reader,
      resolveComparison: (seed, options) => resolveDailySageComparison(seed, { ...options, fetcher: dailyFetcher({ pairs: [null] }), now }),
    });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(20);
    expect(resumed.status).toBe('unavailable');
    expect(resumed.comparison).toEqual(saved.comparison);
    expect(readBakedSageSnapshot(resumed, 20)).toBeNull();
    expect(readBakedSageComparison(resumed, 20)?.record).toEqual(record(10));
  });
});
