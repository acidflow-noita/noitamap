import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import admission from '../migrations/0010_stream_game_admission.sql?raw';
import { admitStreamGame } from '../src/stream-admission';

afterEach(() => reset());
it('atomically admits the final host slot through actual D1 and permits a new UTC day', async () => {
  await env.DB.prepare('CREATE TABLE stream_result_storage(id INTEGER PRIMARY KEY,used_bytes INTEGER NOT NULL,games INTEGER NOT NULL)').run();
  await env.DB.prepare('INSERT INTO stream_result_storage VALUES(1,0,0)').run();
  for (const sql of admission.trim().split(/;\s*(?=CREATE\b|$)/).filter(value => value.trim())) await env.DB.prepare(sql).run();
  const now = Date.UTC(2026, 10, 15, 23, 59);
  for (let i = 0; i < 19; i++) await admitStreamGame(env.DB, '123', now);
  const last = await Promise.allSettled([admitStreamGame(env.DB, '123', now), admitStreamGame(env.DB, '123', now)]);
  expect(last.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM stream_game_admissions').first('count')).toBe(20);
  await expect(admitStreamGame(env.DB, '123', Date.UTC(2026, 10, 16))).resolves.toBeTruthy();
});
