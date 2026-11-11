// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamUI, type StreamUIHooks } from '../src/guessr/stream-ui';
import { STREAM_SESSION_KEY } from '../src/guessr/stream-types';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, closeStreamRound, revealStreamRound, advanceStreamRound, streamResult } from '../src/guessr/stream-state';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';
import { formatGuessCommand } from '../src/guessr/guess-command';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';
import { startStreamTiming, startHostWindow, STREAM_SUBMISSION_GRACE_MS } from '../src/guessr/stream-timing';
import { TwitchAnnouncementError } from '../src/guessr/twitch-announcement';
import type { StreamBroadcastHost } from '../src/guessr/stream-broadcast-host';

const mocks = vi.hoisted(() => ({ pause: vi.fn(async () => ({})), quit: vi.fn(async () => ({ phase: 'waiting' })), picker: vi.fn(), notice: vi.fn(), channel: vi.fn(), watchChat: vi.fn((_channel: string, _handlers: Parameters<TwitchViewer['watchChat']>[1]) => vi.fn()), start: vi.fn(), reveal: vi.fn(), post: vi.fn(async (_channel: string, _message: string, _announcements: boolean) => {}),
  broadcasters: [] as { failed: ConstructorParameters<typeof StreamBroadcastHost>[3]; dispose: ReturnType<typeof vi.fn> }[],
  shareAccess: true, announcementAccess: true, connect: vi.fn(async (_options: { announcements?: boolean }) => {}),
  publish: vi.fn(), result: vi.fn(), stateBroadcast: vi.fn(), revealBroadcast: vi.fn(), receipt: vi.fn(async () => {}), reject: vi.fn(async () => {}), roundView: vi.fn((main: HTMLElement, _game: unknown, _index: number, actions: HTMLElement) => { main.append(actions); return () => {}; }) }));
vi.mock('../src/guessr/stream-broadcast-host', () => ({ StreamBroadcastHost: class {
  dispose = vi.fn();
  constructor(...args: ConstructorParameters<typeof StreamBroadcastHost>) { mocks.broadcasters.push({ failed: args[3], dispose: this.dispose }); }
  start = async () => {}; publishState = mocks.stateBroadcast; publishReveal = mocks.revealBroadcast;
  remember = mocks.receipt; reject = mocks.reject; receiveRequest() {} close = async () => {}; complete = async () => {};
} }));
vi.mock('../src/guessr/stream-round-results', () => ({ streamRoundResults: mocks.roundView }));
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class {
  local = true; available = true; pause = mocks.pause; quit = mocks.quit; setLocalChannel = mocks.channel; start = mocks.start; reveal = mocks.reveal;
  publish = mocks.publish; result = mocks.result;
  clock = async () => ({ now: Date.now() });
} }));
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
  const session = await service.start(streamHost, streamNow); session.live = true;
  const game = newStreamGame(session, streamNow);
  const hooks: StreamUIHooks = {
    config: await source.config(),
    shell() { const main = document.createElement('main'); document.body.replaceChildren(main); return main; },
    panels: vi.fn(main => {
      const clue = document.createElement('div'), bar = document.createElement('div'), map = document.createElement('section');
      map.className = 'game-panel game-panel--map';
      const grid = document.createElement('div'); grid.className = 'game-grid'; grid.append(clue, bar, map); main.append(grid); return { clue, bar };
    }), cleanupClue: vi.fn(), markers: vi.fn(), hud: vi.fn(() => { const hud = document.createElement('div'); hud.className = 'game-hud'; return hud; }), result: vi.fn(), home: vi.fn(), toast: vi.fn(),
  };
  return { game, hooks, service };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

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
  const receiver = mocks.watchChat.mock.calls[0][1];
  receiver.status('live', 'Connected');
  return { ...f, receiver };
}

it('keeps receiving guesses after a receipt failure and ignores failures from a replaced publisher', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const { receiver } = await liveFixture();
  const game = ui!.game!;
  startStreamTiming(game, 30, Date.now());
  receiver.status('live', 'Connected');
  await vi.advanceTimersByTimeAsync(4000);
  const firstPublisher = mocks.broadcasters.at(-1)!;
  const deadline = game.timing!.deadline;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const message = (id: number) => ({ id: String(id), player: { id: '123', login: 'chatter', name: 'Chatter' }, sentAt: Date.now(),
    text: formatGuessCommand(1, streamAnswer, 5000, game.session.rounds[0].id, { userId: '123', nonce: new Uint8Array(8).fill(id) }) });
  receiver.message(message(1));
  firstPublisher.failed(Error('Twitch did not send this message. Check the channel’s chat restrictions.'), 'receipts-0-false');
  await vi.advanceTimersByTimeAsync(1);
  receiver.message(message(2));
  expect(game.participants.find(p => p.id === '123')!.guesses[0]!.messageId).toBe('2');
  expect(game.paused).toBe(false);
  expect(firstPublisher.dispose).not.toHaveBeenCalled();
  expect(game.timing!.deadline).toBe(deadline);
  expect(document.getElementById('stream-chat-status')!.dataset.connection).toBe('connected');
  firstPublisher.failed(Error('Twitch could not send the game update.'), 'state');
  expect(game.paused).toBe(true);
  expect(document.getElementById('stream-reconnect')!.hidden).toBe(false);
  expect(document.getElementById('stream-chat-status')!.dataset.connection).toBe('disconnected');
  await vi.advanceTimersByTimeAsync(4000);
  receiver.status('live', 'Connected');
  expect(mocks.broadcasters).toHaveLength(2);
  firstPublisher.failed(Error('Late error from an old publisher'), 'state');
  expect(game.paused).toBe(false);
  expect(game.timing!.deadline).toBe(deadline);
  expect(game.participants.find(p => p.id === '123')!.guesses[0]!.messageId).toBe('2');
  expect(document.getElementById('stream-chat-status')!.dataset.connection).toBe('connected');
  expect(warning).toHaveBeenCalledTimes(2);
});

it('runs the warm-up and timed chat-ahead flow in the host UI without a pause or skip action', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  vi.stubGlobal('Audio', vi.fn(() => { throw Error('The game must stay silent'); }));
  const f = await fixture();
  f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  mocks.reveal.mockResolvedValue(await f.service.reveal(f.game.session.rounds[0].token, streamHost, streamNow + 200000));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  expect((document.getElementById('stream-automatic-timer') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('stream-round-seconds') as HTMLInputElement).value).toBe('90');
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Start new game')!.click(); await flush();
  mocks.watchChat.mock.calls[0][1].status('live', 'Connected');
  expect(ui.game!.timing!.phase).toBe('lobby');
  await vi.advanceTimersByTimeAsync(120000);
  expect(ui.game!.timing!.phase).toBe('lobby');
  expect(ui.game!.timing!.windows.every(window => window === null)).toBe(true);
  (document.getElementById('stream-start-game') as HTMLButtonElement).click();
  expect(document.querySelector('.stream-warmup')).not.toBeNull();
  expect(document.getElementById('stream-share-status')!.hidden).toBe(true);
  expect(document.getElementById('confirm-guess')).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.getElementById('stream-waiting-timer')!.textContent).toBe('01:30');
  expect(document.getElementById('stream-waiting-timer')!.dataset.clock).toBe('true');
  ui.game!.joinedPlayers = { '123': { login: 'chatter', name: 'Chatter' } }; ui.render();
  expect(document.getElementById('stream-joined-count')!.textContent).toBe('Chatters joined: 1');
  expect(document.getElementById('stream-joined-names')!.textContent).toBe('Chatter');
  await vi.advanceTimersByTimeAsync(90_000);
  expect(ui.game!.round).toBe(0); expect(ui.game!.timing!.chatRound).toBe(1);
  await vi.advanceTimersByTimeAsync(8000);
  ui.game!.guess = streamAnswer; ui.render();
  (document.getElementById('confirm-guess') as HTMLButtonElement).click(); await flush();
  expect(ui.game!.stage).toBe('reveal');
  expect(ui.game!.timing!.windows[1]!.closed).toBe(false);
  expect(mocks.roundView).toHaveBeenCalledWith(expect.any(HTMLElement), ui.game, 0, expect.any(HTMLElement));
  expect((document.getElementById('stream-auto-next') as HTMLButtonElement).disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(ui.game!.timing!.deadline! - Date.now());
  expect(ui.game!.round).toBe(1); expect(ui.game!.timing!.chatRound).toBe(2);
  expect(mocks.pause).not.toHaveBeenCalled(); expect(mocks.quit).not.toHaveBeenCalled();
  expect(mocks.reveal).toHaveBeenCalledWith(f.game.session.rounds[0].token, undefined);
  expect(Audio).not.toHaveBeenCalled();
});

it('keeps manual timing optional and closes chat only when the streamer submits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const f = await fixture(); f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  mocks.reveal.mockResolvedValue(await f.service.reveal(f.game.session.rounds[0].token, streamHost, streamNow + 200000));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  const automatic = document.getElementById('stream-automatic-timer') as HTMLInputElement;
  automatic.checked = false; automatic.dispatchEvent(new Event('change'));
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Start new game')!.click(); await flush();
  mocks.watchChat.mock.calls[0][1].status('live', 'Connected');
  await vi.advanceTimersByTimeAsync(120000);
  expect(ui.game!.timing!.phase).toBe('lobby');
  (document.getElementById('stream-start-game') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(3000);
  expect(ui.game!.timing!.phase).toBe('warmup'); expect(ui.game!.timing!.deadline).toBeNull();
  (document.getElementById('stream-first-round') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(8000);
  ui.game!.guess = streamAnswer; ui.render();
  expect(ui.game!.timing!.windows[1]!.closed).toBe(false);
  (document.getElementById('confirm-guess') as HTMLButtonElement).click(); await flush();
  expect(ui.game!.timing!.windows[1]!.closed).toBe(true);
  expect(ui.game!.stage).toBe('reveal');
  expect(document.getElementById('stream-auto-next')).toBeNull();
  expect([...document.querySelectorAll('button')].find(b => b.textContent === 'Next round')!.disabled).toBe(false);
});

it('withholds an early host solution until collection ends and records a late-delivered chatter guess', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const f = await fixture(); f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  mocks.reveal.mockResolvedValue(await f.service.reveal(f.game.session.rounds[0].token, streamHost, streamNow + 200000));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  const seconds = document.getElementById('stream-round-seconds') as HTMLInputElement;
  seconds.value = '30';
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Start new game')!.click(); await flush();
  const receiver = mocks.watchChat.mock.calls[0][1]; receiver.status('live', 'Connected');
  await vi.advanceTimersByTimeAsync(4000); // Let the automatic invitation finish.
  (document.getElementById('stream-start-game') as HTMLButtonElement).click();
  const deadline = ui.game!.timing!.deadline!;
  await vi.advanceTimersByTimeAsync(deadline - Date.now() + 3000);
  ui.game!.guess = streamAnswer; ui.render();
  (document.getElementById('confirm-guess') as HTMLButtonElement).click(); await flush();
  expect(ui.game!.stage).toBe('closing'); expect(mocks.reveal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  receiver.message({ player: { id: '123', login: 'chatter', name: 'Chatter' }, id: 'last-second', sentAt: deadline + 1100,
    text: formatGuessCommand(1, streamAnswer, 4900, ui.game!.session.rounds[0].id, { userId: '123', nonce: new Uint8Array(8).fill(9) }) });
  expect(ui.game!.participants.find(p => p.id === '123')!.guesses[0]!.maximum).toBe(4900);
  expect(mocks.reveal).not.toHaveBeenCalled(); expect(mocks.revealBroadcast).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999); expect(mocks.reveal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect(mocks.reveal).toHaveBeenCalledOnce(); expect(ui.game!.stage).toBe('reveal');
  expect(mocks.receipt).toHaveBeenCalledWith(0, '123', '0909090909090909');
});

it('renews a missing receipt for an accepted duplicate and explicitly rejects a guess after closure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const f = await fixture(); f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Start new game')!.click(); await flush();
  const receiver = mocks.watchChat.mock.calls[0][1]; receiver.status('live', 'Connected');
  await vi.advanceTimersByTimeAsync(5000); (document.getElementById('stream-start-game') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(4000);
  const game = ui.game!, nonce = new Uint8Array(8).fill(1);
  const message = { id: 'accepted', player: { id: '123', login: 'chatter', name: 'Chatter' }, sentAt: Date.now(),
    text: formatGuessCommand(1, streamAnswer, 5000, game.session.rounds[0].id, { userId: '123', nonce, label: 'Chatter submitted a guess.' }) };
  receiver.message(message); receiver.message(message);
  expect(mocks.receipt).toHaveBeenCalledTimes(2); expect(mocks.reject).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(game.timing!.deadline! - Date.now() + STREAM_SUBMISSION_GRACE_MS + 1);
  receiver.message({ ...message, id: 'late', sentAt: Date.now(), text: formatGuessCommand(1, streamAnswer, 5000,
    game.session.rounds[0].id, { userId: '123', nonce: new Uint8Array(8).fill(2), label: 'Chatter submitted a guess.' }) });
  expect(mocks.reject).toHaveBeenCalledWith(0, '123', '0202020202020202', 'closed');
});

it.each([[false, 3], [true, 1]] as const)('automatically posts invitations on game creation, then waits for an explicit start (announcement: %s)', async (announcements, posts) => {
  vi.useFakeTimers(); vi.setSystemTime(streamNow);
  const f = await fixture(); f.game.session.transport = 'twitch'; f.game.session.localChat = true;
  mocks.start.mockResolvedValue(f.game.session);
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(f.hooks); await ui.open();
  const toggle = document.getElementById('stream-share-announcements') as HTMLInputElement;
  toggle.checked = announcements; toggle.dispatchEvent(new Event('change'));
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Start new game')!.click(); await flush();
  mocks.watchChat.mock.calls[0][1].status('live', 'Connected');
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
  const { receiver } = await liveFixture();
  expect(document.getElementById('confirm-guess')!.closest('.game-panel--map')).not.toBeNull();
  const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
  for (const label of ['Pause', 'Skip round', 'Connect Twitch', 'Reconnect chat', 'Copy game link'])
    expect(labels).not.toContain(label);
  const recovery = document.getElementById('stream-reconnect')!;
  expect(recovery.hidden).toBe(true);
  receiver.status('reconnecting', 'Reconnecting…');
  expect(recovery.hidden).toBe(true);
  expect(document.getElementById('stream-chat-status')!.dataset.connection).toBe('reconnecting');
  receiver.status('auth-required', 'Please sign in to Twitch again.');
  expect(recovery.hidden).toBe(false);
  expect(recovery.textContent).toBe('Authorize Twitch');
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
  expect(mocks.connect).not.toHaveBeenCalled();
  consent.click(); await flush();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ announcements: true });
  expect(consent.hidden).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('keeps hosting available with copy fallback and never redirects for sharing permission mid-game', async () => {
  mocks.shareAccess = false;
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await liveFixture();
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
  expect(consent.hidden).toBe(false);
  consent.click(); await flush();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ announcements: false });
  expect(consent.hidden).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
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

it('stops the live Twitch reader when quitting and ignores a late chat delivery', async () => {
  const { game, hooks } = await fixture();
  game.session.host = { id: '900000000', login: 'streamer', name: 'Local host' };
  game.session.localChat = true;
  mocks.start.mockResolvedValue(game.session);
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open();
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Start new game')!.click();
  await flush();
  const receiver = mocks.watchChat.mock.calls[0][1];
  const stop = mocks.watchChat.mock.results[0].value;
  await ui.quit();
  expect(stop).toHaveBeenCalledOnce();
  receiver.message({ id: 'late-message', player: { id: '123', login: 'chatter', name: 'Chatter' }, sentAt: streamNow + 50,
    text: formatGuessCommand(1, streamAnswer, 5000, game.session.rounds[0].id, { userId: '123' }) });
  expect(ui.game).toBeNull();
  expect(localStorage.getItem(STREAM_SESSION_KEY)).toBeNull();
});

it('receives real-channel chat in localhost mode and submits both host and chatter for the reveal', async () => {
  const { game, hooks, service } = await fixture();
  game.session.host = { id: '900000000', login: 'streamer', name: 'Local host' };
  game.session.localChat = true;
  mocks.start.mockResolvedValue(game.session);
  mocks.reveal.mockResolvedValue(await service.reveal(game.session.rounds[0].token, streamHost, streamNow + 20));
  history.replaceState(null, '', '/guess/stream/');
  ui = new StreamUI(hooks); await ui.open();
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
  button('Start new game').click(); await flush();
  expect(mocks.channel).toHaveBeenCalledWith('streamer');
  expect(mocks.watchChat).toHaveBeenCalledExactlyOnceWith('noitaguessr', expect.any(Object));
  const receiver = mocks.watchChat.mock.calls[0][1];
  receiver.message({ id: 'message-1', player: { id: '123', login: 'streamer', name: 'WUOTE' }, sentAt: streamNow + 50,
    text: formatGuessCommand(1, streamAnswer, 4900, game.session.rounds[0].id, { userId: '123' }) });
  expect(document.querySelector('#stream-guess-count')!.textContent).toBe('Chat round 1: 1 submitted');
  expect(ui.game!.participants).toHaveLength(2);
  ui.game!.guess = streamAnswer; ui.render();
  button('Submit guess').click(); await flush();
  expect(mocks.reveal.mock.calls[0][1]).toEqual(expect.arrayContaining([
    { player: { id: '123', login: 'streamer', name: 'WUOTE' }, guess: streamAnswer, maximum: 4900 },
    { player: game.session.host, guess: streamAnswer, maximum: 5000 },
  ]));
  expect(ui.game!.stage).toBe('reveal');
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
  expect(button('Export scores (JSON)').closest('details')!.open).toBe(false);
  expect(document.body.textContent).toContain('search and sort every player’s scores offline');
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
  expect(button('Back').closest('.page-heading')).not.toBeNull();
  expect(button('Back').parentElement!.firstElementChild).toBe(button('Back'));
  expect(button('Start another game').parentElement!.classList.contains('action-row')).toBe(true);
  expect(document.querySelector('.stream-publication a')!.textContent).toBe('streamer’s results');
  expect(document.querySelector('h1')!.textContent).toBe('streamer’s results');
  button('Copy result link').click(); for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith(location.origin + '/guess/results/' + game.session.id + '/');
  expect(mocks.notice).toHaveBeenCalledWith('Copied', 'success');
  expect(hooks.toast).not.toHaveBeenCalled();
});


it('recovers a failed publication from its result URL after a new game and F5, then retries exactly once', async () => {
  const { game, hooks, service } = await fixture();
  game.session.localChat = true;
  for (const round of game.session.rounds) {
    closeStreamRound(game, streamAnswer, streamNow + 1);
    revealStreamRound(game, await service.reveal(round.token, streamHost, streamNow + 2));
    advanceStreamRound(game, streamNow + 3);
  }
  mocks.publish.mockRejectedValueOnce(new Error('Offline'));
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(hooks); ui.game = game; ui.render();
  await vi.waitFor(() => expect(document.getElementById('stream-publish-message')?.textContent).toContain('Not published.'));
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(document.getElementById('stream-publish-message')!.closest('.stream-publication')!.compareDocumentPosition(document.querySelector('.stream-score-table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The next game replaces the singleton host session; the prior retry survives.
  ui.game = (await fixture()).game; ui.save();
  ui.suspend(); ui = new StreamUI(hooks); await ui.publicResult(game.session.id);
  expect(mocks.result).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Not published yet.'));
  expect(document.body.textContent).not.toContain(game.session.token);
  mocks.publish.mockResolvedValue({ id: game.session.id, published: true });
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry publishing')!.click();
  await vi.waitFor(() => expect(document.getElementById('stream-publish-message')?.textContent).toContain('Result saved to the local test server.'));
  expect(mocks.publish).toHaveBeenCalledTimes(2);
  expect(mocks.channel).toHaveBeenLastCalledWith(game.session.host.login);
  expect(mocks.publish.mock.calls[1][0]).toEqual({ token: game.session.token, finishedAt: game.finishedAt, players: streamResult(game).players });
  expect(JSON.parse(localStorage.getItem(STREAM_SESSION_KEY)!).session.id).not.toBe(game.session.id);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Copy result link')!.disabled).toBe(false);
});


it('labels the streamer’s last round and gives its rendered score table 15 seconds, not the unused round timer', async () => {
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
  mocks.roundView.mockImplementationOnce((main, _game, _index, actions) => { vi.setSystemTime(streamNow + 3000); main.append(actions); return () => {}; });
  history.replaceState(null, '', '/guess/stream/'); ui = new StreamUI(hooks); ui.game = game; ui.render();
  expect(game.timing!.resultsUntil).toBe(streamNow + 18000);
  expect(document.getElementById('stream-auto-next')!.textContent).toBe('View results: 00:15');
  expect(document.getElementById('stream-round-timer')!.textContent).toBe('00:15');
  expect(document.querySelector('.stream-toolbar-round')!.textContent).toContain('Your round 10 / 10');
  expect(document.body.textContent).toContain('All 10 rounds for chatters are over.');
  vi.setSystemTime(streamNow + 4000); ui.render();
  expect(game.timing!.resultsUntil).toBe(streamNow + 18000); // Rendering again must not restart the timer.
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
