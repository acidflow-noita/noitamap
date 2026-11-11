import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { handle, type Env } from '../src/index';

it.each(['/rooms/wuote', '/rooms/random_channel', '/pulse', '/advance', '/pause', '/quit'])('cannot create a socket or object through %s', async path => {
  expect('LIVE_ROOMS' in env).toBe(false);
  const response = await handle(new Request('https://game.test/api/streams' + path, {
    method: path.startsWith('/rooms/') ? 'GET' : 'POST',
    headers: { Origin: 'https://dynamic-map.noitamap.com', Upgrade: 'websocket' },
  }), { ...env, STREAM_ENABLED: 'true', GAME_SIGNING_SECRET: '' } satisfies Env);
  expect(response.status).toBe(404); expect(response.webSocket).toBeNull();
});
