import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { testGameKeys } from '../../../tests/helpers/game-ticket-keys';
import { signGameTicket } from '../../noitamap-auth/src/game-ticket';
import { verifyGameTicket, verifyPlayerTicket } from '../src/tickets';
import { authorizeSocket } from '../src/stream-socket-auth';
import { StreamService } from '../../../src/guessr/stream-server';
import { createParallelRecord } from '../../../src/guessr/parallel-core';
import { streamSource, streamSecret, streamHost } from '../../../tests/helpers/guessr-stream';

it('verifies remembered free-player credentials with the Workers Web Crypto implementation', async () => {
  const now = Date.now(), keys = await testGameKeys('runtime-only-participant-test-key');
  const issued = await signGameTicket('account:free-player', 'Player', keys.privateKey,
    { twitchUserId: '456', twitchLogin: 'player', twitchColor: '#123456' }, now, 'player');
  expect(await verifyPlayerTicket(issued.token, keys.publicKey, now)).toMatchObject({ pro: false, twitchUserId: '456' });
  expect(await verifyGameTicket(issued.token, keys.publicKey, now)).toBeNull();
  const service = new StreamService(streamSource(), streamSecret), session = await service.start(streamHost, now, 'parallel', 3);
  const record = createParallelRecord({ owner: streamHost.sub, session, seconds: 90, reveals: await service.coordinatorReveals(session.token, streamHost, now) }, now);
  const bindings = { ...env, GAME_TICKET_PUBLIC_KEY: keys.publicKey, GAME_SIGNING_SECRET: 'runtime-only-unused-solo-key' };
  expect(await authorizeSocket(bindings, record, { protocol: 2, role: 'account', ticket: issued.token }, now)).toMatchObject({ role: 'player', id: '456', color: '#123456' });
  expect(await authorizeSocket(bindings, record, { protocol: 2, role: 'host', ticket: issued.token }, now)).toBeNull();
});
