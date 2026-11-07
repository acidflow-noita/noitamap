import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const KEY = 'noitamap-guessr-connection-diagnostics-v1';
let values: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('retains only bounded error metadata across refresh and never serializes credentials or game payloads', async () => {
  const { connectionDiagnostic } = await import('../src/guessr/connection-diagnostics');
  for (let i = 0; i < 80; i++) connectionDiagnostic({ event: 'broadcast-retry', status: 429, attempt: i });
  connectionDiagnostic({ event: 'send-failed', status: 200, code: 'msg_banned',
    token: 'do-not-record', payload: 'private-round-data', url: 'https://private.test/' } as any);
  const stored = JSON.parse(values.get(KEY)!);
  expect(stored).toHaveLength(60);
  expect(stored.at(-1)).toEqual({ at: expect.any(String), event: 'send-failed', status: 200, code: 'msg_banned' });
  expect(values.get(KEY)).not.toMatch(/do-not-record|private-round-data|private.test/);
  vi.resetModules();
  const { connectionDiagnostics } = await import('../src/guessr/connection-diagnostics');
  expect(connectionDiagnostics()).toEqual(stored);
});

it('filters unexpected persisted fields and continues to work when storage is unavailable', async () => {
  values.set(KEY, JSON.stringify([{ at: new Date().toISOString(), event: 'send-failed', status: 403,
    code: 'Bearer secret', accessToken: 'secret' }, { at: 'invalid', event: 'connected' }, { at: new Date().toISOString(), event: 'unexpected' }]));
  const { connectionDiagnostics, connectionDiagnostic } = await import('../src/guessr/connection-diagnostics');
  expect(connectionDiagnostics()).toEqual([{ at: expect.any(String), event: 'send-failed', status: 403 }]);
  vi.stubGlobal('localStorage', { getItem() { throw Error('Storage blocked'); }, setItem() { throw Error('Storage blocked'); } });
  expect(() => connectionDiagnostic({ event: 'socket-close', status: 4005 })).not.toThrow();
  expect(connectionDiagnostics()).toHaveLength(2);
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: 'socket-close', status: 4005 });
});
