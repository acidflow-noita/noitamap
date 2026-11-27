// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/auth-service';
import { pvpViewer } from '../src/guessr/pvp-identity';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';

const service = vi.hoisted(() => ({
  state: {} as AuthState, saved: false, listeners: new Set<(state: AuthState) => void>(),
  loginTwitch: vi.fn(), logout: vi.fn(async () => {}), checkAuth: vi.fn(), playerTicket: vi.fn(), hostTicket: vi.fn(),
}));
vi.mock('../src/guessr/api', () => ({ gameAuth: async () => ({
  getState: () => service.state, hasSavedSession: () => service.saved, loginTwitch: service.loginTwitch,
  logout: service.logout, checkAuth: service.checkAuth, getPlayerTicket: service.playerTicket,
  subscribe(listener: (state: AuthState) => void) {
    service.listeners.add(listener);
    return () => service.listeners.delete(listener);
  },
}) }));
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class { hostSocketTicket = service.hostTicket; } }));

const player = { userId: '123', login: 'player', displayName: 'Player' };
const signedOut: AuthState = { authenticated: false, isSubscriber: false, isFollower: false, username: null, nickname: null, provider: null };
const signedIn: AuthState = { ...signedOut, authenticated: true, isSubscriber: true, provider: 'twitch', accountId: 'account',
  linkedAccounts: [{ ...player, username: player.displayName, provider: 'twitch', membershipStatus: 'active', isSubscriber: true, isFollower: true, checkedAt: 1 }] };
const hostTicket = (id = player.userId) => 'header.' + btoa(JSON.stringify({ v: 2, typ: 'game', aud: 'noitamap-guessr',
  twitchUserId: id, twitchLogin: player.login, name: player.displayName })) + '.signature';
function update(state: AuthState) {
  service.state = state;
  for (const listener of service.listeners) listener(state);
}
let viewer: TwitchViewer;
beforeEach(() => {
  vi.resetAllMocks();
  service.saved = false; service.state = signedIn;
  service.hostTicket.mockResolvedValue(hostTicket());
  service.playerTicket.mockResolvedValue({ token: 'participant-ticket', player });
  service.logout.mockImplementation(async () => update(signedOut));
});
afterEach(() => { viewer?.dispose(); service.listeners.clear(); });

it('reuses the verified host identity and signs out only on request', async () => {
  viewer = await pvpViewer();
  expect(viewer.getState()).toMatchObject({ connected: true, ...player });
  expect(await viewer.transportAuthorization()).toEqual({ role: 'host', ticket: hostTicket() });
  expect(service.loginTwitch).not.toHaveBeenCalled();
  viewer.disconnect(); expect(service.logout).toHaveBeenCalledOnce();
});
it('starts site sign-in for a genuinely signed-out invite', async () => {
  service.state = signedOut;
  viewer = await pvpViewer('player'); await viewer.connect();
  expect(service.loginTwitch).toHaveBeenCalledOnce();
  expect(service.checkAuth).not.toHaveBeenCalled(); expect(service.playerTicket).not.toHaveBeenCalled();
});
it.each([true, false])('uses a renewed participant ticket for a chatter with Pro=%s', async isSubscriber => {
  service.state = { ...signedIn, isSubscriber };
  viewer = await pvpViewer('player');
  expect(viewer.getState()).toMatchObject({ connected: true, ...player });
  expect(await viewer.transportAuthorization(true)).toEqual({ role: 'account', ticket: 'participant-ticket' });
  expect(service.playerTicket).toHaveBeenLastCalledWith(true);
  expect(service.hostTicket).not.toHaveBeenCalled();
});
it('rejects a different identity during ticket renewal', async () => {
  viewer = await pvpViewer();
  service.hostTicket.mockResolvedValue(hostTicket('456'));
  await expect(viewer.transportAuthorization(true)).rejects.toThrow('connection changed');
});
it('restores a saved session on an invitation after a temporary check failure, without starting OAuth', async () => {
  service.state = signedOut; service.saved = true;
  viewer = await pvpViewer('player');
  expect(viewer.getState()).toMatchObject({ connected: false, error: 'Could not verify Twitch sign-in. Please connect again.' });
  await expect(viewer.connect()).rejects.toThrow('Could not verify');
  service.checkAuth.mockImplementation(async () => update(signedIn));
  await viewer.connect();
  expect(viewer.getState()).toMatchObject({ connected: true, ...player, error: null });
  expect(service.loginTwitch).not.toHaveBeenCalled(); expect(service.logout).not.toHaveBeenCalled();
});
it('recognizes a login from another tab and disconnects when that account signs out', async () => {
  service.state = signedOut;
  viewer = await pvpViewer('player');
  update(signedIn);
  await vi.waitFor(() => expect(viewer.getState()).toMatchObject({ connected: true, ...player }));
  update(signedOut);
  expect(viewer.getState().connected).toBe(false);
  await expect(viewer.transportAuthorization()).rejects.toThrow();
  expect(service.logout).not.toHaveBeenCalled();
});
it('discards a pending participant ticket if its account signs out while the request is in flight', async () => {
  service.state = signedOut;
  viewer = await pvpViewer('player');
  let finish!: (ticket: unknown) => void;
  service.playerTicket.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  update(signedIn); update(signedOut);
  finish({ token: 'participant-ticket', player });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(viewer.getState().connected).toBe(false);
});
