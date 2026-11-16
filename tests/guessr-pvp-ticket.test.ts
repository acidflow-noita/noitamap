import { expect, it } from 'vitest';
import { authorizeSocket } from '../workers/noitamap-guessr/src/stream-socket-auth';
import { StreamService } from '../src/guessr/stream-server';
import { createParallelRecord } from '../src/guessr/parallel-core';
import { signGameTicket, testGameKeys } from './helpers/game-ticket-keys';
import { streamHost, streamNow, streamSecret, streamSource } from './helpers/guessr-stream';
import type { Env } from '../workers/noitamap-guessr/src/index';
import { signGameTicket as issueTicket } from '../workers/noitamap-auth/src/game-ticket';
it('uses Pro tickets for either PvP seat without giving the opponent creator permissions', async () => {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow, 'parallel', 3, { mode: 'pvp' });
  const record = createParallelRecord({ owner: streamHost.sub, session, seconds: 90, reveals: await service.coordinatorReveals(session.token, streamHost, streamNow) }, streamNow);
  const env = { GAME_TICKET_PUBLIC_KEY: (await testGameKeys(streamSecret)).publicKey } as Env;
  const own = await signGameTicket(streamHost.sub, streamHost.name, streamSecret, streamHost, streamNow);
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'host', ticket: own.token }, streamNow)).toMatchObject({ role: 'host', id: streamHost.twitchUserId });
  const opponent = await signGameTicket('account:opponent', 'Opponent', streamSecret, { twitchUserId: '200', twitchLogin: 'opponent' }, streamNow);
  const player = await authorizeSocket(env, record, { protocol: 2, role: 'host', ticket: opponent.token }, streamNow);
  expect(player).toMatchObject({ role: 'player', id: '200', login: 'opponent' }); expect(player?.owner).toBeUndefined();
  delete record.game.pvp;
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'host', ticket: opponent.token }, streamNow)).toBeNull();
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'host', ticket: opponent.token + 'bad' }, streamNow)).toBeNull();
});
it('does not accept a participant ticket as a Pro host ticket', async () => {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow, 'parallel', 3, { mode: 'pvp' });
  const record = createParallelRecord({ owner: streamHost.sub, session, seconds: 90, reveals: await service.coordinatorReveals(session.token, streamHost, streamNow) }, streamNow);
  const keys = await testGameKeys(streamSecret), env = { GAME_TICKET_PUBLIC_KEY: keys.publicKey } as Env;
  const ticket = await issueTicket(streamHost.sub, 'Player', keys.privateKey,
    { twitchUserId: streamHost.twitchUserId!, twitchLogin: streamHost.twitchLogin!, twitchColor: '#123456' }, streamNow, 'player');
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'account', ticket: ticket.token }, streamNow)).toMatchObject({ role: 'player', color: '#123456' });
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'host', ticket: ticket.token }, streamNow)).toBeNull();
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'account', ticket: ticket.token + 'bad' }, streamNow)).toBeNull();
  expect(await authorizeSocket(env, record, { protocol: 2, role: 'account', ticket: ticket.token }, streamNow + 1200001)).toBeNull();
});
