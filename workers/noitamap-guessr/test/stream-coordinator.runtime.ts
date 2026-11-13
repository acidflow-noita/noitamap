import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
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

const sockets: WebSocket[] = [];
afterEach(async () => { sockets.splice(0).forEach(s => s.close()); await reset(); });
const secret = 'runtime-test-socket-key-never-used-in-production';
async function fixture() {
  const now = Date.now(), service = new StreamService(streamSource(), streamSecret);
  const session = { ...await service.start(streamHost, now, 'parallel', 3), live: true as const };
  const stub = env.STREAM_COORDINATORS.getByName(session.id);
  await stub.initialize({ owner: streamHost.sub, session, seconds: 30,
    reveals: await service.coordinatorReveals(session.token, streamHost, now) });
  const join = async (role: 'host' | 'player' = 'player') => {
    const identity: ParallelIdentity = role === 'host' ? { ...session.host, role, owner: streamHost.sub, expiresAt: now + 600000 }
      : { id: '200', login: 'omicron', name: '\u061c\u061c007', role, expiresAt: now + 600000 };
    const ticket = await socketTicket({ STREAM_SIGNING_SECRET: secret } as Env, session.id, identity);
    const response = await handle(new Request(`https://api.test/api/streams/live/${session.id}/socket`, {
      headers: { Origin: 'https://dynamic-map.noitamap.com', Upgrade: 'websocket' },
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
    const authorized = wait(m => m.type === 'authorized');
    socket.send(JSON.stringify({ type: 'authorize', role: 'resume', ticket })); await authorized;
    return { socket, messages, wait, send: (data: unknown) => socket.send(JSON.stringify(data)) };
  };
  return { stub, session, join };
}
it('persists one latest guess across both paths, hibernation, reconnect and closed-window recovery', async () => {
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
  receipt = player.wait(m => m.type === 'receipt'); host.send({ type: 'relay', message: relay });
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
