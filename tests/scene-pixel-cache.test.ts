import { describe, expect, it, vi } from 'vitest';
import { createScenePixelCache } from '../src/telescope/scene-pixel-cache';

function onceDecoder() {
  const loaded = new WeakSet<object>();
  let actualDecodes = 0;
  const decode = vi.fn(async (record: any, { art }: { art: boolean }) => {
    if (!loaded.has(record)) {
      actualDecodes++;
      record.imgElement = new Uint8Array(record.width * record.height * 4).fill(actualDecodes);
      loaded.add(record);
    }
    if (art && record.artName && !record.visualArt)
      record.visualArt = { data: new Uint8Array(record.width * record.height * 4) };
  });
  return { decode, get actualDecodes() { return actualDecodes; } };
}

describe('compact raw scene memory ownership', () => {
  it('evicts decoded copies while generator metadata stays raw-free and eviction still allows reloading', async () => {
    const cache = createScenePixelCache(2 * 16 * 16 * 4), decoder = onceDecoder();
    const records = Array.from({ length: 30 }, () => ({ width: 16, height: 16, imgElement: null }));
    for (let i = 0; i < records.length; i++) {
      const data = await cache.load(String(i), records[i], false, decoder.decode);
      expect(data.imgElement).toBeInstanceOf(Uint8Array);
      expect(records[i].imgElement).toBeNull();
      expect(cache.stats.bytes).toBeLessThanOrEqual(2048);
    }
    expect(cache.stats.entries).toBe(2);
    expect(cache.peek('0', records[0])).toBeUndefined();
    const reloaded = await cache.load('0', records[0], false, decoder.decode);
    expect((reloaded.imgElement as Uint8Array)[0]).toBe(31);
    expect(decoder.actualDecodes).toBe(31);
    expect(records.every(record => record.imgElement === null)).toBe(true);
  });

  it('accounts for visual-art upgrades and invalidates when upstream replaces a metadata record', async () => {
    const cache = createScenePixelCache(2048), decoder = onceDecoder();
    const original = { width: 16, height: 16, imgElement: null, artName: 'art' };
    const first = await cache.load('a', original, false, decoder.decode);
    const second = await cache.load('a', original, true, decoder.decode);
    expect(second).toBe(first);
    expect(cache.stats.bytes).toBe(2048);
    expect(decoder.actualDecodes).toBe(1);
    const nextOriginal = { ...original };
    const replacement = await cache.load('a', nextOriginal, false, decoder.decode);
    expect(replacement).not.toBe(first);
    expect(cache.peek('a', original)).toBeUndefined();
    expect(cache.stats.bytes).toBe(1024);
  });

  it('serializes eight mask requests, evicts before decode, and does not retain oversized scene data', async () => {
    const cache = createScenePixelCache(2048), decoder = onceDecoder();
    let active = 0, maxActive = 0;
    const decode = async (record: any, options: { art: boolean }) => {
      active++; maxActive = Math.max(maxActive, active);
      expect(cache.stats.bytes).toBe(0);
      try { await decoder.decode(record, options); } finally { active--; }
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => cache.load(String(i),
      { width: 32, height: 32, imgElement: null }, false, decode)));
    expect(maxActive).toBe(1);
    expect(cache.stats).toMatchObject({ bytes: 0, entries: 0 });
  });
});
