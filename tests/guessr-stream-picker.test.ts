// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://noitamap.test/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountStreamPicker } from '../src/guessr/stream-picker';
import { encodeViewerClue, viewerClueLink } from '../src/guessr/viewer-clue';
import type { TwitchViewer, TwitchViewerState } from '../src/guessr/twitch-viewer';
import type { ImageGameConfig } from '../src/guessr/image-game';
import type { Point } from '../src/guessr/rules';
import type { LiveRoomView } from '../src/guessr/live-room-types';
import { watchLiveRoom } from '../src/guessr/live-room-client';
import type { StreamPublishedResult } from '../src/guessr/stream-types';
import i18next from '../src/i18n';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import { streamerProStatus } from '../src/guessr/streamer-pro-status';
import { gameCode } from '../src/guessr/routes';
import { encodeStreamPacket, guessReceiptKey } from '../src/guessr/stream-wire';
import { Blob as NodeBlob } from 'node:buffer';
import { streamArea, streamAnswer } from './helpers/guessr-stream';

const ui = vi.hoisted(() => ({ pick: (_point: Point) => {}, show: vi.fn(async (_camera: unknown, ready?: () => void) => { await Promise.resolve(); ready?.(); return true; }), destroy: vi.fn(), notice: vi.fn(), markers: vi.fn() }));
vi.mock('../src/guessr/button-notice', () => ({ buttonNotice: () => ({ show: ui.notice, dispose: vi.fn() }) }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {
  constructor(_element: unknown, _bounds: unknown, _overview: unknown, pick: (point: Point) => void) { ui.pick = pick; }
  setMarkers(...points: unknown[]) { ui.markers(...points); } setLocked() {} zoom() {} home() {} destroy() { ui.destroy(); }
} }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {
  show = ui.show; destroy = ui.destroy;
} }));
vi.mock('../src/guessr/live-room-client', () => ({
  watchLiveRoom: vi.fn(() => ({ retry: vi.fn(), dispose: vi.fn() })),
}));
const config: ImageGameConfig = {
  version: 'guessr-images-' + '1'.repeat(32), overview: '/overview.webp',
  bounds: { x: -17920, y: -31744, width: 36352, height: 73728 }, map: {} as ImageGameConfig['map'],
};
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); const values = new Map<string, string>();
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
    sendMessage: vi.fn(async () => 'sent-chat-id'),
    watchChat: vi.fn((_channel: string, _handlers: Parameters<TwitchViewer['watchChat']>[1]) => vi.fn()),
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
  it('receives timed clues and receipt-confirmed scores through Twitch, then recovers them after F5 with no live Worker connection', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const id = '11111111-1111-4111-8111-111111111111';
    const url = `/guess/wuote/${gameCode(id, 'twitch')}/`;
    const f = mount(url);
    expect(f.button('Gift Pro to wuote').hidden).toBe(true);
    expect(f.main.querySelector<HTMLElement>('.stream-pro-status')!.dataset.proStatus).toBe('active');
    f.button('Sign in with Twitch').click(); await flush();
    const transport = f.viewer.watchChat.mock.calls[0][1]; transport.status('live', 'Connected');
    expect(watchLiveRoom).not.toHaveBeenCalled();
    const state: LiveRoomView = { schema: 1, channel: 'wuote', gameId: id, hostId: '456', revision: 1, phase: 'guess',
      online: true, paused: false, round: 1, roundId: id, clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6),
      expiresAt: Date.now() + 999999, timing: { phase: 'warmup', startsAt: Date.now() - 1000, deadline: Date.now() + 90000, seconds: 90, hostRound: 1 } };
    const deliver = async (payload: Parameters<typeof encodeStreamPacket>[1]) => {
      for (const text of await encodeStreamPacket(id, payload)) transport.message({ player: { id: '456', login: 'wuote', name: 'WUOTE' },
        id: crypto.randomUUID(), sentAt: Date.now(), text });
    };
    await deliver({ type: 'state', state: { ...state, phase: 'waiting', clue: null,
      timing: { ...state.timing!, phase: 'lobby', deadline: null } } });
    await vi.waitFor(() => expect(f.main.textContent).toContain('Waiting for the streamer to start the game.'));
    expect(f.main.querySelector<HTMLElement>('.stream-chat-state')!.dataset.connection).toBe('connected');
    expect(f.button('Send guess').getAttribute('aria-description')).toBe('Waiting for the streamer to start the game.');
    expect(f.main.querySelector('.stream-viewer-clue .clue')).toBeNull();
    expect(f.button('Send guess').disabled).toBe(true);
    await deliver({ type: 'state', state: { ...state, revision: 2 } });
    await vi.waitFor(() => expect(document.querySelector('.stream-toolbar-round .stream-round')!.textContent).toBe('Round 1 / 10'));
    ui.pick({ x: streamAnswer.x + .4, y: streamAnswer.y + .4 }); f.button('Send guess').click();
    await vi.waitFor(() => expect(f.viewer.sendGuess).toHaveBeenCalledOnce());
    const sent = vi.mocked(f.viewer.sendGuess).mock.calls[0] as unknown as Parameters<TwitchViewer['sendGuess']>;
    expect(sent[2]).toEqual(streamAnswer);
    let key = await guessReceiptKey(id, '123', Array.from(sent[5]!, b => b.toString(16).padStart(2, '0')).join(''));
    expect(f.button('Send guess').disabled).toBe(true);
    expect(f.main.querySelector('.stream-delivery')!.textContent).toBe('Sent to Twitch. Waiting for the streamer’s confirmation.');
    await deliver({ type: 'receipts', round: 0, keys: ['ffffffffffffffff'], rejected: true, reason: 'closed' });
    await flush(); ui.pick({ x: streamAnswer.x + 10, y: streamAnswer.y });
    expect(f.button('Update guess').disabled).toBe(false);
    ui.pick(streamAnswer);
    await deliver({ type: 'receipts', round: 0, keys: [key], rejected: true, reason: 'unreceived' });
    await vi.waitFor(() => expect(f.button('Resend guess')?.disabled).toBe(false));
    expect(f.viewer.sendGuess).toHaveBeenCalledOnce();
    f.button('Resend guess').click();
    await vi.waitFor(() => expect(f.viewer.sendGuess).toHaveBeenCalledTimes(2));
    const retry = vi.mocked(f.viewer.sendGuess).mock.calls[1] as unknown as Parameters<TwitchViewer['sendGuess']>;
    expect(retry[2]).toEqual(streamAnswer);
    key = await guessReceiptKey(id, '123', Array.from(retry[5]!, b => b.toString(16).padStart(2, '0')).join(''));
    await deliver({ type: 'receipts', round: 0, keys: [key] });
    await vi.waitFor(() => expect(f.main.querySelector('.stream-delivery')!.textContent).toBe('Guess received'));
    expect(ui.notice).not.toHaveBeenCalled();
    await deliver({ type: 'state', state: { ...state, revision: 2, round: 2, roundId: '22222222-2222-4222-8222-222222222222',
      clue: new URL(roundLink('/guess/?channel=wuote', 2, true)).hash.slice(6), timing: { ...state.timing!, phase: 'play', revealed: 1 } } });
    await deliver({ type: 'reveal', round: 0, reveal: { roundId: id, answer: streamAnswer, area: streamArea } });
    await vi.waitFor(() => expect([...f.main.querySelectorAll('button')].find(b => b.textContent === 'Round 1: 5,000')).toBeDefined());
    const review = [...f.main.querySelectorAll('button')].find(b => b.textContent === 'Round 1: 5,000')!;
    review.click(); expect(ui.markers).toHaveBeenLastCalledWith(streamAnswer, streamAnswer);
    f.leave();
    const restored = mount(url, { savedUserId: '123', restoring: true });
    expect(restored.main.textContent).toContain('5,000');
    expect(restored.button('Send guess').disabled).toBe(true);
    expect(watchLiveRoom).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not restart a chatter countdown when the streamer begins round ten, and remembers the published game', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const id = '11111111-1111-4111-8111-111111111111';
    const f = mount(`/guess/wuote/${gameCode(id, 'twitch')}/`);
    f.button('Sign in with Twitch').click(); await flush();
    const transport = f.viewer.watchChat.mock.calls[0][1]; transport.status('live', 'Connected');
    const state: LiveRoomView = { schema: 1, channel: 'wuote', gameId: id, hostId: '456', revision: 1, phase: 'reveal',
      online: true, paused: false, round: 10, roundId: id, clue: new URL(roundLink('/guess/?channel=wuote', 10, true)).hash.slice(6),
      expiresAt: Date.now() + 999999, timing: { phase: 'play', startsAt: Date.now() + 3000, deadline: null, seconds: 90, hostRound: 10, chatRound: null } };
    const deliver = async () => {
      for (const text of await encodeStreamPacket(id, { type: 'state', state })) transport.message({ player: { id: '456', login: 'wuote', name: 'WUOTE' },
        id: crypto.randomUUID(), sentAt: Date.now(), text });
    };
    await deliver();
    await vi.waitFor(() => expect(f.main.textContent).toContain('You have finished all 10 rounds. Waiting for the streamer.'));
    expect(f.main.textContent).not.toContain('Starting in');
    expect(f.main.querySelector<HTMLElement>('.stream-round-timer')!.hidden).toBe(true);
    state.phase = 'complete'; state.revision++; state.resultId = id;
    await deliver(); await vi.waitFor(() => expect(localStorage.getItem('noitamap-guessr-published-history')).toContain(id));
    expect(JSON.parse(localStorage.getItem('noitamap-guessr-published-history')!)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled(); expect(watchLiveRoom).not.toHaveBeenCalled();
  });

  it('never switches a game-specific link to another game hosted by the same channel', async () => {
    const f = mount('/guess/wuote/00000000000000000000000001/');
    const handlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const state: LiveRoomView = {
      schema: 1, channel: 'wuote', gameId: '00000000-0000-0000-0000-000000000001',
      roundId: '22222222-2222-4222-8222-222222222222', revision: 1, phase: 'guess', online: true, paused: false,
      round: 1, clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6), expiresAt: Date.now() + 99999,
    };
    handlers.state(state); handlers.status('connected', '');
    f.button('Sign in with Twitch').click(); await flush(); ui.pick({ x: 10, y: 20 });
    expect(f.button('Send guess').disabled).toBe(false);
    handlers.state({ ...state, revision: 2, gameId: '00000000-0000-0000-0000-000000000002' });
    expect(f.button('Send guess').disabled).toBe(true);
    expect(f.main.textContent).toContain('This game is no longer active.');
    expect(location.pathname).toBe('/guess/wuote/00000000000000000000000001/');
    expect(f.main.querySelector<HTMLAnchorElement>('.stream-guess-actions a')!.href)
      .toContain('/guess/results/00000000-0000-0000-0000-000000000001/');
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
  });
  it('shows combined connection health without polling or moving the indicator', async () => {
    const f = mount('/guess/stream/wuote/');
    f.button('Sign in with Twitch').click(); await flush();
    const room = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const chat = f.viewer.watchChat.mock.calls[0][1];
    const light = f.main.querySelector<HTMLElement>('.stream-chat-state')!;
    const parent = light.parentElement;
    chat.status('live', 'Connected');
    expect(light.dataset.connection).toBe('connecting');
    room.status('connected', '');
    expect(light.dataset.connection).toBe('connected');
    expect(light.getAttribute('aria-description')).toContain('Connected to the game.');
    room.status('retrying', 'Reconnecting to the NoitaGuessr game…');
    expect(light.dataset.connection).toBe('reconnecting');
    expect(light.getAttribute('aria-description')).toContain('Reconnecting to the NoitaGuessr game');
    room.status('stopped', 'NoitaGuessr game connection unavailable. Try reconnecting.');
    expect(light.dataset.connection).toBe('disconnected');
    expect(light.parentElement).toBe(parent);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      window.dispatchEvent(new Event('offline'));
      expect(light.dataset.connection).toBe('network-issues');
      expect(light.getAttribute('aria-label')).toBe('Network issues');
      expect(light.getAttribute('aria-description')).toContain('You are offline.');
      expect(f.button('Send guess').disabled).toBe(true);
      expect(light.parentElement).toBe(parent);
      expect(fetch).not.toHaveBeenCalled();
    } finally { online.mockRestore(); }
  });
  it('keeps transport failures separate from streamer selection and permits switching games without signing out', async () => {
    const f = mount('/guess/stream/missing_streamer/');
    expect(f.main.querySelector('.stream-chat-state')!.getAttribute('aria-label')).toBe('Twitch sign-in required');
    f.button('Sign in with Twitch').click(); await flush();
    const oldRoom = vi.mocked(watchLiveRoom).mock.results[0].value;
    const oldRoomHandlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const oldChatStop = f.viewer.watchChat.mock.results[0].value;
    const oldChatHandlers = f.viewer.watchChat.mock.calls[0][1];
    oldChatHandlers.status('reconnecting', 'Reconnecting to chat…');
    const status = f.main.querySelector<HTMLElement>('.stream-chat-state')!;
    expect(status.getAttribute('aria-label')).toBe('Reconnecting…');
    expect(status.getAttribute('aria-description')).toContain('Reconnecting to chat');
    expect(status.hasAttribute('title')).toBe(false);
    expect(f.button('Gift Pro to missing_streamer').hidden).toBe(false);
    f.button('Exit game').click();
    expect(oldRoom.dispose).toHaveBeenCalledOnce();
    expect(oldChatStop).toHaveBeenCalledOnce();
    expect(f.viewer.disconnect).not.toHaveBeenCalled();
    expect(f.viewer.getState().connected).toBe(true);
    expect(f.leave).toHaveBeenCalledOnce();
    oldChatHandlers.status('live', 'Connected');
    oldRoomHandlers.status('connected', '');
    expect(status.isConnected).toBe(false);
    const next = mount('/guess/stream/dunkorslam/');
    expect(watchLiveRoom).toHaveBeenCalledTimes(2);
    const gift = next.button('Gift Pro to dunkorslam');
    expect(gift.classList.contains('btn-patron')).toBe(true);
    expect(gift.hidden).toBe(true);
    expect(gift.getAttribute('aria-description')).toContain('Gift dunkorslam a subscription to wuote’s Twitch channel.');
  });

  it('keeps Pro admission and hides gifting throughout the game without subscription requests', () => {
    vi.useFakeTimers();
    const f = mount('/guess/stream/streamer/');
    const handlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const badge = f.main.querySelector<HTMLElement>('.stream-pro-status')!;
    expect(badge.dataset.proStatus).toBe('unknown');
    expect(badge.hidden).toBe(true);
    const state: LiveRoomView = { schema: 1, channel: 'streamer', hostId: '456', gameId: '11111111-1111-4111-8111-111111111111', revision: 1,
      phase: 'waiting', online: true, paused: false, round: 0, roundId: null, clue: null, expiresAt: null,
      hostPro: 'active', hostProVerifiedUntil: Date.now() + 1000 };
    handlers.state({ ...state, revision: 0, gameId: null, hostPro: 'unknown', hostProVerifiedUntil: undefined });
    expect(badge.hidden).toBe(true);
    handlers.state(state);
    expect(badge.textContent).toBe('Pro');
    expect(badge.hidden).toBe(false);
    expect(badge.tagName).toBe('SPAN');
    expect(f.button('Gift Pro to streamer').hidden).toBe(true);
    vi.advanceTimersByTime(500);
    handlers.state({ ...state, revision: 2, hostProVerifiedUntil: Date.now() + 2000 });
    vi.advanceTimersByTime(600);
    expect(badge.dataset.proStatus).toBe('active');
    vi.advanceTimersByTime(1400);
    handlers.state({ ...state, revision: 3, hostPro: 'unknown', hostProVerifiedUntil: undefined });
    expect(badge.textContent).toBe('Pro');
    expect(badge.getAttribute('aria-description')).toContain('confirmed for this game');
    expect(f.button('Gift Pro to streamer').hidden).toBe(true);
    expect(watchLiveRoom).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('identifies a local test without claiming paid status, even when a proof is supplied', () => {
    const status = streamerProStatus({ local: true });
    expect(status.badge.hidden).toBe(true);
    status.update({ gameId: '11111111-1111-4111-8111-111111111111', hostPro: 'active', hostProVerifiedUntil: Date.now() + 60000 });
    expect(status.badge.textContent).toBe('Local test');
    expect(status.badge.dataset.proStatus).toBe('local');
    expect(status.badge.getAttribute('aria-description')).toContain('not checked here');
    status.dispose();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('changes language without reconnecting transport or losing the pin and clue progress', async () => {
    await initializeGuessrTranslations();
    i18next.addResourceBundle('de', 'translation', {}, true, true);
    i18next.addResourceBundle('de', 'guessr', { 'Send guess': 'Tipp senden', 'Twitch chat connected': 'Twitch-Chat verbunden',
      'Playing as {{player}}': 'Du spielst als {{player}}', 'Connected': 'Verbunden' }, true, true);
    const f = mount(roundLink('/guess/?channel=wuote', 2, true)); await flush();
    f.button('Sign in with Twitch').click(); await flush();
    const chat = f.main.querySelector('.stream-connection-bar')!;
    const handlers = f.viewer.watchChat.mock.calls[0][1];
    handlers.status('live', 'Chat connected. Latest valid guess received before you submit counts.');
    handlers.message({ id: 'raw-message', text: 'Send guess', sentAt: Date.now(), player: { id: '789', login: 'rank', name: 'Rank' } });
    expect(chat.querySelector('.stream-chat-composer')).toBeNull();
    ui.pick({ x: 10, y: 20 });
    f.main.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click(); await flush();
    const clueLoads = ui.show.mock.calls.length;
    const connectionStatus = chat.querySelector('.stream-chat-state')!;
    expect(connectionStatus.textContent).toBe('');
    expect(connectionStatus.getAttribute('aria-label')).toBe('Connected');
    expect(connectionStatus.parentElement?.classList.contains('stream-chat-identity')).toBe(true);
    expect(connectionStatus.classList.contains('stream-chat-state-online')).toBe(true);
    expect(connectionStatus.getAttribute('aria-description')).toContain('Twitch chat connected');
    await i18next.changeLanguage('de');
    expect(f.main.querySelector('.stream-connection-bar')).toBe(chat);
    expect(connectionStatus.textContent).toBe('');
    expect(connectionStatus.getAttribute('aria-label')).toBe('Verbunden');
    expect(chat.querySelector('.stream-chat-message')).toBeNull();
    expect(chat.textContent).not.toContain('Rank: Send guess');
    expect(f.button('Tipp senden').disabled).toBe(false);
    expect(ui.show).toHaveBeenCalledTimes(clueLoads);
    expect(f.viewer.watchChat).toHaveBeenCalledTimes(1);
    f.button('Tipp senden').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenCalledExactlyOnceWith('wuote', 2, { x: 10, y: 20 }, 4600);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reveals the recorded pin, answer and earned score, then shows final standings without a result request', async () => {
    const f = mount('/guess/stream/wuote/');
    const handlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const state: LiveRoomView = {
      schema: 1, channel: 'wuote', hostId: '456', gameId: '11111111-1111-4111-8111-111111111111',
      roundId: '22222222-2222-4222-8222-222222222222', revision: 1,
      phase: 'guess', online: true, paused: false, round: 1,
      difficultyTier: 'normal',
      clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6), expiresAt: Date.now() + 99999,
    };
    handlers.state(state); handlers.status('connected', ''); await flush();
    expect(f.main.querySelector('[data-clue-difficulty]')!.textContent).toBe('Normal difficulty');
    expect(f.main.querySelector('[data-clue-maximum]')!.textContent).toBe('Up to 5,000 points');
    expect(f.main.querySelector<HTMLElement>('.stream-budget-bar')!.hidden).toBe(false);
    f.button('Sign in with Twitch').click(); await flush(); ui.pick({ x: 10, y: 20 });
    f.button('Send guess').click(); await flush();
    expect(f.main.querySelector<HTMLElement>('.stream-round-outcome')!.hidden).toBe(true);
    ui.pick({ x: 15000, y: 14000 }); // An unsubmitted edit must not replace the scored blue marker.
    const outcome = { roundId: state.roundId!, answer: { x: 512, y: 512 }, label: 'Coal Pits', difficultyTier: 'normal' as const,
      players: [{ id: '123', guess: { x: 10, y: 20 }, score: 4500, areaScore: 1000, positionScore: 3500, distance: 703 }] };
    handlers.state({ ...state, phase: 'reveal', revision: 2, outcome }); await flush();
    expect(f.main.querySelector<HTMLElement>('.stream-round-outcome')!.hidden).toBe(false);
    expect(f.main.querySelector('.stream-round-outcome .round-points')!.textContent).toBe('4,500 points');
    expect(f.main.querySelector<HTMLElement>('.stream-budget-bar')!.hidden).toBe(true);
    expect(f.main.querySelector('.stream-reveal-distance')!.textContent).toBe('1.4 chunks away');
    expect(ui.markers).toHaveBeenLastCalledWith({ x: 10, y: 20 }, outcome.answer);
    const chat = f.main.querySelector('.stream-chat');
    const result: StreamPublishedResult = {
      schema: 1, format: 'compact-scores-v1', id: state.gameId!, version: config.version, createdAt: 1, finishedAt: 2,
      host: { id: '456', login: 'wuote', name: 'Streamer' },
      rounds: Array.from({ length: 10 }, (_, i) => ({ id: String(i), answer: outcome.answer, name: 'Coal Pits', difficultyTier: 'normal' })),
      players: [
        { id: '123', login: 'chatter', name: 'Chatter', score: 45000, rank: 1, rounds: Array.from({ length: 10 }, () => [1000, 3500]) },
        { id: '456', login: 'wuote', name: 'Streamer', score: 30000, rank: 2, rounds: Array.from({ length: 10 }, () => [1000, 2000]) },
      ],
    };
    handlers.state({ ...state, phase: 'complete', revision: 3, outcome, resultId: result.id, result }); await flush();
    const panel = f.main.querySelector<HTMLElement>('.stream-viewer-results')!;
    expect(panel.hidden).toBe(false); expect(panel.textContent).toContain('Your result');
    expect(panel.textContent).toContain('45,000 points'); expect(panel.textContent).toContain('Rank 1 of 2');
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(panel.querySelector('a')!.href).toBe(location.origin + '/guess/results/' + state.gameId + '/');
    expect(f.main.querySelector('.stream-chat')).toBe(chat);
    expect(watchLiveRoom).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it('explains when the connected chatter is the actual host instead of silently accepting a duplicate player', async () => {
    const f = mount('/guess/stream/wuote/');
    const handlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    handlers.state({ schema: 1, channel: 'wuote', hostId: '123', gameId: '11111111-1111-4111-8111-111111111111',
      roundId: '22222222-2222-4222-8222-222222222222', revision: 1, phase: 'guess', online: true, paused: false,
      round: 1, clue: new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6), expiresAt: Date.now() + 99999 });
    handlers.status('connected', ''); f.button('Sign in with Twitch').click(); await flush(); ui.pick({ x: 10, y: 20 });
    expect(f.button('Send guess').disabled).toBe(true);
    expect(f.button('Send guess').getAttribute('aria-description')).toContain('streamer tab');
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
  });
  it('keeps one channel link and chat connection while live rounds advance, closes late guesses and restores current clue for late joins', async () => {
    const f = mount('/guess/?channel=wuote');
    const handlers = vi.mocked(watchLiveRoom).mock.calls[0][1];
    const payload = new URL(roundLink('/guess/?channel=wuote', 1, true)).hash.slice(6);
    const state: LiveRoomView = {
      schema: 1, channel: 'wuote', gameId: '11111111-1111-4111-8111-111111111111',
      roundId: '22222222-2222-4222-8222-222222222222',
      revision: 1, phase: 'guess', online: true, paused: false, round: 1, clue: payload, expiresAt: Date.now() + 99999,
    };
    handlers.state(state); handlers.status('connected', ''); await flush();
    expect(document.querySelector('.stream-toolbar-round .stream-round')!.textContent).toBe('Round 1 / 10');
    ui.pick({ x: 10, y: 20 }); f.button('Sign in with Twitch').click(); await flush();
    f.button('Send guess').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenCalledWith('wuote', 1, { x: 10, y: 20 }, 5000, state.roundId);
    ui.pick({ x: 11, y: 22 });
    handlers.state({ ...state, revision: 2, phase: 'reveal' });
    expect(f.button('Send guess').disabled).toBe(true);
    f.button('Send guess').click(); expect(f.viewer.sendGuess).toHaveBeenCalledTimes(1);
    const second = { ...state, revision: 3, round: 2, roundId: '33333333-3333-4333-8333-333333333333',
      clue: new URL(roundLink('/guess/?channel=wuote', 2, true)).hash.slice(6) };
    handlers.state(second); await flush();
    expect(document.querySelector('.stream-toolbar-round .stream-round')!.textContent).toBe('Round 2 / 10');
    expect(f.button('Send guess').disabled).toBe(true); // Old pin cannot carry into the new round.
    expect(f.viewer.watchChat).toHaveBeenCalledTimes(1);
    expect(watchLiveRoom).toHaveBeenCalledTimes(1);
    expect(new URL(location.href).hash).toBe('');
    ui.pick({ x: 30, y: 40 });
    handlers.status('retrying', 'Reconnecting…');
    expect(f.button('Send guess').disabled).toBe(true);
    handlers.state(second); handlers.status('connected', '');
    expect(f.button('Send guess').disabled).toBe(false);
    f.button('Send guess').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenLastCalledWith('wuote', 2, { x: 30, y: 40 }, 5000, second.roundId);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses one account and a persistent submission status without replacing controls or showing popovers', async () => {
    const f = mount(roundLink('/guess/?channel=Wuote'));
    expect(f.main.querySelector('iframe')).toBeNull();
    expect(f.button('Sign in with Twitch').closest('.stream-picker')).not.toBeNull();
    expect(f.button('Send guess').closest('.stream-picker')).not.toBeNull();
    expect(f.button('Send guess').disabled).toBe(true);
    ui.pick({ x: -3152, y: 874 });
    f.button('Sign in with Twitch').click(); await flush();
    expect(f.viewer.watchChat).toHaveBeenCalledWith('noitaguessr', expect.any(Object));
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
    const layout = [...f.main.children];
    f.button('Send guess').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenCalledExactlyOnceWith('wuote', 2, { x: -3152, y: 874 });
    expect(f.button('Send guess').disabled).toBe(true);
    f.button('Send guess').click();
    expect(f.viewer.sendGuess).toHaveBeenCalledTimes(1);
    expect([...f.main.children]).toEqual(layout);
    expect(f.main.textContent).not.toContain('Sent to');
    expect(ui.notice).not.toHaveBeenCalled();
    expect(f.main.querySelector('.stream-delivery')!.textContent).toBe('Guess sent');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the shared clue and takes its round instead of a conflicting query parameter', async () => {
    const camera = { dx: 0, dy: 0, level: 0 };
    const payload = encodeViewerClue({ version: config.version, round: 3, camera,
      source: { frames: [{ image: '/guessr-images/images/' + '2'.repeat(32) + '.webp', x: -258, y: -258, width: 516, height: 516 }] },
    }, { version: config.version, imageRoot: '/guessr-images/images' });
    const url = viewerClueLink(location.origin + '/guess/?pane=stream-picker&channel=wuote&round=1', payload).url;
    const f = mount(url); await flush();
    expect(f.main.querySelector('.has-clue')).not.toBeNull();
    expect(ui.show).toHaveBeenCalledWith(camera);
    expect(document.querySelector('.stream-toolbar-round .stream-round')!.textContent).toBe('Round 3 / 10');
    ui.pick({ x: 0, y: 0 }); f.button('Sign in with Twitch').click(); await flush();
    f.button('Send guess').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenCalledWith('wuote', 3, { x: 0, y: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks for the streamer’s game link instead of presenting a channel connection form', () => {
    const f = mount('/guess/?pane=stream-picker&channel=bad%2Fchannel');
    expect(f.main.querySelector('iframe')).toBeNull();
    expect(f.main.querySelector('input[name=channel]')).toBeNull();
    expect(f.main.textContent).toContain('Open the game link shared by your streamer.');
    expect(watchLiveRoom).not.toHaveBeenCalled();
    f.button('Back').click(); expect(f.leave).toHaveBeenCalledOnce();
  });

  it('shows token expiry and permits a different connected user to submit the same pin', async () => {
    const f = mount(roundLink());
    ui.pick({ x: 0, y: 0 }); f.button('Sign in with Twitch').click(); await flush();
    f.button('Send guess').click(); await flush();
    f.update({ connected: false, userId: null, error: 'Twitch sign-in expired. Connect again.' });
    expect(f.main.querySelector('.stream-signin-error')!.textContent).toContain('expired');
    expect(f.button('Send guess').disabled).toBe(true);
    f.update({ connected: true, userId: '456', login: 'another', error: null });
    expect(f.button('Send guess').disabled).toBe(false);
  });

  it('does not pretend a channel-only link is round 1 or let an unseen clue be submitted', async () => {
    const f = mount('/guess/?channel=wuote');
    expect(f.main.textContent).toContain('Waiting for a round');
    expect(f.main.textContent).not.toContain('Round 1');
    ui.pick({ x: 0, y: 0 }); f.button('Sign in with Twitch').click(); await flush();
    expect(f.button('Send guess').disabled).toBe(true);
    expect(ui.show).not.toHaveBeenCalled();
    expect(f.viewer.sendGuess).not.toHaveBeenCalled();
  });

  it('has no chat window, composer or privacy controls and does not display transport messages', () => {
    const f = mount(roundLink());
    f.update({ connected: true, userId: '456', login: 'wuote' });
    expect(f.main.querySelector('.stream-privacy-option')).toBeNull();
    expect(f.main.querySelector('.stream-chat-messages')).toBeNull();
    expect(f.main.querySelector('.stream-chat-composer')).toBeNull();
    const handlers = f.viewer.watchChat.mock.calls.at(-1)![1];
    handlers.message({ id: 'message', text: '!noitaguessr_guess 1 100 200', sentAt: Date.now(), player: { id: '789', login: 'chatter', name: 'Chatter' } });
    expect(f.main.querySelector('.stream-chat-message')).toBeNull();
    expect(f.main.textContent).not.toContain('!noitaguessr_guess');
    expect(f.viewer.sendMessage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('offers paid exploration on the clue, keeps map buttons hidden and sends the remaining allowance', async () => {
    const f = mount(roundLink('/guess/?channel=wuote', 2, true)); await flush();
    expect(f.main.querySelector('.stream-picker [aria-label="Zoom map in"]')).toBeNull();
    expect(document.querySelector('.stream-toolbar-round .stream-round')!.textContent).toBe('Round 2 / 10');
    const control = (label: string) => f.main.querySelector<HTMLButtonElement>(`.stream-viewer-clue [aria-label="${label}"]`)!;
    expect(control('Zoom out').disabled).toBe(false);
    expect(control('Zoom out').getAttribute('aria-description')).toContain('400');
    control('Zoom out').click(); await flush();
    expect(f.main.querySelector('.stream-maximum')!.textContent).toContain('4,600');
    control('Travel north').click(); await flush();
    expect(f.main.querySelector('.stream-maximum')!.textContent).toContain('4,500');
    control('Return to start').click(); await flush();
    control('Zoom in').click(); await flush();
    expect(f.main.querySelector('.stream-maximum')!.textContent).toContain('4,500');
    ui.pick({ x: 10, y: 20 }); f.button('Sign in with Twitch').click(); await flush();
    f.button('Send guess').click(); await flush();
    expect(f.viewer.sendGuess).toHaveBeenCalledExactlyOnceWith('wuote', 2, { x: 10, y: 20 }, 4500);
  });
  it('restores the viewer camera, spent points, pin and confirmed submission after reload', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } });
    const url = roundLink('/guess/?channel=wuote', 2, true);
    const first = mount(url); await flush();
    first.main.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click(); await flush();
    ui.pick({ x: 10, y: 20 }); first.button('Sign in with Twitch').click(); await flush();
    first.button('Send guess').click(); await flush();
    dispose?.(); dispose = undefined; document.body.replaceChildren();
    const restored = mount(url); await flush();
    restored.update({ connected: true, login: 'chatter', userId: '123' });
    expect(restored.main.querySelector('.stream-maximum')!.textContent).toContain('4,600');
    expect(restored.button('Send guess').disabled).toBe(true);
    expect(restored.viewer.sendGuess).not.toHaveBeenCalled();
  });
});
