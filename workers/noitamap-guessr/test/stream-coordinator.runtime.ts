import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamService } from '../../../src/guessr/stream-server';
import { streamSource, streamHost, streamSecret, streamAnswer } from '../../../tests/helpers/guessr-stream';
import { socketTicket } from '../src/stream-socket-auth';
import type { ParallelIdentity, ParallelServerMessage } from '../../../src/guessr/parallel-types';
import type { Env } from '../src/index';
import { handle } from '../src/index';
import { formatGuessCommand } from '../../../src/guessr/guess-command';
import resultSchema from '../migrations/0002_stream_results.sql?raw';
import historySchema from '../migrations/0005_stream_history.sql?raw';
import storageSchema from '../migrations/0006_stream_storage.sql?raw';
import ownershipSchema from '../migrations/0007_result_ownership.sql?raw';
import replaySchema from '../migrations/0011_clue_replays.sql?raw';
import { encodeReplayFrames, type ReplayFrame } from '../../../src/guessr/clue-replay';
import { archiveReplayBatch } from '../src/clue-replay-store';
import { archivedClueReplay } from '../src/result-storage';

const sockets: WebSocket[] = [];
afterEach(async () => { sockets.splice(0).forEach(s => { try { s.close(); } catch {} }); await reset(); });
const secret = 'runtime-test-socket-key-never-used-in-production';
async function installReplayTestSchema() {
  for (const schema of [resultSchema, historySchema, storageSchema, ownershipSchema, replaySchema]) {
    for (const sql of schema
      .replace(/^\s*--.*$/gm, '')
      .trim()
      .split(/;\n+(?=(?:CREATE|ALTER|DROP|DELETE|INSERT)\b)/))
      if (sql.trim()) await env.DB.prepare(sql).run();
  }
}
it.each(['stream', 'pvp'] as const)(
  'keeps %s camera traces private until reveal and preserves them through hibernation and publication',
  async mode => {
    await installReplayTestSchema();
    const { stub, session, join } = await fixture(mode);
    const host = await join('host'),
      player = await join();
    await runInDurableObject(stub, (_, state) => {
      const record = JSON.parse(
        state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data
      );
      record.game.timing.phase = 'play';
      record.game.openedAt = record.game.timing.startsAt = session.createdAt;
      record.game.timing.windows[0] = { opensAt: session.createdAt, closesAt: null, closed: false };
      state.storage.sql.exec('UPDATE game SET data=?', JSON.stringify(record));
    });
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    const t = session.createdAt,
      roundId = session.rounds[0].id;
    const input = {
      type: 'clue-frames',
      player: '100',
      roundId,
      frames: [
        [t, 0, 0, 0],
        [t + 1, 24, 0, 0],
        [t + 2, 24, 0, 1],
      ],
    };
    for (const socket of [player, player]) {
      const ack = socket.wait(m => m.type === 'clue-ack');
      socket.send(input);
      await ack;
    }
    const own = host.wait(m => m.type === 'clue-ack');
    host.send({ type: 'clue-frames', roundId, frames: [[t, 0, 0, 0]] });
    await own;
    const early = host.wait(m => m.type === 'clue-replay');
    host.send({ type: 'clue-read', round: 1, player: '200', request: 'early' });
    expect(await early).toMatchObject({ replay: null });
    const publicRead = () =>
      handle(new Request(`https://api.test/api/streams/results/${session.id}/rounds/1/replays/200`), {
        ...env,
        STREAM_ENABLED: 'true',
        GAME_SIGNING_SECRET: '',
      } as Env);
    expect((await publicRead()).status).toBe(404);
    expect(host.messages.some(m => JSON.stringify(m).includes('clue-frames'))).toBe(false);
    expect(
      await runInDurableObject(stub, (_, state) =>
        state.storage.sql.exec('SELECT frames FROM clue_replays ORDER BY player').toArray()
      )
    ).toEqual([{ frames: 1 }, { frames: 3 }]);
    await runInDurableObject(stub, (_, state) => {
      const record = JSON.parse(
        state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data
      );
      record.game.reveals = record.privateReveals.slice(0, 1);
      record.game.stage = 'reveal';
      state.storage.sql.exec('UPDATE game SET data=?', JSON.stringify(record));
    });
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    const released = host.wait(m => m.type === 'clue-replay');
    host.send({ type: 'clue-read', round: 1, player: '200', request: 'review' });
    const live = await released;
    if (live.type !== 'clue-replay' || !live.replay) throw Error('Missing revealed replay');
    expect(live.replay.steps.map(step => [step.second, 'camera' in step && step.camera])).toEqual([
      [0,{dx:0,dy:0,level:0}], [0,{dx:24,dy:0,level:0}], [0,{dx:24,dy:0,level:1}],
    ]);
    expect(live.replay).not.toHaveProperty('track');
    expect(live.replay.clue).toEqual(session.rounds[0].clue);
    const late = player.wait(m => m.type === 'clue-ack');
    player.send({ ...input, frames: [[t + 3, 0, 0, 0]] });
    await late;
    await runInDurableObject(stub, (_, state) => {
      const record = JSON.parse(
        state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data
      );
      record.game.reveals = record.privateReveals;
      record.game.stage = 'complete';
      record.game.finishedAt = Date.now();
      record.game.round = record.privateReveals.length - 1;
      state.storage.sql.exec('UPDATE game SET data=?', JSON.stringify(record));
    });
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    await runDurableObjectAlarm(stub);
    const read = (id: string, round = 1) =>
      handle(new Request(`https://api.test/api/streams/results/${session.id}/rounds/${round}/replays/${id}`), {
        ...env,
        STREAM_ENABLED: 'true',
        GAME_SIGNING_SECRET: '',
      } as Env);
    const archive = await read('200');
    expect(archive.status).toBe(200);
    expect(await archive.json()).toEqual(live.replay);
    expect((await read('100')).status).toBe(200);
    expect((await read('999')).status).toBe(404);
    expect((await read('200', 2)).status).toBe(404);
    expect(
      await env.DB.prepare('SELECT replay_bytes FROM stream_results WHERE id=?')
        .bind(session.id)
        .first<number>('replay_bytes')
    ).toBeGreaterThan(0);
    await env.DB.prepare('DELETE FROM stream_results WHERE id=?').bind(session.id).run();
    expect((await read('200')).status).toBe(404);
    expect(await env.DB.prepare('SELECT used_bytes FROM stream_result_storage WHERE id=1').first('used_bytes')).toBe(
      0
    );
  },
  20000
);
it('records each accepted chatter revision once and preserves an automatic update during a reconnect', async () => {
  const { stub, session, join } = await fixture();
  const host = await join('host'),
    chatter = await join();
  const started = host.wait(m => m.type === 'command');
  host.send({ type: 'start', id: 'begin-replay-test' });
  await started;
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(
      state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data
    );
    record.game.timing.startsAt = record.game.timing.windows[0].opensAt = Date.now() - 7000;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub, { webSockets: 'hibernate' });
  const original = {
    roundId: session.rounds[0].id,
    point: streamAnswer,
    maximum: 4500,
    nonce: '7777777777777777',
    revision: 1,
  };
  const update = {
    ...original,
    point: { x: streamAnswer.x + 24, y: streamAnswer.y + 12 },
    nonce: '8888888888888888',
    revision: 2,
    automatic: true,
  };
  for (const guess of [original, update, update]) {
    const reply = chatter.wait(m => m.type === 'receipt' && m.nonce === guess.nonce);
    chatter.send({ type: 'guess', submission: guess });
    expect(await reply).toMatchObject({ accepted: true });
  }
  const replay = await runInDurableObject(stub, (_, state) => {
    const row = state.storage.sql
      .exec<{ guesses: string; frames: number }>(
        'SELECT guesses,frames FROM clue_replays WHERE player=? AND round=1',
        '200'
      )
      .one();
    return { points: JSON.parse(row.guesses).map((step: number[]) => step.slice(1)), frames: row.frames };
  });
  expect(replay).toEqual({
    points: [
      [streamAnswer.x, streamAnswer.y, 0],
      [update.point.x, update.point.y, 1],
    ],
    frames: 0,
  });
});
it('resumes large replay archives with deterministic pages and fetches only the requested player', async () => {
  await installReplayTestSchema();
  const { stub, session } = await fixture();
  await env.DB.prepare(
    'INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,host_id,host_verified_at) VALUES(?,?,?,?,?,?,?,?,?)'
  )
    .bind(session.id, 'owner', '2026-11-26', 1, 2, 'test', '{"host":{"id":"100","login":"host"}}', '100', 1)
    .run();
  const track = Array.from({ length: 240 }, (_, batch) =>
    encodeReplayFrames(
      Array.from({ length: 32 }, (_, n): ReplayFrame => [batch * 32 + n, n, 0, 0]),
      0
    )
  ).join('');
  await runInDurableObject(stub, async (_, state) => {
    const { game, privateReveals } = JSON.parse(
      state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data
    );
    game.reveals = privateReveals.slice(0, 1);
    for (let i = 0; i < 12; i++)
      state.storage.sql.exec('INSERT INTO clue_replays(round,player,last_at,frames,track) VALUES(?,?,?,?,?)', 1, String(100 + i), 7679, 7680, track);
    const db = env.DB;
    const first = await archiveReplayBatch(db, state.storage.sql, game);
    expect(first).toEqual({ round: 1, after: '107' });
    expect(await archiveReplayBatch(db, state.storage.sql, game)).toEqual(first);
    expect(await archiveReplayBatch(db, state.storage.sql, game, first)).toBeUndefined();
  });
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM stream_result_replay_pages WHERE game_id=?')
      .bind(session.id)
      .first('n')
  ).toBe(13);
  const db = env.DB;
  for (const player of ['100', '107', '108', '111'])
    expect((await archivedClueReplay(db, session.id, 1, player))?.steps).toHaveLength(7680);
  expect(await archivedClueReplay(db, session.id, 1, '1010')).toBeNull();
}, 20000);
it('reports missing and expired games without an upgrade, but keeps live games available', async () => {
  const bindings = { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: '' } as Env;
  const probe = (id: string) => handle(new Request(`https://api.test/api/streams/live/${id}/socket`, {
    headers: { Origin: 'https://dynamic-map.noitamap.com' },
  }), bindings);
  const missing = await probe(crypto.randomUUID());
  expect(missing.status).toBe(404); expect(await missing.text()).toBe('Game unavailable');
  expect(missing.headers.get('Access-Control-Allow-Origin')).toBe('https://dynamic-map.noitamap.com');
  const { stub, session } = await fixture();
  const available = await probe(session.id); expect(available.status).toBe(426);
  expect(available.headers.get('Cache-Control')).toBe('no-store');
  expect(await available.text()).toBe('WebSocket required');
  await runInDurableObject(stub, (_, state) => {
    const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one();
    const record = JSON.parse(row.data); record.game.session.createdAt = Date.now() - 86400001;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub, { webSockets: 'hibernate' });
  const expired = await probe(session.id); expect(expired.status).toBe(404);
  expect(await expired.text()).toBe('Game unavailable');
});
async function fixture(mode: 'stream' | 'pvp' = 'stream') {
  const now = Date.now(), service = new StreamService(streamSource(), streamSecret);
  const session = { ...await service.start(streamHost, now, 'parallel', 3, { mode }), live: true as const };
  const stub = env.STREAM_COORDINATORS.getByName(session.id);
  await stub.initialize({ owner: streamHost.sub, session, seconds: 30,
    reveals: await service.coordinatorReveals(session.token, streamHost, now) });
  const join = async (role: 'host' | 'player' = 'player', playerId = '200', rejected = false, address?: string) => {
    const identity: ParallelIdentity = role === 'host' ? { ...session.host, role, owner: streamHost.sub, expiresAt: now + 600000 }
      : { id: playerId, login: 'omicron', name: '\u061c\u061c007', role, expiresAt: now + 600000 };
    const ticket = await socketTicket({ STREAM_SIGNING_SECRET: secret } as Env, session.id, identity);
    const response = await handle(new Request(`https://api.test/api/streams/live/${session.id}/socket`, {
      headers: { Origin: 'https://dynamic-map.noitamap.com', Upgrade: 'websocket', ...(address ? { 'CF-Connecting-IP': address } : {}) },
    }), { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: '' } as Env);
    expect(response.status).toBe(101);
    const socket = response.webSocket!; sockets.push(socket); socket.accept();
    const messages: ParallelServerMessage[] = [];
    const waiters: { match(value: ParallelServerMessage): boolean; resolve(value: ParallelServerMessage): void }[] = [];
    socket.addEventListener('message', event => {
      if (event.data === 'pong') return;
      const value = JSON.parse(String(event.data)); messages.push(value);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(value)) waiters.splice(i, 1)[0].resolve(value);
    });
    const wait = (match: (value: ParallelServerMessage) => boolean) => new Promise<ParallelServerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Missing socket message: ' + JSON.stringify(messages.map(m => m.type)))), 4000);
      waiters.push({ match, resolve: value => { clearTimeout(timeout); resolve(value); } });
    });
    const authorized = wait(m => rejected ? m.type === 'error' && m.code === 'capacity' : m.type === 'authorized');
    socket.send(JSON.stringify({ type: 'authorize', protocol: 2, role: 'resume', ticket })); await authorized;
    return { socket, messages, wait, send: (data: unknown) => socket.send(JSON.stringify(data)) };
  };
  return { stub, session, join };
}
it('persists one latest guess across hibernation and reconnect, and rejects retired relays', async () => {
  const { stub, session, join } = await fixture();
  const host = await join('host'), player = await join();
  let ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start' }); await ack;
  const initialTiming = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data).game.timing);
  await evictDurableObject(stub, { webSockets: 'hibernate' });
  ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start' }); await ack;
  const recoveredTiming = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data).game.timing);
  expect(recoveredTiming.startsAt).toBe(initialTiming.startsAt); expect(recoveredTiming.deadline).toBe(initialTiming.deadline);
  // Put the real alarm clock inside an open window without waiting in a test.
  await runInDurableObject(stub, (instance, state) => {
    const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one();
    const record = JSON.parse(row.data); record.game.timing.startsAt = Date.now() - 100;
    record.game.timing.windows[0].opensAt = Date.now() - 100;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub, { webSockets: 'hibernate' });
  const submission = { roundId: session.rounds[0].id, point: streamAnswer, maximum: 5000, nonce: '1111111111111111', revision: 1 };
  let receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission });
  expect(await receipt).toMatchObject({ type: 'receipt', accepted: true, revision: 1 });
  const relay = { player: { id: '200', login: 'omicron', name: '\u061c\u061c007' }, id: 'twitch1', sentAt: Date.now(),
    text: formatGuessCommand(1, streamAnswer, 5000, session.rounds[0].id, { userId: '200', nonce: new Uint8Array(8).fill(17), revision: 1 }) };
  const rejectedRelay = host.wait(m => m.type === 'error'); host.send({ type: 'relay', message: relay });
  expect(await rejectedRelay).toMatchObject({ code: 'invalid' });
  receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission });
  expect(await receipt).toMatchObject({ accepted: true, revision: 1 });
  receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission: { ...submission, revision: 2, nonce: '2222222222222222', maximum: 4900 } });
  expect(await receipt).toMatchObject({ accepted: true, revision: 2 });
  await evictDurableObject(stub, { webSockets: 'hibernate' });
  receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission });
  expect(await receipt).toMatchObject({ accepted: false, reason: 'superseded' });
  const saved = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>("SELECT data FROM players WHERE id='200'").one().data));
  expect(saved.name).toBe('007'); expect(saved.guesses[0]).toMatchObject({ nonce: '2222222222222222', maximum: 4900, revision: 2 });
  expect(saved).not.toHaveProperty('role'); expect(saved).not.toHaveProperty('expiresAt');
  expect(player.messages.filter(m => m.type === 'state').every(m => !JSON.stringify(m).includes('privateReveals') && !JSON.stringify(m).includes(session.token))).toBe(true);
  const again = await join(); const recovery = again.wait(m => m.type === 'receipt'); again.send({ type: 'recover' });
  expect(await recovery).toMatchObject({ accepted: true, revision: 2, maximum: 4900 });
});

it('persists one exploration signal per player and round, keeps pins private, and releases separate network groups', async () => {
  const { stub, session, join } = await fixture();
  const host = await join('host');
  const highA = await join('player', '200', false, '192.0.2.1'), scoutA = await join('player', '201', false, '192.0.2.1');
  const highB = await join('player', '300', false, '192.0.2.2'), scoutB = await join('player', '301', false, '192.0.2.2');
  const start = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start' }); await start;
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data);
    record.game.timing.startsAt = Date.now() - 100; record.game.timing.windows[0].opensAt = Date.now() - 100;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub);
  const activity = { type: 'activity', roundId: session.rounds[0].id, id: 'first-exploration' };
  for (const scout of [scoutA, scoutB]) { const ack = scout.wait(m => m.type === 'command'); scout.send(activity); expect(await ack).toMatchObject({ accepted: true }); }
  const writes = () => runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data).metrics.storageRowsWritten);
  const before = await writes();
  const duplicate = scoutA.wait(m => m.type === 'command'); scoutA.send(activity); await duplicate;
  expect(await writes()).toBe(before);
  for (const player of [highA, highB]) {
    const ack = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission: {
      roundId: session.rounds[0].id, point: streamAnswer, maximum: 5000, nonce: '1111111111111111', revision: 1,
    } }); expect(await ack).toMatchObject({ accepted: true });
  }
  const snapshot = host.wait(m => m.type === 'host'); host.send({ type: 'recover' });
  const message = await snapshot;
  if (message.type !== 'host') throw Error('Missing host snapshot');
  expect(message.game.submittedCounts?.[0]).toBe(2);
  expect(message.game.participants.filter(p => p.id !== session.host.id).every(p => !p.guesses[0])).toBe(true);
  const stored = await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM players').toArray().map(row => row.data).join('\n'));
  expect(stored).not.toContain('192.0.2.'); expect(stored).toContain('"explored"');
  expect(JSON.stringify(host.messages)).not.toMatch(/networkKey|networkTag|"explored"|192\.0\.2\./);
  // Exercise the exact persistence boundary used when a round is released.
  const flags = await runInDurableObject(stub, async instance => {
    const internal = instance as unknown as { record: import('../../../src/guessr/parallel-core').ParallelRecord; persist(): Promise<void> };
    internal.record.game.reveals[0] = internal.record.privateReveals[0]; await internal.persist();
    return internal.record.game.reviewFlags;
  });
  expect(flags).toEqual([
    { round: 1, highScorers: ['200'], explorers: ['201'], nonSubmitting: ['201'] },
    { round: 1, highScorers: ['300'], explorers: ['301'], nonSubmitting: ['301'] },
  ]);
  await evictDurableObject(stub);
  const recovered = highA.wait(m => m.type === 'reveal'); highA.send({ type: 'recover' });
  const publicRound = await recovered;
  expect(publicRound).toMatchObject({ results: { players: expect.arrayContaining([expect.objectContaining({ id: '200', score: 5000 })]) } });
  expect(publicRound).not.toHaveProperty('results.reviewFlags');
});

it('keeps both PvP players private, locks accepted guesses and restores the same state after hibernation', async () => {
  const { stub, session, join } = await fixture('pvp');
  const host = await join('host'), player = await join();
  let ack = host.wait(m => m.type === 'command');
  host.send({ type: 'start', id: 'not-ready', opponentId: '200' }); expect(await ack).toMatchObject({ accepted: false });
  ack = player.wait(m => m.type === 'command'); player.send({ type: 'ready', id: 'ready', ready: true, round: 0, phase: 'lobby' });
  expect(await ack).toMatchObject({ accepted: true });
  ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start', opponentId: '200' });
  expect(await ack).toMatchObject({ accepted: true });
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data);
    expect(record.game.session.streaming).toBe(false); expect(record.game.timing.chatRound).toBe(0);
    record.game.timing.startsAt = Date.now() - 100; record.game.timing.windows[0].opensAt = Date.now() - 100;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub);
  const input = { roundId: session.rounds[0].id, point: streamAnswer, maximum: 4900, nonce: '1111111111111111', revision: 1 };
  let receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission: input });
  expect(await receipt).toMatchObject({ accepted: true });
  let snapshot = host.wait(m => m.type === 'state'); host.send({ type: 'recover' }); await snapshot;
  expect(host.messages.some(m => m.type === 'host' || m.type === 'participant' || m.type === 'receipt')).toBe(false);
  const view = host.messages.filter(m => m.type === 'state').at(-1)!;
  expect(view).toMatchObject({ state: { mode: 'pvp', pvp: { creator: true, locked: false, opponentLocked: true } } });
  expect(JSON.stringify(view)).not.toMatch(/"(?:guesses|maximum|privateReveals|token|controllers)"/);
  for (const round of session.rounds.slice(1)) expect(JSON.stringify(view)).not.toContain(round.id);
  receipt = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission: { ...input, nonce: '2222222222222222', revision: 2 } });
  expect(await receipt).toMatchObject({ accepted: false });
  ack = host.wait(m => m.type === 'command'); host.send({ type: 'host-guess', id: 'forbidden', roundId: input.roundId, point: streamAnswer, maximum: 5000 });
  expect(await ack).toMatchObject({ accepted: false });
  receipt = host.wait(m => m.type === 'receipt'); host.send({ type: 'guess', submission: { ...input, nonce: '3333333333333333' } });
  expect(await receipt).toMatchObject({ accepted: true });
  const revealed = host.messages.find(m => m.type === 'reveal') ?? await host.wait(m => m.type === 'reveal');
  expect(revealed).toMatchObject({ results: { mode: 'pvp', players: expect.arrayContaining([expect.objectContaining({ id: '200', score: 4900 })]) } });
  const before = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  await evictDurableObject(stub); const restored = await join();
  receipt = restored.wait(m => m.type === 'receipt'); restored.send({ type: 'recover' });
  expect(await receipt).toMatchObject({ accepted: true, maximum: 4900, nonce: input.nonce });
  const after = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  expect(after.game.timing.deadline).toBe(before.game.timing.deadline);
  expect(after.game.pvp.controllers['200']).toBe(before.game.pvp.controllers['200'] + 1);
});

it('removes a declined PvP opponent durably and admits a different opponent without widening the roster', async () => {
  const { stub, join } = await fixture('pvp');
  const host = await join('host'); await join(); await join('player', '300', true);
  let ack = host.wait(m => m.type === 'command'); host.send({ type: 'reject-opponent', id: 'reject', playerId: '200' });
  expect(await ack).toMatchObject({ accepted: true });
  await evictDurableObject(stub);
  expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec('SELECT id FROM players ORDER BY ordinal').toArray())).toEqual([{ id: streamHost.twitchUserId }]);
  await join('player', '200', true);
  const replacement = await join('player', '300');
  ack = replacement.wait(m => m.type === 'command'); replacement.send({ type: 'ready', id: 'ready-new', ready: true, round: 0, phase: 'lobby' });
  expect(await ack).toMatchObject({ accepted: true });
  ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start-new', opponentId: '300' });
  expect(await ack).toMatchObject({ accepted: true });
});

it('expires an unused PvP invitation without leaving an alarm loop or a reconnecting player', async () => {
  const { stub, join } = await fixture('pvp'); const host = await join('host');
  const ended = host.wait(m => m.type === 'state' && m.state.ended === true);
  await runInDurableObject(stub, (_, state) => {
    const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one();
    const record = JSON.parse(row.data); record.game.session.expiresAt = Date.now() - 1;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub); await runDurableObjectAlarm(stub); await ended;
  expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
  expect((await stub.fetch(new Request('https://api.test', { headers: { Origin: 'https://dynamic-map.noitamap.com', Upgrade: 'websocket' } }))).status).toBe(404);
});

it('publishes a concession once, retaining only completed PvP rounds and preserving the result mode', async () => {
  for (const schema of [resultSchema, historySchema, storageSchema, ownershipSchema]) {
    for (const sql of schema.replace(/^\s*--.*$/gm, '').trim().split(/;\n+(?=(?:CREATE|ALTER|DROP|DELETE|INSERT)\b)/).filter(s => s.trim())) await env.DB.prepare(sql).run();
  }
  const { session, join } = await fixture('pvp'), host = await join('host'), player = await join();
  let ack = player.wait(m => m.type === 'command'); player.send({ type: 'ready', id: 'ready', ready: true, round: 0, phase: 'lobby' }); await ack;
  ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start', opponentId: '200' }); await ack;
  const published = host.wait(m => m.type === 'published');
  player.send({ type: 'quit', id: 'concede' });
  expect(await published).toMatchObject({ result: { mode: 'pvp', concededBy: '200', rounds: [], players: expect.arrayContaining([
    expect.objectContaining({ id: '200', rank: 2 }), expect.objectContaining({ id: streamHost.twitchUserId, rank: 1 }),
  ]) } });
  const read = await handle(new Request(`https://api.test/api/streams/results/${session.id}`), { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: '' } as Env);
  expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ mode: 'pvp', concededBy: '200', rounds: [] });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stream_results WHERE id=?').bind(session.id).first('n')).toBe(1);
});
it('denies untrusted origins and prevents an anonymous upgrade from creating game storage', async () => {
  const id = crypto.randomUUID(), stub = env.STREAM_COORDINATORS.getByName(id);
  expect((await stub.fetch(new Request('https://api.test/', { headers: { Upgrade: 'websocket', Origin: 'https://evil.test' } }))).status).toBe(403);
  expect((await stub.fetch(new Request('https://api.test/', { headers: { Upgrade: 'websocket', Origin: 'https://dynamic-map.noitamap.com' } }))).status).toBe(404);
  const tables = await runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('game','players')").toArray());
  expect(tables).toEqual([]);
});
it('alarms advance the game even after every browser disconnects', async () => {
  const { stub, join } = await fixture(); const host = await join('host');
  const ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start' }); await ack;
  host.socket.close();
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data);
    record.game.timing.deadline = Date.now() - 1; record.game.timing.windows[0].closesAt = Date.now() - 1;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub); await runDurableObjectAlarm(stub);
  const phase = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data).game.timing.phase);
  expect(phase).toBe('play');
});

it('keeps guesses pending through a storage failure, then recovers scores and deadlines after an abrupt object reset', async () => {
  const { stub, session, join } = await fixture();
  const host = await join('host'), player = await join();
  const ack = host.wait(m => m.type === 'command'); host.send({ type: 'start', id: 'start' }); await ack;
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data);
    record.game.timing.startsAt = Date.now() - 100; record.game.timing.windows[0].opensAt = Date.now() - 100;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub);
  const first = { roundId: session.rounds[0].id, point: streamAnswer, maximum: 5000, nonce: '1111111111111111', revision: 1 };
  const received = player.wait(m => m.type === 'receipt'); player.send({ type: 'guess', submission: first });
  expect(await received).toMatchObject({ accepted: true });
  const before = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  expect(before.metrics.reconnects).toBe(0);
  const update = { ...first, nonce: '2222222222222222', revision: 2, maximum: 4900 };
  await expect(runInDurableObject(stub, async (instance, state) => {
    const socket = state.getWebSockets().find(s => s.deserializeAttachment().identity?.id === '200')!;
    const persist = vi.spyOn(instance as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('Simulated storage reset'));
    try { await instance.webSocketMessage(socket, JSON.stringify({ type: 'guess', submission: update })); }
    finally { persist.mockRestore(); }
  })).rejects.toThrow('Simulated storage reset');
  expect(player.messages.some(m => m.type === 'receipt' && m.nonce === update.nonce)).toBe(false);
  await abortAllDurableObjects();
  const restored = await join();
  const freshStub = env.STREAM_COORDINATORS.getByName(session.id);
  const after = await runInDurableObject(freshStub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  expect(after.game.timing.deadline).toBe(before.game.timing.deadline);
  expect(after.game.timing.startsAt).toBe(before.game.timing.startsAt);
  expect(after.metrics.reconnects).toBe(1);
  const retried = restored.wait(m => m.type === 'receipt' && m.nonce === update.nonce);
  restored.send({ type: 'guess', submission: update });
  expect(await retried).toMatchObject({ accepted: true, maximum: 4900, revision: 2 });
});

it('answers heartbeat probes without application messages before and after hibernation', async () => {
  const { stub, join } = await fixture(); const player = await join();
  for (const hibernate of [false, true]) {
    if (hibernate) await evictDurableObject(stub);
    const pong = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('No automatic pong')), 1000);
      player.socket.addEventListener('message', function listener(event) {
        if (event.data !== 'pong') return;
        clearTimeout(timer); player.socket.removeEventListener('message', listener); resolve();
      });
    });
    player.socket.send('ping'); await pong;
  }
  const record = await runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  expect(record.metrics.socketMessages).toBe(0); expect(record.metrics.reconnects).toBe(0);
});
it('retries failed final publication after eviction with no browser and stores one immutable D1 result', async () => {
  const { stub, session } = await fixture();
  await runInDurableObject(stub, (_, state) => {
    const record = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data);
    record.game.stage = 'complete'; record.game.round = record.game.session.rounds.length - 1; record.game.finishedAt = Date.now(); record.game.reveals = record.privateReveals;
    state.storage.sql.exec('UPDATE game SET data=? WHERE id=1', JSON.stringify(record));
  });
  await evictDurableObject(stub); await runDurableObjectAlarm(stub);
  const read = () => runInDurableObject(stub, (_, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM game WHERE id=1').one().data));
  expect((await read()).publicationError).toBeTruthy();
  expect((await read()).finalResult.id).toBe(session.id);
  for (const schema of [resultSchema, historySchema, storageSchema, ownershipSchema]) {
    const statements = schema.replace(/^\s*--.*$/gm, '').trim().split(/;\n+(?=(?:CREATE|ALTER|DROP|DELETE|INSERT)\b)/).filter(s => s.trim());
    for (const sql of statements) await env.DB.prepare(sql).run();
  }
  await evictDurableObject(stub); await runDurableObjectAlarm(stub);
  expect((await read()).game.published).toBe(true);
  expect((await read()).metrics.publicationAttempts).toBe(2);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stream_results WHERE id=?').bind(session.id).first('n')).toBe(1);
  await evictDurableObject(stub); await runDurableObjectAlarm(stub);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stream_results WHERE id=?').bind(session.id).first('n')).toBe(1);
});
