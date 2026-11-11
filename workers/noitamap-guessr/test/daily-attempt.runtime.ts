import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import base from '../migrations/0001_game.sql?raw';
import tenRounds from '../migrations/0004_ten_rounds.sql?raw';
import { handle, type Env } from '../src/index';
import { signGameTicket } from '../src/tickets';

afterEach(() => reset());
it('resumes one D1 attempt, refuses to restart it after completion and still returns its saved score', async () => {
  // Use the deployed table definitions; the submission triggers are covered by
  // the ten-round completion tests. This checks the HTTP and D1 recovery path.
  for (const name of ['challenges', 'usage_limits'])
    await env.DB.prepare(base.match(new RegExp(`CREATE TABLE ${name} [\\s\\S]*?;`))![0]).run();
  for (const name of ['questions', 'attempts', 'guesses'])
    await env.DB.prepare(tenRounds.match(new RegExp(`CREATE TABLE ${name}_ten [\\s\\S]*?;`))![0]
      .replaceAll(/\b(questions|attempts|guesses)_ten\b/g, '$1')).run();
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?,?)').bind('daily-test', day, 'Daily',
    now - 1000, now + 86400000, now + 86400000, '{"x":0,"y":0,"width":100,"height":100}', 90, 1).run();
  await env.DB.prepare('INSERT INTO attempts(id,user_id,challenge_id,display_name,started_at,round_started_at) VALUES(?,?,?,?,?,?)')
    .bind('daily-attempt', 'twitch:test-player', 'daily-test', 'Player', now, now).run();
  const bindings = { ...env, GAME_ENABLED: 'true', GAME_SIGNING_SECRET: 'test-only-key-at-least-thirty-two-characters' } as Env;
  const ticket = await signGameTicket('twitch:test-player', 'Player', bindings.GAME_SIGNING_SECRET, now);
  const call = (path: string, body?: unknown) => handle(new Request('https://api.test' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'http://localhost:5173',
      Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings, now);
  expect(await (await call('/api/daily')).json()).toMatchObject({ attemptId: 'daily-attempt', attemptStatus: 'active' });
  expect(await (await call('/api/attempts', { challengeId: 'daily-test' })).json()).toMatchObject({ id: 'daily-attempt', status: 'active' });
  await env.DB.prepare('UPDATE attempts SET next_round=10,completed_at=?,score=43210 WHERE id=?').bind(now, 'daily-attempt').run();
  expect(await (await call('/api/daily')).json()).toMatchObject({ attemptId: 'daily-attempt', attemptStatus: 'complete' });
  const restart = await call('/api/attempts', { challengeId: 'daily-test' });
  expect(restart.status).toBe(409);
  expect(await restart.json()).toEqual({ error: 'You’ve already played this Daily.' });
  expect(await (await call('/api/attempts/daily-attempt')).json()).toMatchObject({ id: 'daily-attempt', status: 'complete', score: 43210 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM attempts').first('total')).toBe(1);
  const counters = await env.DB.prepare('SELECT * FROM usage_limits ORDER BY key').all();
  const publicCall = (suffix = '') => handle(new Request('https://api.test/api/daily/results/daily-attempt' + suffix,
    { headers: { Origin: 'http://localhost:5173' } }), { ...bindings, GAME_ENABLED: 'false' }, now);
  const summary = await publicCall();
  expect(summary.status).toBe(200);
  expect(summary.headers.get('Cache-Control')).toBe('public, max-age=300');
  expect(summary.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  expect(await summary.json()).toEqual({ id: 'daily-attempt', day, status: 'complete', totalRounds: 10, score: 43210,
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, guess: null })) });
  expect(await (await publicCall('/answers')).json()).toMatchObject({ id: 'daily-attempt', status: 'complete', score: 43210 });
  expect((await env.DB.prepare('SELECT * FROM usage_limits ORDER BY key').all()).results).toEqual(counters.results);
});
