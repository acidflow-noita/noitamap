import { describe, expect, it } from 'vitest';
import { readGuessRoute, guessRouteUrl, isGuessrPagePath, gameCode, gameIdFromCode } from '../src/guessr/routes';

const origin = 'http://localhost:5173';
describe('Guessr page routes', () => {
  it('preserves a channel history link through F5 and language changes, but removes it when leaving history', () => {
    const url = new URL('/guess/history/?channel=wuote&lng=ru', origin);
    expect(readGuessRoute(url).pane).toBe('history');
    expect(guessRouteUrl('history', url).pathname).toBe('/guess/wuote/');
    expect(guessRouteUrl('history', url).searchParams.get('lng')).toBe('ru');
    expect(guessRouteUrl('home', url).searchParams.has('channel')).toBe(false);
    expect(guessRouteUrl('stream', url).searchParams.has('channel')).toBe(false);
  });
  it('opens canonical channel history without colliding with reserved panes or callbacks', () => {
    for (const path of ['/guess/wuote', '/guess/WUOTE/']) {
      const url = new URL(path, origin);
      expect(readGuessRoute(url)).toEqual({ pane: 'history', channel: 'wuote' });
      expect(isGuessrPagePath(path)).toBe(true);
    }
    for (const channel of ['daily', 'history', 'stream', 'results', 'join', 'demo']) {
      const url = guessRouteUrl('history', origin, { channel });
      expect(url.pathname).toBe('/guess/history/');
      expect(readGuessRoute(url)).toEqual({ pane: 'history', channel });
    }
    const url = guessRouteUrl('history', origin, { channel: 'wuote' });
    expect(guessRouteUrl('history', url, { channel: '' }).pathname).toBe('/guess/history/');
    for (const path of ['/guess/twitch-callback', '/guess/twitch-callback.html', '/guess/twitch-callback.js'])
      expect(isGuessrPagePath(path)).toBe(false);
  });
  it('keeps a unique game identity in the URL through refresh and login returns', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const link = guessRouteUrl('stream-picker', new URL('/guess/?auth_resume=saved', origin), { channel: 'Wuote', game: id });
    expect(link.pathname).toBe(`/guess/wuote/${gameCode(id)}/`);
    expect(gameCode(id)).toHaveLength(26);
    expect(gameIdFromCode(gameCode(id))).toBe(id);
    expect(readGuessRoute(link)).toEqual({ pane: 'stream-picker', channel: 'wuote', game: id });
    expect(guessRouteUrl('stream-picker', link).href).toBe(link.href);
    expect(isGuessrPagePath(link.pathname)).toBe(true);
    expect(readGuessRoute(guessRouteUrl('stream-picker', link, { channel: 'other' })).game).toBeUndefined();
    expect(gameIdFromCode('z'.repeat(26))).toBeUndefined();
    for (let i = 0; i < 25; i++) {
      const next = crypto.randomUUID(); expect(gameIdFromCode(gameCode(next))).toBe(next);
      expect(gameCode(next)).not.toBe(gameCode(id));
    }
    const reserved = guessRouteUrl('stream-picker', origin, { channel: 'stream', game: id });
    expect(readGuessRoute(reserved)).toEqual({ pane: 'stream-picker', channel: 'stream', game: id });
    const modern = guessRouteUrl('stream-picker', origin, { channel: 'wuote', game: id, transport: 'twitch' });
    expect(gameIdFromCode(gameCode(id, 'twitch'))).toBe(id);
    expect(readGuessRoute(modern)).toEqual({ pane: 'stream-picker', channel: 'wuote', game: id, transport: 'twitch' });
    expect(guessRouteUrl('stream-picker', modern).href).toBe(modern.href);
  });
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
