import { guessRouteUrl } from '../src/guessr/routes';
import { gameLogo } from '../src/guessr/game-chrome';
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamUI, type StreamUIHooks } from '../src/guessr/stream-ui';
import { STREAM_SESSION_KEY } from '../src/guessr/stream-types';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, closeStreamRound, revealStreamRound, advanceStreamRound, streamResult } from '../src/guessr/stream-state';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';
import { formatGuessCommand } from '../src/guessr/guess-command';
import type { TwitchChatOptions, TwitchChatCredentials } from '../src/guessr/twitch-chat';
import { startStreamTiming, startHostWindow, STREAM_SUBMISSION_GRACE_MS } from '../src/guessr/stream-timing';
import { TwitchAnnouncementError } from '../src/guessr/twitch-announcement';
import type { StreamBroadcastHost } from '../src/guessr/stream-broadcast-host';

const mocks = vi.hoisted(() => ({ pause: vi.fn(async () => ({})), quit: vi.fn(async () => ({ phase: 'waiting' })), picker: vi.fn(), notice: vi.fn(), channel: vi.fn(), watchChat: vi.fn((_channel: string, _handlers: Pick<TwitchChatOptions, 'message' | 'status' | 'remove'>) => vi.fn()), start: vi.fn(), reveal: vi.fn(), post: vi.fn(async (_channel: string, _message: string, _announcements: boolean) => {}),
  broadcasters: [] as { failed: ConstructorParameters<typeof StreamBroadcastHost>[3]; dispose: ReturnType<typeof vi.fn> }[],
  shareAccess: true, announcementAccess: true, remote: false, connect: vi.fn(async (_options: { announcements?: boolean }) => {}),
  authSession: vi.fn(async (): Promise<TwitchChatCredentials | undefined> => undefined), authConnect: vi.fn(async () => {}),
  publish: vi.fn(), result: vi.fn(), stateBroadcast: vi.fn(), revealBroadcast: vi.fn(), receipt: vi.fn(async () => {}), reject: vi.fn(async () => {}), roundView: vi.fn((main: HTMLElement, _game: unknown, _index: number, actions: HTMLElement) => { main.append(actions); return () => {}; }) }));
vi.mock('../src/guessr/stream-broadcast-host', () => ({ StreamBroadcastHost: class {
  dispose = vi.fn();
  constructor(...args: ConstructorParameters<typeof StreamBroadcastHost>) { mocks.broadcasters.push({ failed: args[3], dispose: this.dispose }); }
  start = async () => {}; publishState = mocks.stateBroadcast; publishReveal = mocks.revealBroadcast;
  remember = mocks.receipt; reject = mocks.reject; receiveRequest() {} close = async () => {}; complete = async () => {};
} }));
vi.mock('../src/guessr/stream-round-results', () => ({ streamRoundResults: mocks.roundView, sharedRoundResults: (main: HTMLElement) => {
  const view = document.createElement('div'); view.className = 'stream-review-grid'; main.append(view); return () => {};
} }));
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class {
  local = !mocks.remote; available = true; pause = mocks.pause; quit = mocks.quit; setLocalChannel = mocks.channel; start = mocks.start; reveal = mocks.reveal;
  publish = mocks.publish; result = mocks.result;
  clock = async () => ({ now: Date.now() });
} }));
vi.mock('../src/guessr/api', async original => ({ ...await original<object>(), gameAuth: async () => ({
  getState: () => ({ isSubscriber: true, provider: 'twitch', username: 'streamer' }),
  registerLoginPreparation() {}, getTwitchChatSession: mocks.authSession, connectTwitchChat: mocks.authConnect,
}) }));
vi.mock('../src/guessr/stream-picker', () => ({ mountStreamPicker: () => { mocks.picker(); return () => {}; } }));
vi.mock('../src/guessr/twitch-viewer', () => ({ savedTwitchViewerId: () => undefined, TwitchViewer: class {
  ready = Promise.resolve(); getState() { return { connected: true, userId: '123', login: 'streamer' }; }
  watchChat = mocks.watchChat;
  postGameLink = mocks.post;
  connect = mocks.connect;
  canShare(announcements: boolean) { return mocks.shareAccess && (!announcements || mocks.announcementAccess); }
} }));
vi.mock('../src/guessr/clue-view', () => ({ attachClueControls: () => () => {} }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class { show = async () => true; destroy() {} } }));
vi.mock('../src/guessr/button-notice', () => ({ buttonNotice: () => ({ show: mocks.notice, dispose: vi.fn() }) }));
let ui: StreamUI | undefined;
beforeEach(() => {
  vi.clearAllMocks(); mocks.broadcasters.length = 0; document.body.replaceChildren();
  mocks.publish.mockReset(); mocks.result.mockReset();
  mocks.quit.mockReset().mockResolvedValue({ phase: 'waiting' });
  mocks.post.mockReset().mockResolvedValue(undefined);
  mocks.shareAccess = true; mocks.announcementAccess = true;
  mocks.remote = false; mocks.authSession.mockReset().mockResolvedValue(undefined); mocks.authConnect.mockReset().mockResolvedValue(undefined);
  mocks.connect.mockReset().mockImplementation(async options => {
    mocks.shareAccess = true;
    if (options.announcements) mocks.announcementAccess = true;
  });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }) });
});
afterEach(() => { ui?.suspend(); ui = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture() {
  const source = streamSource(), service = new StreamService(source, streamSecret);
  const session = await service.start(streamHost, streamNow, undefined, 10); session.live = true;
  const game = newStreamGame(session, streamNow);
  const hooks: StreamUIHooks = {
    config: await source.config(),
    shell() { const main = document.createElement('main'); document.body.replaceChildren(main); return main; },
    panels: vi.fn(main => {
      const clue = document.createElement('div'), bar = document.createElement('div'), map = document.createElement('section');
      map.className = 'game-panel game-panel--map';
      const toolbar = document.createElement('div'); toolbar.className = 'map-bar'; map.append(toolbar);
      const grid = document.createElement('div'); grid.className = 'game-grid'; grid.append(clue, bar, map); main.append(grid); return { clue, bar };
    }), cleanupClue: vi.fn(), markers: vi.fn(), lockGuess: vi.fn(), hud: vi.fn(() => { const hud = document.createElement('div'); hud.className = 'game-hud'; return hud; }), result: vi.fn(), home: vi.fn(), toast: vi.fn(),
  };
  return { game, hooks, service };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

it('unlocks a restored pin when the host connection becomes ready without rebuilding the maps', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const { game, hooks } = await fixture(); game.session.transport = 'parallel'; game.guess = streamAnswer;
  startStreamTiming(game, 90, streamNow - 10000); startHostWindow(game, streamNow - 10000);
  ui = new StreamUI(hooks); ui.game = game;
  Object.assign(ui, { roomHealthy: false }); ui.render();
  const submit = document.querySelector<HTMLButtonElement>('#confirm-guess')!;
  expect(submit.disabled).toBe(true);
  Object.assign(ui, { roomHealthy: true });
  (ui as unknown as { updateTimer(): void }).updateTimer();
  expect(submit.disabled).toBe(false); expect(hooks.lockGuess).toHaveBeenLastCalledWith(false);
  vi.setSystemTime(game.timing!.deadline! + 1);
  (ui as unknown as { updateTimer(): void }).updateTimer();
  expect(submit.disabled).toBe(true); expect(hooks.lockGuess).toHaveBeenLastCalledWith(true);
  expect(hooks.panels).toHaveBeenCalledOnce();
});

it('keeps both panels, clue canvas, controls and header mounted when a submitted host guess is accepted', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const { game, hooks } = await fixture(); game.session.transport = 'parallel';
  startStreamTiming(game, 90, streamNow - 10000); startHostWindow(game, streamNow - 10000);
  game.guess = streamAnswer;
  ui = new StreamUI(hooks); ui.game = game; ui.render();
  const main = document.querySelector('main')!, grid = main.querySelector('.game-grid');
  const header = main.querySelector('.stream-toolbar'), submit = main.querySelector<HTMLButtonElement>('#confirm-guess')!;
  const controls = document.createElement('div'); controls.className = 'clue-controls';
  controls.append(document.createElement('button')); grid!.prepend(controls);
  const canvas = document.createElement('canvas'); grid!.append(canvas);
  const sizeLabels = [...submit.querySelectorAll('.label-sizer')];
  closeStreamRound(game, streamAnswer, streamNow); ui.render();
  expect(document.querySelector('main')).toBe(main); expect(main.querySelector('.game-grid')).toBe(grid);
  expect(main.querySelector('.stream-toolbar')).toBe(header); expect(canvas.isConnected).toBe(true);
  expect(main.querySelector('#confirm-guess')).toBe(submit); expect(submit.disabled).toBe(true);
  expect(submit.dataset.state).toBe('received'); expect(submit.querySelector('.submit-label > span')?.textContent).toBe('Guess received');
  expect([...submit.querySelectorAll('.label-sizer')]).toEqual(sizeLabels);
  expect(hooks.panels).toHaveBeenCalledOnce(); expect(hooks.lockGuess).toHaveBeenCalledWith(true);
  expect(controls.inert).toBe(true); expect(controls.querySelector('button')!.disabled).toBe(true);
});

it.each(['lobby', 'warmup'] as const)('restores the coordinator-owned %s without requiring unrevealed clue images', async phase => {
  const f = await fixture(); history.replaceState(null, '', '/guess/stream/');
  f.game.session.transport = 'parallel'; f.game.session.protocol = 2;
  startStreamTiming(f.game, 90, streamNow, true);
  if (phase === 'warmup') {
    f.game.timing!.phase = 'warmup'; f.game.timing!.startsAt = streamNow + 3000; f.game.timing!.deadline = streamNow + 93000;
  }
  f.game.session.rounds = f.game.session.rounds.map(round => ({ ...round, token: '', clue: { frames: [] } }));
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(f.game));
  ui = new StreamUI(f.hooks);
  expect(ui.game?.session.id).toBe(f.game.session.id);
  expect(ui.game?.timing?.phase).toBe(phase); expect(ui.game?.timing?.deadline).toBe(f.game.timing!.deadline);
});
it('does not present an expired saved lobby as a ready game, and leaves its local data intact', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow + 86400001); mocks.remote = true;
  const f = await fixture(); history.replaceState(null, '', '/guess/stream/');
  f.game.session.transport = 'parallel'; f.game.session.protocol = 2;
  startStreamTiming(f.game, 90, streamNow, true);
  const saved = JSON.stringify(f.game); localStorage.setItem(STREAM_SESSION_KEY, saved);
  ui = new StreamUI(f.hooks);
  expect(ui.game).toBeNull(); expect(localStorage.getItem(STREAM_SESSION_KEY)).toBe(saved);
});
it('still restores a fresh remote lobby and keeps completed results beyond the live-game deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow + 10000); mocks.remote = true;
  const f = await fixture(); history.replaceState(null, '', '/guess/stream/');
  f.game.session.transport = 'parallel'; f.game.session.protocol = 2;
  startStreamTiming(f.game, 90, streamNow, true);
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(f.game));
  ui = new StreamUI(f.hooks); expect(ui.game?.session.id).toBe(f.game.session.id); ui.suspend();
  f.game.stage = 'complete'; vi.setSystemTime(streamNow + 172800000);
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(f.game));
  ui = new StreamUI(f.hooks); expect(ui.game?.stage).toBe('complete');
});
it('ends a confirmed unavailable game locally without waiting for a nonexistent socket acknowledgement', async () => {
  const f = await fixture(); f.game.session.transport = 'parallel';
  ui = new StreamUI(f.hooks); ui.game = f.game;
  const socket = { command: vi.fn(), dispose: vi.fn() };
  Object.assign(ui, { coordinatorUnavailable: true, parallel: socket });
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(f.game));
  await ui.quit();
  expect(socket.command).not.toHaveBeenCalled(); expect(socket.dispose).toHaveBeenCalledOnce();
  expect(ui.game).toBeNull(); expect(localStorage.getItem(STREAM_SESSION_KEY)).toBeNull();
});

async function liveFixture(announcements = false) {
  const f = await fixture();
  f.game.session.host = { id: '900000000', login: 'streamer', name: 'Local host' };
  f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(f.hooks); await ui.open();
  const toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  toggle.checked = announcements; toggle.dispatchEvent(new Event('change'));
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Start new game')!.click();
  await flush();
  return f;
}

it.each([[false, 3], [true, 1]] as const)('keeps sharing beside Start and posts automatically and manually through the production API (announcement: %s)', async (announcements, count) => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow); mocks.remote = true;
  const f = await fixture(); f.game.session.transport = 'parallel';
  startStreamTiming(f.game, 90, streamNow, true); f.game.shareAnnouncements = announcements;
  const request = vi.fn(async () => announcements ? new Response(null, { status: 204 })
    : Response.json({ data: [{ is_sent: true, message_id: 'test-message' }] }));
  vi.stubGlobal('fetch', request);
  ui = new StreamUI(f.hooks); ui.game = f.game;
  Object.assign(ui, { autoShareOnConnect: true, parallel: { connected: () => true, state: () => 'connected', now: () => Date.now(), dispose() {} },
    setupCredentials: { accessToken: 'test-only-posting-token', clientId: 'client', userId: f.game.session.host.id,
      scopes: ['user:write:chat', 'moderator:manage:announcements'], expiresAt: streamNow + 600000 } });
  ui.render();
  const share = document.querySelector<HTMLButtonElement>('.stream-lobby-actions #stream-share')!;
  expect(share).not.toBeNull(); expect(share.nextElementSibling?.querySelector('#stream-start-game')).not.toBeNull();
  (ui as unknown as { connectGame(): void }).connectGame(); await vi.advanceTimersByTimeAsync(2400);
  expect(request).toHaveBeenCalledTimes(count);
  expect(document.querySelector('.stream-start-panel #stream-share-status')!.textContent).toBe('Game link shared in chat.');
  await vi.advanceTimersByTimeAsync(2200); expect(share.disabled).toBe(false);
  share.click(); await vi.advanceTimersByTimeAsync(2400); expect(request).toHaveBeenCalledTimes(count * 2);
  for (const [url, init] of request.mock.calls as unknown as [string, RequestInit][]) {
    const body = JSON.parse(init.body as string);
    expect(body.message).toContain('/guess/' + f.game.session.host.login + '/');
    if (announcements) expect(new URL(url).searchParams.get('broadcaster_id')).toBe(f.game.session.host.id);
    else expect(body).toMatchObject({ broadcaster_id: f.game.session.host.id, sender_id: f.game.session.host.id });
  }
  expect(f.game.timing!.phase).toBe('lobby');
});

it.each([[false, 3], [true, 1]] as const)('automatically posts invitations on game creation, then waits for an explicit start (announcement: %s)', async (announcements, posts) => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const f = await fixture(); f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  const toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  toggle.checked = announcements; toggle.dispatchEvent(new Event('change'));
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Start new game')!.click(); await flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.post).toHaveBeenCalledTimes(posts);
  for (const [channel, text, announcement] of mocks.post.mock.calls) {
    expect(channel).toBe('streamer'); expect(channel).not.toBe('noitaguessr');
    expect(text).toContain(`/guess/streamer/`); expect(announcement).toBe(announcements);
  }
  expect(document.getElementById('stream-share-status')!.textContent).toBe('Game link shared in chat.');
  await vi.advanceTimersByTimeAsync(3600000);
  expect(ui.game!.timing!.phase).toBe('lobby'); expect(ui.game!.timing!.deadline).toBeNull();
  expect(ui.game!.timing!.windows.every(window => !window)).toBe(true);
  expect(mocks.post).toHaveBeenCalledTimes(posts);
  (document.getElementById('stream-start-game') as HTMLButtonElement).click();
  expect(ui.game!.timing!.phase).toBe('warmup');
  expect(ui.game!.timing!.startsAt).toBe(Date.now() + 3000);
  expect(ui.game!.timing!.deadline).toBe(Date.now() + 93000);
  expect(mocks.post).toHaveBeenCalledTimes(posts);
});

it('keeps submission in the guess panel and shows recovery controls only when necessary', async () => {
  await liveFixture();
  expect(document.getElementById('confirm-guess')!.closest('.game-panel--map')).not.toBeNull();
  const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
  for (const label of ['Pause', 'Skip round', 'Connect Twitch', 'Reconnect chat', 'Copy game link'])
    expect(labels).not.toContain(label);
  const recovery = document.getElementById('stream-reconnect')!;
  expect(recovery.hidden).toBe(true);
  expect(mocks.watchChat).not.toHaveBeenCalled();
});

it('announces only on click, prevents duplicate posts during sending and the two-second confirmation, even across renders', async () => {
  vi.useFakeTimers();
  await liveFixture(true);
  expect(mocks.post).not.toHaveBeenCalled();
  const share = () => document.getElementById('stream-share') as HTMLButtonElement;
  let sent!: () => void;
  mocks.post.mockImplementationOnce(() => new Promise<void>(resolve => { sent = resolve; }));
  share().click(); share().click();
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.post).toHaveBeenCalledWith('streamer', expect.stringMatching(/^Join NoitaGuessr: https?:\/\/.*\/guess\/streamer\/[0-9a-z]{26}\/$/), true);
  expect(share().textContent).toBe('Posting…');
  ui!.render(); expect(share().disabled).toBe(true);
  sent(); await flush();
  expect(share().textContent).toBe('Posted in chat');
  expect(share().disabled).toBe(true);
  vi.advanceTimersByTime(1000); ui!.render(); share().click();
  vi.advanceTimersByTime(999); expect(share().disabled).toBe(true);
  expect(mocks.post).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1);
  expect(share().disabled).toBe(false);
  expect(share().textContent).toBe('Share game link in chat');
  share().click(); await flush(); expect(mocks.post).toHaveBeenCalledTimes(2);
});

it('defaults to normal messages and retains announcement selection across setup reloads', async () => {
  const f = await fixture();
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(f.hooks); await ui.open();
  let toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  ui.suspend(); ui = new StreamUI(f.hooks); await ui.open();
  toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('offers consent during setup before starting, only for the selected sharing mode', async () => {
  const f = await fixture(); mocks.announcementAccess = false;
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(f.hooks); await ui.open();
  const consent = document.getElementById('stream-enable-sharing') as HTMLButtonElement;
  expect(consent.hidden).toBe(true);
  const toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  expect(consent.hidden).toBe(false);
  expect((document.getElementById('stream-create-game') as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.connect).not.toHaveBeenCalled();
  consent.click(); await flush();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ posting: true, announcements: true });
  expect(consent.hidden).toBe(true);
  expect((document.getElementById('stream-create-game') as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('keeps an active game available with copy fallback after posting permission is lost', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await liveFixture();
  mocks.shareAccess = false; ui!.render();
  const share = document.getElementById('stream-share') as HTMLButtonElement;
  expect(share.textContent).toBe('Copy game link');
  share.click(); await flush();
  expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/guess\/streamer\/[0-9a-z]{26}\/$/));
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(document.getElementById('confirm-guess')).not.toBeNull();
});

it('posts a normal message when the setup switch is off', async () => {
  await liveFixture();
  (document.getElementById('stream-share') as HTMLButtonElement).click(); await flush();
  expect(mocks.post).toHaveBeenCalledWith('streamer', expect.any(String), false);
  expect(JSON.parse(localStorage.getItem(STREAM_SESSION_KEY)!).shareAnnouncements).toBe(false);
});

it('retains the chosen mode in a recovered game and copies after revoked posting access without reauthorizing', async () => {
  const { hooks } = await liveFixture(true);
  expect(JSON.parse(localStorage.getItem(STREAM_SESSION_KEY)!).shareAnnouncements).toBe(true);
  mocks.post.mockRejectedValueOnce(new TwitchAnnouncementError(true, 'Sharing permission is unavailable. You can copy the game link.'));
  (document.getElementById('stream-share') as HTMLButtonElement).click(); await flush();
  expect(document.getElementById('stream-share')!.textContent).toBe('Copy game link');
  expect(mocks.connect).not.toHaveBeenCalled();
  ui!.suspend(); ui = new StreamUI(hooks); await ui.open();
  expect((document.getElementById('stream-share-announcements') as HTMLInputElement).checked).toBe(true);
});

it('requests normal posting access in setup without requesting announcements', async () => {
  const { hooks } = await fixture(); mocks.shareAccess = false;
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open();
  const consent = document.getElementById('stream-enable-sharing') as HTMLButtonElement;
  const create = document.getElementById('stream-create-game') as HTMLButtonElement;
  expect(consent.hidden).toBe(false);
  expect(create.disabled).toBe(true);
  expect(create.getAttribute('aria-description')).toBe('First, allow NoitaGuessr to post messages in your Twitch chat.');
  expect(create.parentElement!.tabIndex).toBe(0);
  create.click(); await flush(); expect(mocks.start).not.toHaveBeenCalled();
  consent.click(); await flush();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ posting: true, announcements: false });
  expect(consent.hidden).toBe(true);
  expect(create.disabled).toBe(false);
  expect(create.hasAttribute('aria-description')).toBe(false);
  expect(create.parentElement!.hasAttribute('tabindex')).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('waits for verified production posting scopes, including after a canceled approval and mode changes', async () => {
  const { hooks } = await fixture(); mocks.remote = true;
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open();
  const create = () => document.getElementById('stream-create-game') as HTMLButtonElement;
  expect(create().disabled).toBe(true);
  (document.getElementById('stream-enable-sharing') as HTMLButtonElement).click(); await flush();
  expect(mocks.authConnect).toHaveBeenCalledExactlyOnceWith({ announcements: false });
  expect(create().disabled).toBe(true);
  await (ui as unknown as { start(): Promise<void> }).start();
  expect(mocks.start).not.toHaveBeenCalled();
  const credentials = { accessToken: 'test-only-posting-token', clientId: 'client', userId: '123', login: 'streamer',
    scopes: ['user:write:chat'], expiresAt: Date.now() + 600000 };
  mocks.authSession.mockResolvedValue(credentials); await ui.open();
  expect(create().disabled).toBe(false);
  const toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  expect(create().disabled).toBe(true);
  mocks.authSession.mockResolvedValue({ ...credentials, scopes: ['user:write:chat', 'moderator:manage:announcements'] });
  await ui.open(); expect(create().disabled).toBe(false);
  mocks.authSession.mockResolvedValue({ ...credentials, expiresAt: Date.now() - 1 });
  await ui.open(); expect(create().disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});

it('disables a restored lobby start until posting access is approved', async () => {
  const { game, hooks } = await fixture(); game.session.localChat = true;
  startStreamTiming(game, 90, Date.now(), true);
  ui = new StreamUI(hooks); ui.game = game; await ui.open();
  mocks.shareAccess = false; Object.assign(ui, { sharingPermissionFailed: true }); ui.render();
  const start = document.getElementById('stream-start-game') as HTMLButtonElement;
  expect(start.disabled).toBe(true); expect(start.getAttribute('aria-description')).toBe('First, allow NoitaGuessr to post messages in your Twitch chat.');
  start.click(); expect(game.timing!.phase).toBe('lobby');
  (document.querySelector('#stream-start-approval button') as HTMLButtonElement).click(); await flush();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ posting: true, announcements: false });
  expect(start.disabled).toBe(false); expect(document.getElementById('stream-start-approval')!.hidden).toBe(true);
});

it('does not claim an unconfirmed announcement was posted or retry it automatically', async () => {
  await liveFixture();
  mocks.post.mockRejectedValueOnce(new Error('Could not confirm the post. Check your Twitch chat before trying again.'));
  const share = document.getElementById('stream-share') as HTMLButtonElement;
  share.click(); await flush();
  expect(share.disabled).toBe(false);
  expect(share.textContent).toBe('Share game link in chat');
  expect(document.getElementById('stream-share-status')!.textContent).toContain('Check your Twitch chat');
  expect(document.getElementById('stream-share-status')!.hidden).toBe(false);
  expect(mocks.notice).not.toHaveBeenCalled();
  expect(mocks.post).toHaveBeenCalledOnce();
});

it('keeps recovery data when quitting fails and clears only the active save after a successful retry', async () => {
  const { game, hooks } = await fixture();
  const saved = JSON.stringify(game);
  localStorage.setItem(STREAM_SESSION_KEY, saved);
  localStorage.setItem('completed-result', 'retain');
  history.replaceState(null, '', '/guess/');
  ui = new StreamUI(hooks);
  mocks.quit.mockRejectedValueOnce(new Error('Connection lost'));
  await expect(ui.quit()).rejects.toThrow('Connection lost');
  expect(ui.game?.session.id).toBe(game.session.id);
  expect(ui.game?.paused).toBe(true);
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBe(saved);
  await ui.quit();
  expect(mocks.quit).toHaveBeenNthCalledWith(2, game.session.id);
  expect(ui.game).toBeNull();
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBeNull();
  expect(localStorage.getItem('completed-result')).toBe('retain');
  expect(mocks.reveal).not.toHaveBeenCalled();
});

it('does not clear another tab’s newer saved game or a completed game', async () => {
  const { game, hooks } = await fixture();
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(game));
  history.replaceState(null, '', '/guess/');
  ui = new StreamUI(hooks);
  let acknowledge!: (value: { phase: string }) => void;
  mocks.quit.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  const quitting = ui.quit();
  const newer = JSON.stringify({ ...game, session: { ...game.session, id: crypto.randomUUID() } });
  localStorage.setItem(STREAM_SESSION_KEY, newer);
  ui.save();
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBe(newer);
  acknowledge({ phase: 'waiting' }); await quitting;
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBe(newer);
  game.stage = 'complete'; ui.game = game;
  await ui.quit();
  expect(ui.game).toBe(game);
  expect(mocks.quit).toHaveBeenCalledOnce();
});

it.each(['/guess/?channel=streamer', '/guess/stream/streamer/', '/guess/streamer/00000000000000000000000001/'])('opening chatter URL %s never restores, writes or pauses the host game', async url => {
  const { game, hooks } = await fixture();
  const saved = JSON.stringify(game); localStorage.setItem(STREAM_SESSION_KEY, saved);
  history.replaceState(null, '', url);
  const read = vi.mocked(localStorage.getItem), write = vi.mocked(localStorage.setItem);
  read.mockClear(); write.mockClear();
  ui = new StreamUI(hooks); ui.save(); ui.picker();
  expect(ui.game).toBeNull();
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  expect(mocks.pause).not.toHaveBeenCalled(); expect(mocks.picker).toHaveBeenCalledOnce();
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBe(saved);
});

it('pauses the game when the active host actually leaves its setup', async () => {
  const { game, hooks } = await fixture();
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(game)); history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open(); ui.suspend();
  expect(mocks.pause).toHaveBeenCalledExactlyOnceWith(game.session.id, true);
});

it('opens host setup for a completed save and keeps saved results behind an explicit action', async () => {
  const { game, hooks, service } = await fixture();
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  game.published = true;
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(game));
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open();
  const button = (label: string) => [...document.querySelectorAll('button')].find(element => element.textContent === label)!;
  expect(button('Start new game')).toBeDefined();
  expect(document.querySelector('.finish-hero')).toBeNull();
  expect(mocks.watchChat).not.toHaveBeenCalled();
  button('View saved results').click(); await flush();
  expect(location.pathname).toBe(`/guess/results/${game.session.id}/`);
  expect(document.querySelector('.finish-hero')).not.toBeNull();
  expect(hooks.toast).not.toHaveBeenCalled();
  expect(button('Save results as a web page')).toBeDefined();
  expect(button('Save scores as a JSON file').closest('details')).toBeNull();
  expect(button('Save results as a web page').title).toContain('search and sort every player’s scores offline');
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(mocks.watchChat).not.toHaveBeenCalled();
  ui.suspend(); ui = new StreamUI(hooks); await ui.publicResult(game.session.id);
  expect(document.querySelector('.finish-hero')).not.toBeNull();
  expect(location.pathname).toBe(`/guess/results/${game.session.id}/`);
});

it('groups result navigation and shows green punctuation-free copy feedback beside its button', async () => {
  const { game, hooks, service } = await fixture();
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  game.published = true;
  game.session.host.name = 'Patron'; game.participants[0].name = 'Patron';
  localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(game)); history.replaceState(null, '', '/guess/stream/');
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  ui = new StreamUI(hooks); ui.render();
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
  expect(button('Back').closest('.stream-results-heading')).not.toBeNull();
  expect(button('Back').parentElement!.firstElementChild).toBe(button('Back'));
  const resultsMenu = document.querySelector('.stream-results > .stream-results-menu')!;
  expect(resultsMenu.previousElementSibling?.matches('.stream-results-heading')).toBe(true);
  expect(resultsMenu.firstElementChild).toBe(button('Start another game'));
  expect(document.querySelector('.stream-publication a')!.textContent).toBe('streamer’s results');
  expect(document.querySelector('h1')!.textContent).toBe('streamer’s results');
  button('Copy result link').click(); for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith(location.origin + '/guess/results/' + game.session.id + '/');
  expect(mocks.notice).toHaveBeenCalledWith('Copied', 'success');
  expect(hooks.toast).not.toHaveBeenCalled();
  button('Start another game').click();
  await vi.waitFor(() => expect(location.pathname).toBe('/guess/stream/'));
  expect(document.querySelector('.stream-setup-card')).not.toBeNull();
});

it('keeps round reviews inline with thumbnails and the save/share menu above the table', async () => {
  const { game, hooks, service } = await fixture();
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  game.published = true; game.session.transport = 'parallel';
  ui = new StreamUI(hooks); ui.game = game; ui.render();
  const main = document.querySelector('main'), url = location.href;
  const table = document.querySelector('.table-wrap')!;
  const menu = document.querySelector('.stream-results-menu')!;
  const reviews = document.querySelector('.stream-result-reviews')!;
  expect(menu.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(reviews.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(menu.textContent).toContain('Share result'); expect(menu.textContent).toContain('Save results as a web page');
  const buttons = [...reviews.querySelectorAll<HTMLElement>('summary.accordion-header')];
  expect(buttons).toHaveLength(10); expect(buttons[0].textContent).toBe('Round 1: Private place');
  expect(buttons.every(button => button.querySelector('.stream-round-thumbnail'))).toBe(true);
  buttons[0].click(); await flush();
  expect((buttons[0].parentElement as HTMLDetailsElement).open).toBe(true);
  expect(reviews.querySelector('details[open] .stream-review-grid')).not.toBeNull();
  buttons[1].click(); await flush();
  expect(reviews.querySelectorAll('details[open]')).toHaveLength(2);
  expect(buttons[0].nextElementSibling?.querySelector('.stream-review-grid')).not.toBeNull();
  expect(document.querySelector('main')).toBe(main); expect(location.href).toBe(url);
  expect(document.querySelector('.stream-host-shell')).toBeNull();
  expect(document.querySelector('#stream-round-timer')).toBeNull();
  expect(document.querySelector('dialog')).toBeNull();
  expect(mocks.watchChat).not.toHaveBeenCalled();
  buttons[0].click(); await flush();
  expect((buttons[0].parentElement as HTMLDetailsElement).open).toBe(false);
  expect((buttons[1].parentElement as HTMLDetailsElement).open).toBe(true);
});

it('keeps the between-round countdown and table visible while the coordinator reconnects', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const { game, hooks, service } = await fixture();
  game.session.transport = 'parallel';
  startStreamTiming(game, 30, streamNow - 33000); startHostWindow(game, streamNow - 33000);
  closeStreamRound(game, streamAnswer, streamNow);
  revealStreamRound(game, await service.reveal(game.session.rounds[0].token, streamHost, streamNow), streamNow);
  let connected = true;
  ui = new StreamUI(hooks); ui.game = game;
  Object.assign(ui, { parallel: { connected: () => connected, state: () => connected ? 'connected' : 'retrying', now: () => Date.now(), dispose() {} } });
  ui.render(); const main = document.querySelector('main'), deadline = game.timing!.resultsUntil;
  const logo = gameLogo(() => {}); document.body.prepend(logo.element);
  expect(document.getElementById('stream-round-timer')!.textContent).toBe('00:08');
  expect(document.getElementById('stream-round-timer')!.dataset.clock).toBe('true');
  connected = false; vi.setSystemTime(streamNow + 7000);
  (ui as unknown as { updateStatus(): void }).updateStatus();
  (ui as unknown as { updateTimer(): void }).updateTimer();
  expect(document.getElementById('stream-round-timer')!.textContent).toBe('00:01');
  expect(document.querySelector('.logo-status-trigger')!.getAttribute('aria-label')).toBe('Reconnecting…');
  expect(document.querySelector('main')).toBe(main);
  expect(game.timing!.resultsUntil).toBe(deadline);
  connected = true;
  (ui as unknown as { updateStatus(): void }).updateStatus();
  expect(document.querySelector('.logo-status-trigger')!.getAttribute('aria-label')).toBe('Connected'); logo.dispose();
});


it('recovers a failed publication from its result URL after a new game and F5, then retries exactly once', async () => {
  // Keep this recovery test inside the retry credential's 30-day lifetime.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(streamNow + 60000);
  const { game, hooks, service } = await fixture();
  game.session.localChat = true;
  const publicationToken = game.session.token;
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  mocks.publish.mockRejectedValueOnce(new Error('Offline'));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(hooks); ui.game = game; ui.render();
  await vi.waitFor(() => {
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(document.getElementById('stream-publish-message')?.textContent).toContain('Not published.');
  });
  expect(document.getElementById('stream-publish-message')!.closest('.stream-publication')!.compareDocumentPosition(document.querySelector('.stream-score-table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The next game replaces the singleton host session; the prior retry survives.
  ui.game = (await fixture()).game; ui.save();
  ui.suspend(); ui = new StreamUI(hooks); await ui.publicResult(game.session.id);
  expect(mocks.result).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Not published yet.'));
  expect(document.body.textContent).not.toContain(publicationToken);
  expect(game.session.token).toBe('');
  expect(game.session.rounds.every(round => round.token === '')).toBe(true);
  mocks.publish.mockResolvedValue({ id: game.session.id, published: true });
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry publishing')!.click();
  await vi.waitFor(() => expect(document.getElementById('stream-publish-message')?.textContent).toContain('Result saved to the local test server.'));
  expect(mocks.publish).toHaveBeenCalledTimes(2);
  expect(mocks.channel).toHaveBeenLastCalledWith(game.session.host.login);
  expect(mocks.publish.mock.calls[1][0]).toEqual({ token: publicationToken, finishedAt: game.finishedAt, players: streamResult(game).players, positions: streamResult(game).positions });
  expect(JSON.parse(localStorage.getItem(STREAM_SESSION_KEY)!).session.id).not.toBe(game.session.id);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Copy result link')!.disabled).toBe(false);
});


it('opens final standings as soon as the last timed round has been scored', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const { game, hooks, service } = await fixture();
  for (const round of game.session.rounds.slice(0, 9)) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  startStreamTiming(game, 90, streamNow - 4000); startHostWindow(game, streamNow - 4000);
  closeStreamRound(game, streamAnswer, streamNow);
  revealStreamRound(game, await service.reveal(game.session.rounds[9].token, streamHost, streamNow), streamNow);
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(hooks); ui.game = game; ui.render();
  expect(game.stage).toBe('complete');
  expect(game.finishedAt).toBe(streamNow);
  expect(game.timing!.resultsUntil).toBeUndefined();
  expect(location.href).toBe(guessRouteUrl('stream-result', location.href, { result: game.session.id }).href);
  expect(document.querySelector('.stream-results')).not.toBeNull();
  expect(document.getElementById('stream-auto-next')).toBeNull();
  expect(mocks.roundView).not.toHaveBeenCalled();
});


it('does not discard an unpublished game when both browser storage and the upload fail', async () => {
  const { game, hooks, service } = await fixture();
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('Quota exceeded'); });
  mocks.publish.mockRejectedValue(new Error('Offline'));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(hooks); ui.game = game; ui.render();
  await vi.waitFor(() => expect(document.getElementById('stream-publish-message')?.textContent).toContain('Download a copy before closing'));
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Start another game')!.click();
  await vi.waitFor(() => expect(hooks.toast).toHaveBeenCalledWith('This browser could not save the result. Download a copy before closing this page.'));
  expect(document.querySelector('.finish-hero')).not.toBeNull();
  expect(ui.game).toBe(game);
});
