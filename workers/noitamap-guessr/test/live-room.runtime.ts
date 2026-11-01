import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveRoomGame, LiveRoomMessage } from '../../../src/guessr/live-room-types';
import type { LiveRoomState } from '../../../src/guessr/live-room-core';
import type { StreamPublishedResult, StreamRoundOutcome } from '../../../src/guessr/stream-types';
import { handle, type Env } from '../src/index';
import { signGameTicket } from '../src/tickets';

const openSockets: WebSocket[] = [];
const game = (channel = 'wuote'): LiveRoomGame => ({
  channel, gameId: crypto.randomUUID(), expiresAt: Date.now() + 86_400_000,
  rounds: Array.from({ length: 10 }, (_, index) => ({ id: `round_${index + 1}`, clue: `private_clue_${index + 1}` })),
});
async function viewer(stub: DurableObjectStub, channel = 'wuote') {
  const response = await stub.fetch(`https://room.invalid/?channel=${channel}`, {
    headers: { Upgrade: 'websocket', Origin: 'http://localhost:5173' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  openSockets.push(socket);
  const pending: LiveRoomMessage[] = [];
  let waiter: ((value: LiveRoomMessage) => void) | undefined;
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data)) as LiveRoomMessage;
    if (waiter) { const receive = waiter; waiter = undefined; receive(value); }
    else pending.push(value);
  });
  socket.accept();
  return {
    socket,
    next: (): Promise<LiveRoomMessage> => pending.length ? Promise.resolve(pending.shift()!)
      : new Promise((resolve) => { waiter = resolve; }),
  };
}
afterEach(async () => {
  await Promise.all(openSockets.splice(0).map((socket) => socket.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      try { socket.close(1000); } catch { resolve(); }
    })));
  await reset();
});

describe('live rooms in the Workers runtime', () => {
  it('persists quit as an answer-free waiting room and accepts retries after eviction', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote'), session = game();
    await stub.start('host', session);
    const stream = await viewer(stub); await stream.next();
    const closed = await stub.quit('host', session.gameId);
    expect(closed).toMatchObject({ phase: 'waiting', gameId: null, clue: null });
    expect(await stream.next()).toEqual({ type: 'state', state: closed });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    await evictDurableObject(stub);
    expect(await stub.quit('host', session.gameId)).toEqual(closed);
    await runInDurableObject(stub, (instance, state) => {
      expect(() => instance.pulse('host', session.gameId)).toThrow('[room:410]');
      expect(() => instance.advance('host', session.gameId, session.rounds[0].id)).toThrow('[room:410]');
      expect(() => instance.quit('other', session.gameId)).toThrow('[room:403]');
      const saved = JSON.parse(state.storage.sql.exec<{ state: string }>('SELECT state FROM live_room WHERE id = 1').one().state);
      expect(saved.game.rounds).toEqual([]);
    });
    const late = await viewer(stub);
    expect(await late.next()).toEqual({ type: 'state', state: closed });
  });

  it('preserves the WebSocket through the public Worker route and keeps writes host-only', async () => {
    const bindings = { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: 'test-only-key-at-least-thirty-two-characters' } as Env;
    const session = game();
    session.rounds.forEach(round => { round.id = crypto.randomUUID(); });
    await env.LIVE_ROOMS.getByName('wuote').start('account:host', session);
    const response = await handle(new Request('https://room.invalid/api/streams/rooms/wuote', {
      headers: { Upgrade: 'websocket', Origin: 'http://localhost:5173' },
    }), bindings);
    expect(response.status).toBe(101);
    const socket = response.webSocket!; openSockets.push(socket);
    const first = new Promise<any>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }));
    socket.accept(); expect(await first).toMatchObject({ type: 'state', state: { round: 1 } });
    const ticket = await signGameTicket('account:host', 'Host', bindings.GAME_SIGNING_SECRET, { twitchUserId: '100', twitchLogin: 'wuote' });
    const attempt = (token?: string) => handle(new Request('https://room.invalid/api/streams/advance', {
      method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ gameId: session.gameId, roundId: session.rounds[0].id }),
    }), bindings);
    expect((await attempt()).status).toBe(401);
    // An RPC rejection retains its status through the Worker; no answer was exposed.
    const early = await attempt(ticket.token);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: 'Reveal the current round before advancing.' });
  });
  it('joins by channel before a game and pushes the current clue without polling', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote');
    const stream = await viewer(stub);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { phase: 'waiting', clue: null } });
    const session = game();
    await stub.start('host', session);
    const first = await stream.next();
    expect(first).toMatchObject({ type: 'state', state: { phase: 'guess', round: 1, clue: 'private_clue_1' } });
    expect(JSON.stringify(first)).not.toContain('private_clue_2');
    await stub.pulse('host', session.gameId);
    expect(await stream.next()).toMatchObject({ type: 'heartbeat' });
  });

  it('pushes verified Pro renewal once and preserves it over hibernation', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote');
    const session = { ...game(), hostId: '100', hostProVerifiedUntil: Date.now() + 1_000_000 };
    await stub.start('host', session);
    const stream = await viewer(stub);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { hostPro: 'active', hostProVerifiedUntil: session.hostProVerifiedUntil } });
    await stub.pulse('host', session.gameId, session.hostProVerifiedUntil);
    expect(await stream.next()).toMatchObject({ type: 'heartbeat' });
    const renewedProof = Date.now() + 1_200_000;
    await stub.pulse('host', session.gameId, renewedProof);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { hostPro: 'active', hostProVerifiedUntil: renewedProof } });
    expect(await stream.next()).toMatchObject({ type: 'heartbeat' });
    await evictDurableObject(stub);
    const late = await viewer(stub);
    expect(await late.next()).toMatchObject({ type: 'state', state: { hostProVerifiedUntil: renewedProof } });
    await stub.pulse('host', session.gameId, renewedProof);
    expect(await stream.next()).toMatchObject({ type: 'heartbeat' });
  });

  it('retains closure and hibernated connections through eviction, then advances once', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote'), session = game();
    await stub.start('host', session);
    const stream = await viewer(stub);
    await stream.next();
    const closed = await stub.reveal('host', session.gameId, session.rounds[0].id);
    expect(closed.phase).toBe('reveal');
    expect(await stream.next()).toMatchObject({ type: 'state', state: { phase: 'reveal' } });
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ state: string }>('SELECT state FROM live_room WHERE id = 1').one();
      expect(JSON.parse(row.state).phase).toBe('reveal');
    });
    await evictDurableObject(stub);
    expect((await stub.reveal('host', session.gameId, session.rounds[0].id)).revision).toBe(closed.revision);
    const advanced = await stub.advance('host', session.gameId, session.rounds[0].id);
    expect(advanced).toMatchObject({ phase: 'guess', round: 2, clue: 'private_clue_2' });
    expect(await stream.next()).toMatchObject({ type: 'state', state: { round: 2 } });
    expect(await stub.advance('host', session.gameId, session.rounds[0].id)).toEqual(advanced);
    const late = await viewer(stub);
    expect(await late.next()).toMatchObject({ type: 'state', state: { round: 2, phase: 'guess' } });
  });

  it('keeps different channels separate and rejects untrusted changes', async () => {
    const one = env.LIVE_ROOMS.getByName('wuote'), two = env.LIVE_ROOMS.getByName('another');
    const session = game();
    await one.start('host', session);
    await runInDurableObject(one, (instance) => {
      expect(() => instance.reveal('attacker', session.gameId, session.rounds[0].id)).toThrow('[room:403]');
      expect(() => instance.reveal('host', 'old_game', session.rounds[0].id)).toThrow('[room:409]');
    });
    const otherViewer = await viewer(two, 'another');
    expect(await otherViewer.next()).toMatchObject({ type: 'state', state: { phase: 'waiting', channel: 'another' } });
    const denied = await one.fetch('https://room.invalid/?channel=wuote', {
      headers: { Upgrade: 'websocket', Origin: 'https://untrusted.invalid' },
    });
    expect(denied.status).toBe(403);
  });

  it('pushes closed-round scores and final standings durably to current and late viewers', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote'), session = { ...game(), hostId: '100' };
    await stub.start('host', session);
    const stream = await viewer(stub);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { phase: 'guess', hostId: '100' } });
    const outcome = (roundId: string): StreamRoundOutcome => ({
      roundId, answer: { x: 10, y: 20 }, label: 'Mines', difficultyTier: 'normal',
      players: [{ id: '100', guess: { x: 10, y: 20 }, score: 4600, areaScore: 920, positionScore: 3680, distance: 0 }],
    });
    const first = outcome(session.rounds[0].id);
    await stub.reveal('host', session.gameId, first.roundId, first);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { phase: 'reveal', outcome: first } });
    await evictDurableObject(stub);
    const retry = await stub.reveal('host', session.gameId, first.roundId, { ...first, players: [] });
    expect(retry.outcome).toEqual(first);
    const late = await viewer(stub);
    expect(await late.next()).toMatchObject({ type: 'state', state: { outcome: first } });
    for (let index = 0; index < session.rounds.length; index++) {
      const round = session.rounds[index];
      if (index) { await stub.reveal('host', session.gameId, round.id, outcome(round.id)); await stream.next(); }
      await stub.advance('host', session.gameId, round.id);
      const advanced = await stream.next();
      if (advanced.type === 'state' && index < session.rounds.length - 1) expect(advanced.state.outcome).toBeUndefined();
    }
    const result: StreamPublishedResult = {
      schema: 1, format: 'compact-scores-v1', id: session.gameId, version: 'fixture', createdAt: Date.now() - 100, finishedAt: Date.now(),
      host: { id: '100', login: 'wuote', name: 'Host' },
      rounds: session.rounds.map(round => ({ id: round.id, answer: { x: 10, y: 20 }, name: 'Mines', difficultyTier: 'normal' })),
      players: [{ id: '100', login: 'wuote', name: 'Host', rank: 1, score: 46000, rounds: session.rounds.map(() => [920, 3680]) }],
    };
    await stub.publish('host', session.gameId, result);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { phase: 'complete', result } });
    const changes = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT total_changes() AS n').one().n);
    const before = await changes();
    await stub.pulse('host', session.gameId);
    expect(await changes()).toBe(before);
    await evictDurableObject(stub);
    const finalViewer = await viewer(stub);
    expect(await finalViewer.next()).toMatchObject({ type: 'state', state: { phase: 'complete', result } });
  });

  it('marks the host offline by alarm and rejects viewer application messages', async () => {
    const stub = env.LIVE_ROOMS.getByName('wuote'), session = game();
    await stub.start('host', session);
    const stream = await viewer(stub);
    await stream.next();
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ state: string }>('SELECT state FROM live_room WHERE id = 1').one();
      const saved: LiveRoomState = JSON.parse(row.state);
      saved.lastSeen = Date.now() - 160_000;
      state.storage.sql.exec('UPDATE live_room SET state = ? WHERE id = 1', JSON.stringify(saved));
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { online: false } });
    await stub.pulse('host', session.gameId);
    expect(await stream.next()).toMatchObject({ type: 'state', state: { online: true } });
    expect(await stream.next()).toMatchObject({ type: 'heartbeat' });
    const closed = new Promise<CloseEvent>((resolve) => stream.socket.addEventListener('close', resolve, { once: true }));
    stream.socket.send('ping');
    expect((await closed).code).toBe(1008);
  });
});
