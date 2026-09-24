import { describe, expect, it, vi } from 'vitest';
import scheme from '../src/sage/seed-scheme.json';
import { createBakedSageSnapshot, decodeSageRecord, readBakedSageComparison, readBakedSageSnapshot } from '../src/sage/records';
import { hydrateBakedGeneration, type BakedGenerationFile } from '../src/telescope/baked-generation';
import { cacheGeneration, getCachedGeneration } from '../src/telescope/tile-cache';

function comparisonFixture(seed = 42, previousSeed = 41) {
  const snapshot = (value: number) => {
    const bytes = new Uint8Array(scheme.recordBytes * 2), view = new DataView(bytes.buffer);
    view.setUint32(0, value, true); view.setUint32(scheme.recordBytes, value + 1, true);
    return createBakedSageSnapshot(value, { ...decodeSageRecord(bytes, value), populationRevision: 4 });
  };
  return { ...snapshot(seed), comparison: {
    kind: 'previous-daily' as const, currentSeed: seed, previousSeed,
    observedAt: new Date().toISOString(), snapshot: snapshot(previousSeed),
  } };
}

describe('baked previous-daily census', () => {
  it('keeps current and previous seed records distinct through JSON serialization', () => {
    const saved = JSON.parse(JSON.stringify(comparisonFixture()));
    expect(readBakedSageSnapshot(saved, 42)?.seed).toBe(42);
    expect(readBakedSageComparison(saved, 42)?.record.seed).toBe(41);
    expect(readBakedSageComparison(saved, 41)).toBeNull();
    // History stays reusable by exact seed; freshness belongs to the UI.
    saved.comparison.observedAt = '2020-01-01T00:00:00.000Z';
    expect(readBakedSageComparison(saved, 42)?.record.seed).toBe(41);
  });
  it.each([
    (s: any) => { s.comparison.currentSeed = 43; },
    (s: any) => { s.comparison.previousSeed = 42; },
    (s: any) => { s.comparison.previousSeed = 0; },
    (s: any) => { s.comparison.previousSeed = scheme.lastSeed + 1; },
    (s: any) => { s.comparison.snapshot.seed = 40; },
    (s: any) => { s.comparison.snapshot.record.seed = 40; },
    (s: any) => { s.comparison.snapshot.record.axes[0].wands = -1; },
    (s: any) => { s.comparison.snapshot.schema = { ...s.comparison.snapshot.schema, recordBytes: 1 }; },
    (s: any) => { s.comparison.observedAt = 'invalid'; },
    (s: any) => { s.comparison.snapshot.comparison = s.comparison; },
  ])('ignores an invalid comparison without losing the current census (%#)', change => {
    const saved = structuredClone(comparisonFixture());
    change(saved);
    expect(readBakedSageComparison(saved, 42)).toBeNull();
    expect(readBakedSageSnapshot(saved, 42)?.seed).toBe(42);
  });
  it('does not fabricate previous counts when unavailable, and accepts valid previous data if current lookup failed', () => {
    const saved = comparisonFixture();
    const missingCurrent = { ...createBakedSageSnapshot(42, null, 'offline'), comparison: saved.comparison };
    expect(readBakedSageSnapshot(missingCurrent, 42)).toBeNull();
    expect(readBakedSageComparison(missingCurrent, 42)?.record.seed).toBe(41);
    saved.comparison.snapshot = createBakedSageSnapshot(41, null, 'offline');
    expect(readBakedSageComparison(saved, 42)).toBeNull();
  });
  it('rejects a corrupted outer envelope even if its nested previous record is valid', () => {
    for (const patch of [{ source: 'unknown' }, { capturedAt: 'invalid' }, { status: 'unknown' },
      { status: 'unavailable' }, { populationRevision: 3 }]) {
      expect(readBakedSageComparison({ ...comparisonFixture(), ...patch }, 42)).toBeNull();
    }
  });
  it('retains both records through baked hydration and the persistent generation cache', async () => {
    const sage = comparisonFixture();
    const files: BakedGenerationFile[] = [-1, 0, 1].map(pw => ({
      version: 1, seed: 42, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
      parallelWorlds: [pw], biomeDataW: 70, biomeDataH: 48,
      biomeDataPixels: Buffer.alloc(70 * 48 * 4).toString('base64'),
      poisByPW: { [`${pw},0`]: [] }, pixelScenesByPW: {}, sage,
    }));
    const entries = new Map<string, any>();
    const request = (result: unknown) => {
      const req: any = { result }; queueMicrotask(() => req.onsuccess?.()); return req;
    };
    const db = { close: vi.fn(), transaction: () => {
      const tx: any = { objectStore: () => ({
        put: (entry: any) => { entries.set(entry.cacheKey, structuredClone(entry)); queueMicrotask(() => tx.oncomplete?.()); },
        get: (key: string) => request(structuredClone(entries.get(key))),
      }) }; return tx;
    } };
    vi.stubGlobal('indexedDB', { open: () => request(db) });
    try {
      const hydrated = hydrateBakedGeneration(files);
      expect(hydrated.sage).toEqual(sage);
      await cacheGeneration('42-comparison', 42, hydrated);
      const loaded = await getCachedGeneration('42-comparison');
      expect(loaded?.sage).toEqual(sage);
      expect(readBakedSageComparison(loaded?.sage, 42)?.record.seed).toBe(41);
      expect(readBakedSageSnapshot(loaded?.sage, 42)?.seed).toBe(42);
    } finally { vi.unstubAllGlobals(); }
  });
});
