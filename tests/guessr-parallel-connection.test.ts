// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://noitamap.test/"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ParallelConnection } from '../src/guessr/parallel-connection';
import type { ParallelServerMessage } from '../src/guessr/parallel-types';

class Socket {
  static OPEN = 1; static all: Socket[] = [];
  readyState = 0; sent: string[] = [];
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onerror?: () => void; onclose?: (event: { code: number }) => void;
  constructor(readonly url: URL) { Socket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text: string) { this.sent.push(text); }
  receive(value: ParallelServerMessage) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
const game = '11111111-1111-4111-8111-111111111111';
const submission = { roundId: '22222222-2222-4222-8222-222222222222', point: { x: 10, y: 20 }, maximum: 4900, nonce: '1234567890abcdef', revision: 1 };
let connection: ParallelConnection | undefined;
function memoryStorage() {
  const data: Record<string, string> = {};
  return { data, getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; }, removeItem: (key: string) => { delete data[key]; } };
}
beforeEach(() => {
  vi.useFakeTimers(); Socket.all = [];
  vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage()); vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => { connection?.dispose(); connection = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
async function authorized(socket: Socket) {
  socket.open(); await Promise.resolve(); await Promise.resolve();
  socket.receive({ type: 'authorized', ticket: 'safe-resume-ticket', expiresAt: Date.now() + 600000,
    player: { id: '200', name: 'Player', login: 'player' }, now: Date.now() });
}
it('automatically reconnects and replays exactly the same unacknowledged submission without persisting provider credentials', async () => {
  const auth = vi.fn(async () => ({ role: 'player' as const, accessToken: 'test-provider-token-not-real' }));
  const events = { message: vi.fn(), status: vi.fn() };
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', auth, events);
  const first = Socket.all[0]; await authorized(first);
  expect(first.url.href).not.toContain('token');
  connection.submit(submission);
  expect(JSON.parse(first.sent.at(-1)!)).toEqual({ type: 'guess', submission });
  expect(JSON.stringify(localStorage)).not.toContain('provider-token');
  expect(JSON.stringify(sessionStorage)).not.toContain('provider-token');
  first.close(1011); await vi.advanceTimersByTimeAsync(1500);
  const second = Socket.all[1]; await authorized(second);
  expect(JSON.parse(second.sent[0])).toEqual({ type: 'authorize', role: 'resume', ticket: 'safe-resume-ticket' });
  expect(auth).toHaveBeenCalledOnce();
  expect(JSON.parse(second.sent[1])).toEqual({ type: 'guess', submission });
  second.receive({ type: 'receipt', round: 1, roundId: submission.roundId, nonce: submission.nonce, revision: 1, accepted: true });
  expect(localStorage.getItem(`noitaguessr-socket:${game}:200:pending`)).toBe('[]');
  expect(connection.connected()).toBe(true);
});
it('keeps a newer update queued when a delayed receipt for the old pin arrives, including across F5', async () => {
  const auth = async () => ({ role: 'player' as const, accessToken: 'test-only-token' });
  const events = { message: vi.fn(), status: vi.fn() };
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', auth, events);
  await authorized(Socket.all[0]); connection.submit(submission);
  const latest = { ...submission, nonce: 'abcdef1234567890', revision: 2, point: { x: 50, y: 60 } };
  connection.submit(latest);
  Socket.all[0].receive({ type: 'receipt', round: 1, roundId: submission.roundId, nonce: submission.nonce, revision: 1, accepted: true });
  connection.dispose(); connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', auth, events);
  await authorized(Socket.all[1]);
  expect(JSON.parse(Socket.all[1].sent[1])).toEqual({ type: 'guess', submission: latest });
});
it('does not keep reconnecting a superseded tab or treat a sent command as a saved command', async () => {
  const events = { message: vi.fn(), status: vi.fn() };
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, 'host:100', async () => ({ role: 'host', ticket: 'test-ticket' }), events);
  await authorized(Socket.all[0]);
  let accepted = false;
  const command = connection.command({ type: 'start', id: 'start-one' }).then(() => { accepted = true; });
  await Promise.resolve(); expect(accepted).toBe(false);
  Socket.all[0].receive({ type: 'command', id: 'start-one', accepted: true }); await command;
  expect(accepted).toBe(true);
  Socket.all[0].close(4002); await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.all).toHaveLength(1); expect(connection.state()).toBe('stopped');
});
