import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import schema from '../migrations/0002_stream_results.sql?raw';
import ownership from '../migrations/0007_result_ownership.sql?raw';
import historyIndex from '../migrations/0005_stream_history.sql?raw';
import storage from '../migrations/0006_stream_storage.sql?raw';
import summaries from '../migrations/0008_result_history_summaries.sql?raw';
import { handle, type Env } from '../src/index';

afterEach(() => reset());
it('reads bounded public history through the deployed handler and D1 without updating results', async () => {
  await env.DB.prepare(schema.match(/CREATE TABLE stream_results[\s\S]*?;/)![0]).run();
  await env.DB.prepare(historyIndex).run();
  for (const migration of [storage, ownership, summaries]) {
    const statements = migration.replace(/^\s*--.*$/gm, '').trim().split(/;\s*(?=(?:CREATE|ALTER|DROP|DELETE FROM stream_results|INSERT INTO stream_result_storage)\b|$)/).filter(s => s.trim());
    for (const sql of statements) await env.DB.prepare(sql).run();
  }
  const id = crypto.randomUUID(), finishedAt = Date.now();
  await env.DB.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,host_id,host_verified_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, 'private-owner', '2026-11-04', finishedAt, 100, 'digest', JSON.stringify({
      host: { id: '564553302', login: 'wuote', name: 'WUOTE' }, finishedAt, rounds: [{ id: 'round' }],
      players: [{ id: '564553302', name: 'WUOTE', login: 'wuote', rank: 1, score: 5000 }],
    }), '564553302', finishedAt).run();
  const response = await handle(new Request('https://api.test/api/streams/history/wuote', {
    headers: { Origin: 'https://dynamic-map.noitamap.com' },
  }), { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: 'test-only-key-at-least-thirty-two-characters' } as Env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://dynamic-map.noitamap.com');
  expect(await response.json()).toEqual({ games: [{ id, finishedAt, players: 1, hostName: 'WUOTE',
    summary: { hostId: '564553302', maximum: 5000, standings: [['564553302', 'WUOTE', 1, 5000]] } }] });
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM stream_results WHERE host_id=? ORDER BY created_at DESC, id DESC LIMIT 21").bind('564553302').all();
  expect(JSON.stringify(plan.results)).toContain('stream_results_host_history');
  expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM stream_results').first('total')).toBe(1);
});
