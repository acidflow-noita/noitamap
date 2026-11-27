import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gameDatabase } from './helpers/guessr-database';
import { admitStreamGame, cancelStreamAdmission, StreamAdmissionError } from '../workers/noitamap-guessr/src/stream-admission';
import { STREAM_STORAGE_BUDGET_BYTES } from '../workers/noitamap-guessr/src/result-storage';

function fixture() {
  const f = gameDatabase();
  for (const name of ['0002_stream_results', '0006_stream_storage', '0010_stream_game_admission'])
    f.sqlite.exec(readFileSync(`workers/noitamap-guessr/migrations/${name}.sql`, 'utf8'));
  return f;
}
const now = Date.UTC(2026, 10, 15, 23, 59);

it('allows only one of two simultaneous attempts for a host’s twentieth slot and resets at UTC midnight', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 19; i++) await admitStreamGame(f.db, '100', now);
    const results = await Promise.allSettled([admitStreamGame(f.db, '100', now), admitStreamGame(f.db, '100', now)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const denied = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(denied.reason).toBeInstanceOf(StreamAdmissionError);
    expect(denied.reason.resetAt).toBe(Date.UTC(2026, 10, 16));
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_game_admissions').get()!.games).toBe(20);
    await expect(admitStreamGame(f.db, '100', Date.UTC(2026, 10, 16))).resolves.toMatch(/^[a-f0-9-]{36}$/);
  } finally { f.close(); }
});

it('admits more than 100 new rooms when different hosts have room and can release a failed preparation', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) await admitStreamGame(f.db, String(100 + Math.floor(i / 20)), now);
    const [first, second] = await Promise.all([admitStreamGame(f.db, '200', now), admitStreamGame(f.db, '201', now)]);
    expect(first).not.toBe(second);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM stream_game_admissions').get()!.n).toBe(102);
    await cancelStreamAdmission(f.db, first, '999');
    expect(f.sqlite.prepare('SELECT id FROM stream_game_admissions WHERE id=?').get(first)).toBeTruthy();
    await cancelStreamAdmission(f.db, first, '200');
    expect(f.sqlite.prepare('SELECT id FROM stream_game_admissions WHERE id=?').get(first)).toBeUndefined();
  } finally { f.close(); }
});

it('rejects creation without result-storage headroom and prunes expired counters', async () => {
  const f = fixture();
  try {
    await admitStreamGame(f.db, '100', now - 33 * 86400000);
    await admitStreamGame(f.db, '100', now);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_game_admissions').get()!.games).toBe(1);
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1').run(STREAM_STORAGE_BUDGET_BYTES);
    await expect(admitStreamGame(f.db, '100', now)).rejects.toMatchObject({ status: 507 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_game_admissions').get()!.games).toBe(1);
  } finally { f.close(); }
});
