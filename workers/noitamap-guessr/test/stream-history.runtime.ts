import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import schema from '../migrations/0002_stream_results.sql?raw';
import historyIndex from '../migrations/0005_stream_history.sql?raw';
import { handle, type Env } from '../src/index';

afterEach(() => reset());
it('reads bounded public history through the deployed handler and D1 without updating results', async () => {
  await env.DB.prepare(schema.match(/CREATE TABLE stream_results[\s\S]*?;/)![0]).run();
  await env.DB.prepare(historyIndex).run();
  const id = crypto.randomUUID(), finishedAt = Date.now();
  await env.DB.prepare('INSERT INTO stream_results VALUES(?,?,?,?,?,?,?)')
    .bind(id, 'private-owner', '2026-11-04', finishedAt, 100, 'digest', JSON.stringify({
      host: { login: 'wuote', name: 'WUOTE' }, finishedAt, players: [{ name: 'WUOTE' }],
    })).run();
  const response = await handle(new Request('https://api.test/api/streams/history/wuote', {
    headers: { Origin: 'http://localhost:5173' },
  }), { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: 'test-only-key-at-least-thirty-two-characters' } as Env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  expect(await response.json()).toEqual({ games: [{ id, finishedAt, players: 1, hostName: 'WUOTE' }] });
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM stream_results WHERE json_extract(result_json, '$.host.login')=? ORDER BY created_at DESC, id DESC LIMIT 21").bind('wuote').all();
  expect(JSON.stringify(plan.results)).toContain('stream_results_channel_history');
  expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM stream_results').first('total')).toBe(1);
});
