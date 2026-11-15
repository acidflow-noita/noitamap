// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://noitamap.test/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountStreamPicker } from '../src/guessr/stream-picker';
import { encodeViewerClue, viewerClueLink } from '../src/guessr/viewer-clue';
import type { TwitchViewer, TwitchViewerState } from '../src/guessr/twitch-viewer';
import type { ImageGameConfig } from '../src/guessr/image-game';
import type { Point } from '../src/guessr/rules';
import type { LiveRoomView } from '../src/guessr/live-room-types';
import type { StreamPublishedResult, StreamResult } from '../src/guessr/stream-types';
import i18next from '../src/i18n';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import { streamerProStatus } from '../src/guessr/streamer-pro-status';
import { gameCode } from '../src/guessr/routes';
import { encodeStreamPacket, guessReceiptKey } from '../src/guessr/stream-wire';
import { Blob as NodeBlob } from 'node:buffer';
import { streamArea, streamAnswer } from './helpers/guessr-stream';

const parallel = vi.hoisted(() => ({ events: undefined as Parameters<typeof import('../src/guessr/parallel-game-client')['watchParallelGame']>[3] | undefined, submit: vi.fn(), command: vi.fn(async (_message: unknown) => {}) }));
const confirmation = vi.hoisted(() => ({ quit: undefined as (() => Promise<unknown>) | undefined }));
vi.mock('../src/guessr/quit-game', () => ({ confirmQuitGame: (quit: () => Promise<unknown>) => { confirmation.quit = quit; } }));
vi.mock('../src/guessr/parallel-game-client', () => ({ watchParallelGame: (_viewer: unknown, _channel: string, _id: string, events: NonNullable<typeof parallel.events>) => {
  parallel.events = events; events.status('connected', '');
  return { hasJoined: () => true, join() {}, now: () => Date.now(), submit: parallel.submit, nextRevision: () => 1, explored() {}, command: parallel.command, receive() {}, transport() { events.status('connected', ''); }, retry() {}, requestRecovery() {}, dispose() {} };
} }));
const ui = vi.hoisted(() => ({ pick: (_point: Point) => {}, show: vi.fn(async (_camera: unknown, ready?: () => void) => { await Promise.resolve(); ready?.(); return true; }), destroy: vi.fn(), notice: vi.fn(), markers: vi.fn() }));
vi.mock('../src/guessr/button-notice', () => ({ buttonNotice: () => ({ show: ui.notice, dispose: vi.fn() }) }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {
  constructor(_element: unknown, _bounds: unknown, _overview: unknown, pick: (point: Point) => void) { ui.pick = pick; }
  onPinChange(listener: (placed: boolean) => void) { listener(false); return () => {}; }
  setMarkers(...points: unknown[]) { ui.markers(...points); } setPlayers() {} highlightPlayer() {} setLocked() {} zoom() {} home() {} destroy() { ui.destroy(); }
} }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {
  show = ui.show; destroy = ui.destroy;
} }));
const config: ImageGameConfig = {
  version: 'guessr-images-' + '1'.repeat(32), overview: '/overview.webp',
  bounds: { x: -17920, y: -31744, width: 36352, height: 73728 },
  map: { width: 36352, height: 73728, tileSize: 512, overlap: 1, maxLevel: 17, tiles: '/map-tiles' },
};
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected network request'); }));
});
afterEach(async () => { dispose?.(); dispose = undefined; document.body.replaceChildren();
  if (i18next.isInitialized) await i18next.changeLanguage('en');
  vi.unstubAllGlobals(); vi.useRealTimers(); });
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function roundLink(base = '/guess/?channel=wuote', round = 2, explore = false) {
  const payload = encodeViewerClue({ version: config.version, round, camera: { dx: 0, dy: 0, level: 0 },
    ...(explore ? { assistance: { widest: 0, travelSpent: 0 } } : {}),
    source: { frames: [{ image: '/guessr-images/images/' + '2'.repeat(32) + '.webp',
      ...(explore ? { x: -900, y: -450, width: 1800, height: 900 } : { x: -258, y: -258, width: 516, height: 516 }) }] },
  }, { version: config.version, imageRoot: '/guessr-images/images' });
  return viewerClueLink(new URL(base, location.origin).href, payload).url;
}
function mount(url: string, initial: Partial<TwitchViewerState> = {}) {
  history.replaceState(null, '', url);
  let state: TwitchViewerState = { connected: false, connecting: false, sending: false, userId: null, login: null, expiresAt: null, error: null, ...initial };
  const listeners = new Set<() => void>();
  const update = (value: Partial<TwitchViewerState>) => { state = { ...state, ...value }; listeners.forEach(fn => fn()); };
  const viewer = {
    getState: () => ({ ...state }),
    subscribe(fn: () => void) { listeners.add(fn); fn(); return () => listeners.delete(fn); },
    connect: vi.fn(async () => update({ connected: true, login: 'chatter', userId: '123' })),
    disconnect: vi.fn(() => update({ connected: false, login: null, userId: null })),
    sendGuess: vi.fn(async () => 'sent-id'),
    sendMessage: vi.fn(async (_channel: string, _message: string) => 'sent-chat-id'),
    watchChat: vi.fn((_channel: string, _handlers: Record<string, unknown>) => vi.fn()),
  };
  const page = document.createElement('div');
  page.innerHTML = '<header class="site-header"><span>Logo</span><div class="header-actions"></div></header>';
  const main = document.createElement('main'); page.append(main); document.body.append(page);
  const leave = vi.fn(() => { dispose?.(); dispose = undefined; page.remove(); });
  dispose = mountStreamPicker(main, config, viewer as unknown as TwitchViewer, '/guessr-images/images', leave);
  const button = (label: string) => [...page.querySelectorAll('button')].find(b => b.textContent === label)!;
  return { main, viewer, update, button, leave };
}

describe('shared channel guess picker', () => {
  it('lets a PvP creator lock a private guess with no chat connection, and keeps it locked before the next snapshot', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const f = mount(`/guess/pvp/${gameCode(id, 'pvp')}/`, { connected: true, login: 'wuote', userId: '456' });
    const state: LiveRoomView = { schema: 1, mode: 'pvp', streaming: false, channel: 'wuote', gameId: id, hostId: '456',
      revision: 1, phase: 'guess', online: true, paused: false, round: 1, totalRounds: 5, roundId: id,
      clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6), expiresAt: Date.now() + 999999,
      timing: { phase: 'play', startsAt: Date.now() - 1000, deadline: Date.now() + 30000, seconds: 30, hostRound: 1, chatRound: 1 },
      pvp: { creator: true, active: true, locked: false, opponentLocked: false, ready: [], players: [
        { id: '456', login: 'wuote', name: 'WUOTE' }, { id: '123', login: 'opponent', name: 'Opponent' },
      ] } };
    parallel.events!.state(state); ui.pick(streamAnswer);
    expect(f.button('Lock guess').disabled).toBe(false);
    expect(f.viewer.watchChat).not.toHaveBeenCalled();
    f.button('Lock guess').click();
    await vi.waitFor(() => expect(parallel.submit).toHaveBeenCalledOnce());
    expect(f.viewer.sendGuess).not.toHaveBeenCalled(); expect(f.viewer.sendMessage).not.toHaveBeenCalled();
    const submitted = parallel.submit.mock.calls[0][0];
    parallel.events!.durableReceipt({ type: 'receipt', round: 1, accepted: true, ...submitted });
    await vi.waitFor(() => expect(f.button('Guess locked')?.disabled).toBe(true));
    ui.pick({ x: streamAnswer.x + 10, y: streamAnswer.y });
    expect(f.button('Guess locked').disabled).toBe(true);
    expect(parallel.submit).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it('binds PvP start approval to the named ready opponent and hides the inactive warm-up map', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const f = mount(`/guess/pvp/${gameCode(id, 'pvp')}/`, { connected: true, login: 'wuote', userId: '456' });
    const state: LiveRoomView = { schema: 1, mode: 'pvp', streaming: true, channel: 'wuote', gameId: id, hostId: '456',
      revision: 1, phase: 'waiting', online: true, paused: false, round: 1, totalRounds: 5, roundId: id, clue: null, expiresAt: Date.now() + 999999,
      timing: { phase: 'lobby', startsAt: Date.now(), deadline: null, seconds: 30, hostRound: 1, chatRound: 1 },
      pvp: { creator: true, active: false, locked: false, opponentLocked: false, ready: [], players: [
        { id: '456', login: 'wuote', name: 'WUOTE' }, { id: '123', login: 'opponent', name: 'Opponent' },
      ] } };
    parallel.events!.state(state);
    expect(f.button('Start game').disabled).toBe(true);
    expect(f.main.querySelector('.pvp-lobby-players')!.textContent).toContain('WUOTE');
    expect(f.main.querySelector('.pvp-lobby-players')!.textContent).toContain('Opponent');
    expect(f.main.querySelector('.pvp-lobby-players')!.textContent).toContain('Not ready');
    parallel.events!.state({ ...state, revision: 2, pvp: { ...state.pvp!, ready: ['123'] } });
    expect(f.main.querySelector('.pvp-lobby-players')!.textContent).toContain('Ready');
    f.button('Start game').click(); await flush();
    expect(parallel.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', opponentId: '123' }));
    parallel.events!.state({ ...state, revision: 3, timing: { ...state.timing!, phase: 'warmup', deadline: Date.now() + 30000 } });
    expect(f.main.querySelector<HTMLElement>('.pvp-lobby')!.hidden).toBe(false);
    expect(f.main.querySelector('.pvp-lobby')!.textContent).toContain('You will play this location after your opponent.');
    expect(f.main.querySelector('.stream-viewer-clue .clue')).toBeNull();
    expect(f.viewer.watchChat).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a conceded PvP match on results, then uses its published result URL instead of returning home', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const f = mount(`/guess/pvp/${gameCode(id, 'pvp')}/`, { connected: true, login: 'wuote', userId: '456' });
    const host = { id: '456', login: 'wuote', name: 'WUOTE' }, opponent = { id: '123', login: 'opponent', name: 'Opponent' };
    const state: LiveRoomView = { schema: 1, mode: 'pvp', streaming: false, channel: 'wuote', gameId: id, hostId: '456',
      revision: 1, phase: 'guess', online: true, paused: false, round: 1, totalRounds: 5, roundId: id, clue: null, expiresAt: Date.now() + 999999,
      timing: { phase: 'play', startsAt: Date.now() - 1000, deadline: Date.now() + 30000, seconds: 30, hostRound: 1, chatRound: 1 },
      pvp: { creator: true, active: true, locked: false, opponentLocked: false, ready: [], players: [host, opponent] } };
    parallel.events!.state(state); f.button('Exit game').click();
    await confirmation.quit!(); expect(parallel.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'quit' }));
    expect(f.leave).not.toHaveBeenCalled();
    const result: StreamResult = { schema: 1, mode: 'pvp', id, version: config.version, config, host,
      concededBy: host.id, scheduledRounds: 5, createdAt: Date.now() - 60000, finishedAt: Date.now(), rounds: [],
      players: [{ ...host, rank: 2, score: 0, rounds: [] }, { ...opponent, rank: 1, score: 0, rounds: [] }] };
    parallel.events!.state({ ...state, phase: 'complete', revision: 2, result });
    expect(f.main.querySelector('.stream-viewer-results')!.textContent).toContain('WUOTE conceded the match.');
    expect(f.main.querySelector('.stream-viewer-results .stream-rank-column')).not.toBeNull();
    parallel.events!.published(result); expect(location.pathname).toBe(`/guess/results/${id}/`);
    expect(f.leave).not.toHaveBeenCalled();
  });

  it('uses the full published result on the chatter game URL, with shared menus, previews and inline reviews', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const url = `/guess/wuote/${gameCode(id, 'parallel')}/`;
    const f = mount(url, { connected: true, login: 'chatter', userId: '123' });
    const host = { id: '456', login: 'wuote', name: 'WUOTE' };
    const completed: StreamResult = { schema: 1, id, version: config.version, config, host, createdAt: Date.now() - 60000, finishedAt: Date.now(),
      rounds: Array.from({ length: 3 }, (_, i) => ({ id: String(i), name: 'Mines', answer: streamAnswer, difficultyTier: 'normal' })),
      positions: { '456': [null, null, null], '123': [[streamAnswer.x, streamAnswer.y], null, null] },
      players: [
        { ...host, rank: 2, score: 0, rounds: Array.from({ length: 3 }, () => ({ score: 0, areaScore: 0, positionScore: 0 })) },
        { id: '123', login: 'chatter', name: 'Chatter', rank: 1, score: 5000, rounds: Array.from({ length: 3 }, (_, i) => ({ score: i ? 0 : 5000, areaScore: i ? 0 : 1500, positionScore: i ? 0 : 3500 })) },
      ] };
    const complete: LiveRoomView = { schema: 1, channel: 'wuote', gameId: id, hostId: host.id, revision: 2, phase: 'complete',
      online: true, paused: false, round: 3, totalRounds: 3, roundId: null, clue: null, expiresAt: Date.now() + 999999, resultId: id };
    parallel.events!.state(complete);
    parallel.events!.published(completed);
    const results = f.main.querySelector('.stream-viewer-results')!, summary = results.firstElementChild;
    expect(results.textContent).toContain('You finished 1st out of 2.');
    expect(results.textContent).toContain('Streamer WUOTE finished 2nd out of 2.');
    const table = results.querySelector('.table-wrap')!, menu = results.querySelector('.stream-results-menu')!;
    const reviews = results.querySelector('.stream-result-reviews')!;
    expect(menu.textContent).toContain('Share result'); expect(menu.textContent).toContain('Save results as a web page');
    expect(menu.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reviews.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const summaries = reviews.querySelectorAll<HTMLElement>('summary');
    expect(summaries).toHaveLength(3); expect(summaries[0].textContent).toBe('Round 1: Mines');
    expect(reviews.querySelectorAll('.stream-round-thumbnail')).toHaveLength(3);
    summaries[0].click(); summaries[1].click(); await flush();
    expect(reviews.querySelectorAll('details[open]')).toHaveLength(2);
    expect(reviews.querySelector('[open] .stream-review-grid .stream-round-preview')).not.toBeNull();
    expect(results.querySelector('[aria-label="Center map on marker"]')).toBeNull();
    expect(f.main.querySelector('.game-grid, dialog')).toBeNull();
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(true);
    expect(location.pathname).toBe(url);
    parallel.events!.status('retrying', 'Reconnecting…');
    expect(results.firstElementChild).toBe(summary); expect(reviews.querySelectorAll('details[open]')).toHaveLength(2);
    expect(f.viewer.sendGuess).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    f.leave();
    const previewCalls = ui.show.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ui.show).toHaveBeenCalledTimes(previewCalls);
    const restored = mount(url, { connected: true, login: 'chatter', userId: '123' });
    parallel.events!.state(complete); parallel.events!.published(completed);
    expect(restored.main.querySelector('.stream-results-menu')).not.toBeNull();
    expect(restored.main.querySelectorAll('.stream-round-thumbnail')).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps cached completed-round reviews inline while final publication is pending', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const f = mount(`/guess/wuote/${gameCode(id, 'parallel')}/`, { connected: true, login: 'chatter', userId: '123' });
    const host = { id: '456', login: 'wuote', name: 'WUOTE' };
    parallel.events!.roundResults({ round: 1, host, answer: streamAnswer, label: 'Mines', players: [
      { ...host, guess: streamAnswer, score: 5000, total: 5000 },
      { id: '123', login: 'chatter', name: 'Chatter', guess: null, score: 0, total: 0 },
    ] });
    parallel.events!.state({ schema: 1, channel: 'wuote', gameId: id, hostId: host.id, revision: 2, phase: 'complete',
      online: true, paused: false, round: 3, totalRounds: 3, roundId: null, clue: null, expiresAt: Date.now() + 999999 });
    const results = f.main.querySelector('.stream-viewer-results')!;
    results.querySelector<HTMLElement>('summary')!.click(); await flush();
    expect(results.querySelector('details[open] .stream-round-preview')).not.toBeNull();
    expect(f.main.querySelector('.game-grid')).toBeNull();
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends once over the socket, keeps a previous accepted update, and auto-submits the last moved pin at zero', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = mount(`/guess/wuote/${gameCode(id, 'parallel')}/`, { connected: true, login: 'chatter', userId: '123' });
    const state: LiveRoomView = { schema: 1, channel: 'wuote', gameId: id, hostId: '456', revision: 1, phase: 'guess',
      online: true, paused: false, round: 1, totalRounds: 5, roundId: id,
      clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6), expiresAt: now + 999999,
      timing: { phase: 'warmup', startsAt: now - 1000, deadline: now + 5000, seconds: 30, hostRound: 1 } };
    parallel.events!.state(state);
    parallel.events!.status('connected', 'Connected');
    ui.pick(streamAnswer);
    f.button('Send guess').click();
    await vi.waitFor(() => expect(parallel.submit).toHaveBeenCalledOnce());
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
    const first = parallel.submit.mock.calls[0][0];
    expect(first).toMatchObject({ point: streamAnswer, revision: 1, automatic: false });
    parallel.events!.durableReceipt({ type: 'receipt', round: 1, accepted: true, ...first });
    await vi.waitFor(() => expect(f.button('Guess received')?.disabled).toBe(true));
    expect(f.main.querySelector<HTMLElement>('.stream-delivery')!.hidden).toBe(true);
    ui.pick({ x: streamAnswer.x + 20, y: streamAnswer.y });
    now = state.timing!.deadline!;
    // The incoming close notification is itself allowed to trigger the final snapshot.
    parallel.events!.state({ ...state, revision: 2, phase: 'reveal' });
    await vi.waitFor(() => expect(parallel.submit).toHaveBeenCalledTimes(2));
    const second = parallel.submit.mock.calls[1][0];
    expect(second).toMatchObject({ point: { x: streamAnswer.x + 20, y: streamAnswer.y }, revision: 2, roundId: id, automatic: true });
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
    parallel.events!.durableReceipt({ type: 'receipt', round: 1, accepted: true, ...second });
    await vi.waitFor(() => expect(f.button('Auto-submitted')?.disabled).toBe(true));
    expect(f.main.querySelector<HTMLElement>('.stream-delivery')!.hidden).toBe(true);
    expect(f.main.querySelector('.stream-picker .stream-guess-actions')!.compareDocumentPosition(f.main.querySelector('.stream-picker .map-board')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.main.querySelector('.stream-viewer-clue .round-maximum')).not.toBeNull();
    expect(f.main.querySelector('.stream-picker .round-maximum')).toBeNull();
  });

  it('shares the released round table without interrupting the active clue, then restores the same result countdown after F5', async () => {
    const gameId = '11111111-1111-4111-8111-111111111111', roundId = '22222222-2222-4222-8222-222222222222';
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const url = `/guess/wuote/${gameCode(gameId, 'parallel')}/`;
    let f = mount(url, { connected: true, login: 'chatter', userId: '123' });
    const state: LiveRoomView = { schema: 1, channel: 'wuote', hostId: '456', gameId, revision: 1, phase: 'guess', online: true, paused: false,
      round: 2, totalRounds: 5, roundId, clue: new URL(roundLink('/guess/?channel=wuote', 2, true)).hash.slice(6), expiresAt: now + 999999,
      timing: { phase: 'play', startsAt: now - 1000, deadline: now + 5000, seconds: 30, hostRound: 1, chatRound: 2 } };
    parallel.events!.state(state); parallel.events!.status('connected', 'Connected'); ui.pick(streamAnswer);
    parallel.events!.roundResults({ round: 1, host: { id: '456', login: 'wuote', name: 'WUOTE' }, answer: streamAnswer, label: 'Mines', players: [
      { id: '456', login: 'wuote', name: 'WUOTE', guess: streamAnswer, score: 5000, total: 5000 },
      { id: '123', login: 'chatter', name: 'Chatter', guess: null, score: 0, total: 0 },
    ] });
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(true);
    f.button('Round 1 results').click();
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(false);
    expect(f.main.querySelectorAll('.stream-shared-round tbody tr')).toHaveLength(2);
    expect(f.main.querySelector('.stream-shared-round .game-actions')!.compareDocumentPosition(f.main.querySelector('.stream-shared-round table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.main.querySelector('.stream-shared-round .score-perfect')!.textContent).toBe('5,000');
    f.button('Back to round 2').click();
    expect(f.button('Send guess').disabled).toBe(false);
    now += 5000;
    const closed: LiveRoomView = { ...state, phase: 'reveal', revision: 2, timing: { ...state.timing!, resultsUntil: now + 30000 } };
    parallel.events!.state(closed);
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(false);
    expect(f.main.querySelector('.stream-round-timer')!.textContent).toBe('00:30');
    f.leave(); now += 7000;
    f = mount(url, { connected: true, login: 'chatter', userId: '123' });
    parallel.events!.state(closed);
    expect(f.main.querySelector<HTMLElement>('.stream-shared-round')!.hidden).toBe(false);
    expect(f.main.querySelector('.stream-round-timer')!.textContent).toBe('00:23');
    expect(f.main.querySelectorAll('.stream-shared-round tbody tr')).toHaveLength(2);
  });

  it('asks for the streamer’s game link instead of presenting a channel connection form', () => {
    const f = mount('/guess/?pane=stream-picker&channel=bad%2Fchannel');
    expect(f.main.querySelector('iframe')).toBeNull();
    expect(f.main.querySelector('input[name=channel]')).toBeNull();
    expect(f.main.textContent).toContain('Open the game link shared by your streamer.');

    f.button('Back').click(); expect(f.leave).toHaveBeenCalledOnce();
  });

  it('does not pretend a channel-only link is round 1 or let an unseen clue be submitted', async () => {
    const f = mount('/guess/?channel=wuote');
    expect(f.main.textContent).toContain('Open the game link shared by your streamer.');
    expect(f.main.textContent).not.toContain('Round 1');
    expect(f.button('Send guess')).toBeUndefined();
    expect(ui.show).not.toHaveBeenCalled();
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
  });
});
