import { describe, expect, it } from 'vitest';
import { readGuessRoute, guessRouteUrl, isGuessrPagePath } from '../src/guessr/routes';

const origin = 'http://localhost:5173';
describe('Guessr page routes', () => {
  it.each([
    ['/guess/?pane=stream', '/guess/stream/', 'stream'],
    ['/guess/?channel=wuote', '/guess/stream/wuote/', 'stream-picker'],
    ['/guess/?pane=stream-picker', '/guess/join/', 'stream-picker'],
    ['/guess/?pane=practice', '/guess/demo/', 'practice'],
    ['/guess/?pane=ranked&a=saved', '/guess/daily/?a=saved', 'ranked'],
    ['/guess/?pane=stream-result&result=11111111-1111-4111-8111-111111111111', '/guess/results/11111111-1111-4111-8111-111111111111/', 'stream-result'],
  ])('maps %s to a reloadable route', (old, clean, pane) => {
    const route = readGuessRoute(new URL(old, origin));
    expect(route.pane).toBe(pane);
    const next = guessRouteUrl(route.pane, new URL(old, origin), route);
    expect(next.href).toBe(origin + clean);
    expect(readGuessRoute(next)).toEqual(route);
    expect(isGuessrPagePath(next.pathname)).toBe(true);
  });
  it('retains shared snapshots and login return state without routing assets as pages', () => {
    const old = new URL('/guess/?channel=Wuote&auth_resume=ticket#clue=opaque', origin);
    const next = guessRouteUrl('stream-picker', old);
    expect(next.href).toBe(origin + '/guess/stream/wuote/?auth_resume=ticket#clue=opaque');
    expect(guessRouteUrl('home', next).href).toBe(origin + '/guess/?auth_resume=ticket');
    for (const path of ['/guess/twitch-callback.html', '/guess/twitch-callback.js', '/guessr-api/stream/rooms/wuote', '/src/guessr/main.ts', '/'])
      expect(isGuessrPagePath(path)).toBe(false);
    expect(readGuessRoute(new URL('/guess/?pane=toString', origin)).pane).toBe('home');
  });
});
