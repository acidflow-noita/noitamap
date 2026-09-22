import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import scheme from '../src/sage/seed-scheme.json';
import { decodeSageRecord, createBakedSageSnapshot, readBakedSageSnapshot } from '../src/sage/records';
import { attachSageToBake } from '../build_scripts/bake-sage-seed.mjs';
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
});
