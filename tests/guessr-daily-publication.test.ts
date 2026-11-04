import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { handle, type Env } from '../workers/noitamap-guessr/src/index';
import { gameDatabase } from './helpers/guessr-database';
import { signGameTicket } from '../workers/noitamap-guessr/src/tickets';
import type { DailyImagePack } from '../src/guessr/daily-pack';

const now = Date.UTC(2026, 9, 25, 12), secret = 'local-test-only-daily-publisher-key-0123456789';
const gameSecret = 'local-test-only-game-key-01234567890123456789';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));
function pack(): DailyImagePack {
  const version = 'guessr-images-' + 'a'.repeat(32);
  const area = { id: 'test/area', label: 'Test area', originY: 0, runs: [[0, 0, 4], [1, 0, 4], [2, 0, 4], [3, 0, 4]] as const,
    bounds: { x: -17920, y: 0, width: 2048, height: 2048 }, cells: 16, difficultyTier: 'normal' as const,
    scoring: { area: 1000, position: 4000, maximum: 5000 } };
  const frames = Array.from({ length: 16 }, (_, n) => ({ image: `https://a1b2c3d4.clue-test.pages.dev/images/${n.toString(16).padStart(32, '0')}.webp`,
    x: (n % 4) * 512 - 1024, y: Math.floor(n / 4) * 512 - 1024, width: 512, height: 512 }));
  return { schemaVersion: 1, day: '2026-10-25', seed: 123, version, renderId: 'render-test', generatedAt: new Date(now - 1000).toISOString(),
    config: { version, bounds: area.bounds, overview: '', map: { width: 2048, height: 2048, tileSize: 512, overlap: 2, maxLevel: 11,
      tiles: 'https://e5f6a7b8.map-test.pages.dev/map_files/' } },
    rounds: Array.from({ length: 10 }, () => ({ area, answer: { x: -16896, y: 1024 }, frames })) };
}
function fixture() {
  const db = gameDatabase(); cleanups.push(db.close);
  const env: Env = { DB: db.db, ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ALLOWED_ORIGINS: 'https://dynamic-map.noitamap.com', GAME_ENABLED: 'true', GAME_SIGNING_SECRET: gameSecret,
    DAILY_PUBLISH_SECRET: secret, DAILY_ASSET_HOSTS: 'clue-test.pages.dev,map-test.pages.dev' };
  const publish = (value: DailyImagePack, valid = true) => {
    const body = JSON.stringify(value), signature = createHmac('sha256', valid ? secret : secret + 'wrong').update(body).digest('hex');
    return handle(new Request('https://guessr-api.sage-data.xyz/api/admin/daily', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Guessr-Publish-Signature': signature }, body }), env, now);
  };
  return { ...db, env, publish };
}

describe('prepared Daily publication and gameplay', () => {
  it('plays all ten rounds through the API, allows the final image, and caps the total at 50,000', async () => {
    const f = fixture(), p = pack(); await f.publish(p);
    f.env.ASSETS.fetch = async () => new Response('image', { headers: { 'Content-Type': 'image/webp' } });
    const ticket = await signGameTicket('twitch:ten', 'Ten rounds', gameSecret, now);
    const call = (path: string, body?: unknown) => handle(new Request('https://guessr-api.sage-data.xyz' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), f.env, now);
    expect(await (await call('/api/daily')).json()).toMatchObject({ challenge: { totalRounds: 10 } });
    let state = await (await call('/api/attempts', { challengeId: 'daily-2026-10-25' })).json() as any;
    expect(state).toMatchObject({ round: 0, totalRounds: 10, status: 'active' });
    expect((await call(`/api/attempts/${state.id}/image/9`)).status).toBe(403);
    for (let round = 0; round < 10; round++) {
      const response = await call(`/api/attempts/${state.id}/guess`, {
        round, guess: p.rounds[round].answer, requestId: `ten-round-guess-${round.toString().padStart(16, '0')}`,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      state = await response.json();
      expect(state.status).toBe(round === 9 ? 'complete' : 'active');
    }
    expect(state).toMatchObject({ round: 10, totalRounds: 10, score: 50000, clue: null });
    expect(state.results).toHaveLength(10);
    expect((await call(`/api/attempts/${state.id}/image/9`)).status).toBe(200);
    expect((await call(`/api/attempts/${state.id}/image/10`)).status).toBe(404);
    expect(await (await call('/api/history')).json()).toMatchObject({ attempts: [{ complete: true, totalRounds: 10, score: 50000 }] });
    // A fresh read restores the saved scores, before the public reveal time.
    const reopened = await (await call(`/api/attempts/${state.id}`)).json() as any;
    expect(reopened).toMatchObject({ status: 'complete', score: 50000 });
    expect(reopened.results).toHaveLength(10);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS saved FROM guesses WHERE attempt_id=?').get(state.id)).toEqual({ saved: 10 });
  });
  it('authenticates before database work and refuses untrusted asset hosts', async () => {
    const f = fixture(); expect((await f.publish(pack(), false)).status).toBe(401); expect(f.calls()).toBe(0);
    const wrong = pack(); wrong.config.map.tiles = 'https://untrusted.example/map_files/';
    expect((await f.publish(wrong)).status).toBe(400); expect(f.calls()).toBe(0);
    wrong.config.map.tiles = 'https://daily-images.map-test.pages.dev/map_files/';
    expect((await f.publish(wrong)).status).toBe(400); expect(f.calls()).toBe(0);
  });
  it('activates all ten rounds atomically and treats a repeated publication as a no-op', async () => {
    const f = fixture(), p = pack();
    const publication = await f.publish(p);
    expect(publication.status, await publication.clone().text()).toBe(200);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM questions').get()).toMatchObject({ n: 10 });
    expect(await (await f.publish(p)).json()).toMatchObject({ unchanged: true });
    const broken = pack(); broken.rounds[9].answer.x = 100000;
    expect((await f.publish(broken)).status).toBe(400);
    expect(f.sqlite.prepare('SELECT x FROM questions WHERE ordinal=9').get()).toMatchObject({ x: p.rounds[9].answer.x });
  });
  it('withholds targets, uses prepared clue frames, and scores area/proximity with the exploration cap', async () => {
    const f = fixture(), p = pack(); await f.publish(p);
    const ticket = await signGameTicket('twitch:one', 'Player', gameSecret, now);
    const call = (path: string, body?: unknown) => handle(new Request('https://guessr-api.sage-data.xyz' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), f.env, now);
    const started = await (await call('/api/attempts', { challengeId: 'daily-2026-10-25' })).json() as any;
    expect(started.config.version).toBe(p.version); expect(started.image).toBeNull();
    expect(started.clue.frames).toHaveLength(16); expect(started.results).toEqual([]);
    expect(JSON.stringify(started)).not.toContain('Test area'); expect(JSON.stringify(started)).not.toContain('answer');
    const body = { round: 0, guess: p.rounds[0].answer, maximum: 3400, requestId: 'daily-guess-0000000001' };
    const submitted = await call(`/api/attempts/${started.id}/guess`, body);
    expect(submitted.status).toBe(200);
    const state = await submitted.json() as any;
    expect(state.round).toBe(1);
    expect(state.results[0].guess).toMatchObject({ score: 3400, maximum: 3400, area_score: 680, position_score: 2720 });
    expect(state.results[0].clue.frames).toEqual(p.rounds[0].frames);
    expect((await call(`/api/attempts/${started.id}/guess`, body)).status).toBe(200);
    expect((await call(`/api/attempts/${started.id}/guess`, { ...body, maximum: 5000 })).status).toBe(409);
    const replacement = pack(); replacement.renderId = 'replacement'; replacement.generatedAt = new Date(now).toISOString();
    expect((await f.publish(replacement)).status).toBe(409);
  });
  it('rejects an older bake after a newer publication', async () => {
    const f = fixture(), p = pack(); await f.publish(p);
    const old = pack(); old.generatedAt = new Date(now - 2000).toISOString();
    expect((await f.publish(old)).status).toBe(409);
  });
  it('preserves all ten original rounds if a player starts while a replacement is being published', async () => {
    const f = fixture(), original = pack(); await f.publish(original);
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB = { ...f.env.DB, async batch(statements) {
      // A different request won the race after the publisher's preflight read.
      f.sqlite.prepare('INSERT INTO attempts(id,challenge_id,user_id,display_name,started_at,round_started_at) VALUES(?,?,?,?,?,?)')
        .run('racing-player', 'daily-2026-10-25', 'twitch:racer', 'Racer', now, now);
      return batch(statements);
    } };
    const replacement = pack(); replacement.renderId = 'new-render'; replacement.generatedAt = new Date(now).toISOString();
    replacement.rounds[0].answer.x += 1;
    expect((await f.publish(replacement)).status).toBe(409);
    expect(f.sqlite.prepare('SELECT x FROM questions WHERE ordinal=0').get()).toMatchObject({ x: original.rounds[0].answer.x });
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM questions').get()).toMatchObject({ n: 10 });
  });
});
