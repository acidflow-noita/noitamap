import { expect, it } from 'vitest';
import { createPreparedRoundSource, type PreparedGameCatalog } from '../../../src/guessr/prepared-rounds';
import { scoreAreaGuess, type AreaDefinition } from '../../../src/guessr/area-rules';

it('excludes both Hard views from new games and can still score an archived Hard round in the Workers runtime', async () => {
  const base: AreaDefinition = { id: 'terrain/edr', label: 'EDR', originY: 0,
    runs: [[0, 0, 4], [1, 0, 4]], bounds: { x: -17920, y: 0, width: 2048, height: 1024 }, cells: 8,
    difficultyTier: 'hard', viewDifficulty: 'featureless-edr', scoring: { area: 1000, position: 4000, maximum: 5000 } };
  const catalog: PreparedGameCatalog = { schemaVersion: 1, version: 'fixture',
    capture: { originX: -17920, originY: 0, width: 2048, height: 1024, tileSize: 512, overlap: 2, maxLevel: 11 },
    areas: [base, { ...base, id: 'biome/the-work-hell', viewDifficulty: 'hell-background-only' as const,
      scoring: { area: 3000, position: 2000, maximum: 5000 } },
      { ...base, id: 'biome/other', viewDifficulty: undefined, difficultyTier: 'normal' as const }]
      .map((definition, i) => ({ definition, starts: String(i + 1).repeat(32) + '.bin', positions: 1 })) };
  const grid = new Uint8Array(12 + 8 * 16), gv = new DataView(grid.buffer);
  grid.set(new TextEncoder().encode('NGG1')); gv.setUint32(4, 4, true); gv.setUint32(8, 2, true);
  for (let n = 0; n < 8; n++) grid.fill(n + 1, 12 + n * 16, 12 + (n + 1) * 16);
  const starts = new Uint8Array(28), sv = new DataView(starts.buffer);
  starts.set(new TextEncoder().encode('NGS1')); sv.setUint32(4, 1, true);
  sv.setInt32(8, -16896, true); sv.setInt32(12, 512, true);
  for (const offset of [16, 20, 24]) sv.setUint32(offset, 1, true);
  let reads = 0;
  const source = createPreparedRoundSource(async path => {
    reads++;
    if (path.endsWith('catalog.json')) return Response.json(catalog);
    return new Response(path.endsWith('native-grid.bin') ? grid : starts);
  }, 'https://images.test', 'https://reference.test', () => 0);
  for (const count of [3, 5, 7, 10]) {
    const rounds = await source.sampleRounds(count);
    expect(rounds).toHaveLength(count);
    expect(rounds.every(r => r.area.id === 'biome/other' && r.area.difficultyTier === 'normal')).toBe(true);
  }
  const answer = { x: -16896, y: 512 };
  expect(scoreAreaGuess(base, answer, answer)).toMatchObject({ difficultyTier: 'hard', areaScore: 1000, positionScore: 4000, score: 5000 });
  const warmed = reads; await source.sampleRounds(10); expect(reads).toBe(warmed);
});
