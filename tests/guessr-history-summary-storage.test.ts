import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { storedHistorySummary } from '../workers/noitamap-guessr/src/history-summary';
import { gameDatabase } from './helpers/guessr-database';

it('fills a missing summary inside the service once while preserving immutable results and accounting', async () => {
  const f = gameDatabase();
  try {
    for (const migration of ['0002_stream_results', '0006_stream_storage', '0008_result_history_summaries'])
      f.sqlite.exec(readFileSync(`workers/noitamap-guessr/migrations/${migration}.sql`, 'utf8'));
    const id = '11111111-1111-4111-8111-111111111111';
    const result = { schema: 1, id, host: { id: '123', name: 'Patron', login: 'wuote' }, rounds: [{ id: 'round' }], scheduledRounds: 5,
      players: [{ id: '123', name: 'Patron', login: 'wuote', rank: 2, score: 100 }, { id: '456', name: "Player's name", login: 'player', rank: 1, score: 200 }] };
    const raw = Buffer.from(JSON.stringify(result)), gzip = gzipSync(raw);
    const header = JSON.stringify({ storage: 'gzip-json-v1', rawBytes: raw.length, host: result.host, finishedAt: 1, playerCount: 2 });
    const bytes = Buffer.byteLength(header) + gzip.length;
    f.sqlite.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,result_gzip) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 'owner', '2026-11-15', 1, bytes, 'same-digest', header, gzip);
    const before = f.sqlite.prepare('SELECT * FROM stream_results').get();
    const stored = { result_json: header, result_gzip: gzip };
    const expected = { hostId: '123', maximum: 25000, standings: [['123', 'wuote', 2, 100], ['456', "Player's name", 1, 200]] };
    expect(await storedHistorySummary(f.db, id, stored, null)).toEqual(expected);
    expect(f.sqlite.prepare('SELECT * FROM stream_results').get()).toEqual(before);
    const cached = f.sqlite.prepare('SELECT * FROM stream_result_history').get()!;
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage').get()).toEqual({ used_bytes: bytes + 4096 + Number(cached.bytes) + 4096, games: 1 });
    const calls = f.calls();
    expect(await storedHistorySummary(f.db, id, { result_json: header, result_gzip: null }, cached.summary_json as string)).toEqual(expected);
    expect(f.calls()).toBe(calls);
    await storedHistorySummary(f.db, id, stored, null);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_result_history').get()!.count).toBe(1);
    f.sqlite.prepare('DELETE FROM stream_results WHERE id=?').run(id);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_result_history').get()!.count).toBe(0);
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage').get()).toEqual({ used_bytes: 0, games: 0 });
  } finally { f.close(); }
});
