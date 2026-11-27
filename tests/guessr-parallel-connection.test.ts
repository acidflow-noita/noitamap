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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('WebSocket required', { status: 426 })));
});
afterEach(() => { connection?.dispose(); connection = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function authorized(socket: Socket, clueReplays?: true) {
  socket.open(); await Promise.resolve(); await Promise.resolve();
  socket.receive({ type: 'authorized', ticket: 'safe-resume-ticket', expiresAt: Date.now() + 600000,
    player: { id: '200', name: 'Player', login: 'player' }, now: Date.now(), clueReplays });
}
it('flushes displayed clue moves ahead of the guess and reloads only the requested recording', async () => {
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game,'200',async () => ({role:'player',accessToken:'test'}), {message:vi.fn(),status:vi.fn()});
  const socket=Socket.all[0];await authorized(socket,true);
  connection.recordCamera(submission.roundId,{dx:0,dy:0,level:0});
  await vi.advanceTimersByTimeAsync(20);
  connection.recordCamera(submission.roundId,{dx:24,dy:0,level:0});
  connection.submit(submission);
  const frames=socket.sent.map(m=>JSON.parse(m));
  expect(frames.slice(-3).map(m=>m.type)).toEqual(['clue-frames','clue-frames','guess']);
  expect(frames.at(-2).frames[0].slice(1)).toEqual([24,0,0]);
  const pending=connection.readReplay(1,'200',new AbortController().signal);
  const read=JSON.parse(socket.sent.at(-1)!);expect(read).toMatchObject({type:'clue-read',round:1,player:'200'});
  socket.receive({type:'clue-replay',request:read.request,replay:null});expect(await pending).toBeNull();
});
it('keeps playing with a coordinator which predates recordings', async()=>{
  connection=new ParallelConnection('https://guessr-api.sage-data.xyz',game,'200',async()=>({role:'player',accessToken:'test'}),{message:vi.fn(),status:vi.fn()});
  const socket=Socket.all[0];await authorized(socket);
  connection.recordCamera(submission.roundId,{dx:0,dy:0,level:0});connection.submit(submission);
  expect(socket.sent.map(m=>JSON.parse(m).type)).toEqual(['authorize','guess']);
});
it('stops retrying a confirmed missing game and releases a pending End game immediately', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('Game unavailable', { status: 404 }));
  const events = { message: vi.fn(), status: vi.fn() };
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, 'host:100', async () => ({ role: 'host', ticket: 'test-ticket' }), events);
  const ended = expect(connection.command({ type: 'quit', id: 'quit-old-game' })).rejects.toThrow('This game is no longer active.');
  Socket.all[0].close(1006);
  await vi.advanceTimersByTimeAsync(10); await ended;
  expect(events.status).toHaveBeenLastCalledWith('stopped', 'This game is no longer active.');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
  connection.retry(); await vi.advanceTimersByTimeAsync(120000);
  expect(Socket.all).toHaveLength(1);
  await expect(connection.command({ type: 'quit', id: 'quit-again' })).rejects.toThrow('This game is no longer active.');
});
it.each([403, 429, 503])('does not mark a game expired after an HTTP %s and limits failure probes', async status => {
  vi.mocked(fetch).mockImplementation(async () => new Response('Game unavailable', { status }));
  const events = { message: vi.fn(), status: vi.fn() };
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', async () => ({ role: 'player', accessToken: 'test-token' }), events);
  Socket.all[0].close(1006); await vi.advanceTimersByTimeAsync(1500);
  expect(connection.state()).not.toBe('stopped'); expect(Socket.all.length).toBeGreaterThan(1);
  Socket.all.at(-1)!.close(1006); await vi.advanceTimersByTimeAsync(1500);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('ignores a stale availability response after a successful reconnect', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', async () => ({ role: 'player', accessToken: 'test-token' }), { message() {}, status() {} });
  Socket.all[0].close(1006); await vi.advanceTimersByTimeAsync(1500);
  await authorized(Socket.all.at(-1)!);
  resolve(new Response('Game unavailable', { status: 404 })); await vi.advanceTimersByTimeAsync(10);
  expect(connection.connected()).toBe(true); expect(connection.state()).toBe('connected');
});
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
  expect(JSON.parse(second.sent[0])).toEqual({ type: 'authorize', protocol: 2, role: 'resume', ticket: 'safe-resume-ticket' });
  expect(auth).toHaveBeenCalledOnce();
  expect(JSON.parse(second.sent[1])).toEqual({ type: 'guess', submission });
  second.receive({ type: 'receipt', round: 1, roundId: submission.roundId, nonce: submission.nonce, revision: 1, accepted: true });
  expect(localStorage.getItem(`noitaguessr-socket-v2:${game}:200:pending`)).toBe('[]');
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

it('does not manufacture a disconnect when the page is backgrounded during a heartbeat', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', async () => ({ role: 'player', accessToken: 'test-only-token' }), { message: vi.fn(), status: vi.fn() });
  await authorized(Socket.all[0]);
  await vi.advanceTimersByTimeAsync(10000); expect(Socket.all[0].sent.at(-1)).toBe('ping');
  visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000); expect(Socket.all).toHaveLength(1); expect(connection.connected()).toBe(true);
  visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  Socket.all[0].onmessage?.({ data: 'pong' });
  await vi.advanceTimersByTimeAsync(5000); expect(connection.connected()).toBe(true);
});

it('uses a revision above both the saved outbox and server receipt after a lost confirmation', async () => {
  localStorage.setItem(`noitaguessr-socket-v2:${game}:200:pending`, JSON.stringify([{ ...submission, revision: 4 }]));
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', async () => ({ role: 'player', accessToken: 'test-only-token' }), { message: vi.fn(), status: vi.fn() });
  const socket = Socket.all[0]; await authorized(socket);
  socket.receive({ type: 'authorized', ticket: 'safe-resume-ticket', expiresAt: Date.now() + 600000,
    player: { id: '200', name: 'Player', login: 'player' }, now: Date.now(), acceptedRevisions: { [submission.roundId]: 5 } });
  expect(connection.nextRevision(submission.roundId)).toBe(6);
  connection.submit({ ...submission, revision: 6 });
  connection.submit({ ...submission, revision: 2 });
  expect(JSON.parse(localStorage.getItem(`noitaguessr-socket-v2:${game}:200:pending`)!)[0].revision).toBe(6);
});

it('retries temporary authorization failures instead of exhausting sign-in retries', async () => {
  const auth = vi.fn().mockRejectedValueOnce(Object.assign(Error('Provider unavailable'), { code: 'unavailable' }))
    .mockResolvedValue({ role: 'player', accessToken: 'test-only-token' });
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', auth, { message: vi.fn(), status: vi.fn() });
  Socket.all[0].open(); await vi.advanceTimersByTimeAsync(1500);
  expect(connection.state()).not.toBe('stopped');
  await authorized(Socket.all[1]); expect(connection.connected()).toBe(true); expect(auth).toHaveBeenCalledTimes(2);
});

it('stops keepalives and reconnect attempts after the completed result arrives', async () => {
  connection = new ParallelConnection('https://guessr-api.sage-data.xyz', game, '200', async () => ({ role: 'player', accessToken: 'test-only-token' }), { message: vi.fn(), status: vi.fn() });
  const socket = Socket.all[0]; await authorized(socket);
  socket.receive({ type: 'published', result: { schema: 1, id: game, version: 'fixture', createdAt: 1, finishedAt: 2,
    host: { id: '100', login: 'host', name: 'Host' }, rounds: [], players: [] } });
  const sent = socket.sent.length;
  socket.close(1011); await vi.advanceTimersByTimeAsync(700000);
  expect(socket.sent).toHaveLength(sent); expect(Socket.all).toHaveLength(1); expect(connection.state()).toBe('connected');
});
