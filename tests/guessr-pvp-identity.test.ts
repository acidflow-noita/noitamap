// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { pvpViewer } from '../src/guessr/pvp-identity';
const state = vi.hoisted(() => ({ authenticated: true, isSubscriber: true, token: '', logout: vi.fn(), ticket: vi.fn(), options: undefined as any }));
vi.mock('../src/guessr/api', () => ({ gameAuth: async () => ({ getState: () => state, logout: state.logout }) }));
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class { hostSocketTicket = state.ticket; } }));
vi.mock('../src/guessr/twitch-viewer', () => ({ TwitchViewer: class { constructor(options: any) { state.options = options; } } }));
const ticket = (id = '123') => 'header.' + btoa(JSON.stringify({ v: 2, typ: 'game', aud: 'noitamap-guessr', twitchUserId: id, twitchLogin: 'wuote', name: 'WUOTE' })) + '.signature';
afterEach(() => { vi.clearAllMocks(); state.authenticated = state.isSubscriber = true; });
it('reuses the signed-in Pro account and its game ticket without a second Twitch login', async () => {
  state.ticket.mockResolvedValue(ticket()); await pvpViewer();
  expect(state.options.siteIdentity).toEqual({ userId: '123', login: 'wuote', displayName: 'WUOTE' });
  expect(await state.options.siteAuthorization()).toBe(ticket());
  state.options.siteSignOut(); expect(state.logout).toHaveBeenCalledOnce();
});
it('keeps a free invited player on the identity-only Twitch path', async () => {
  state.authenticated = state.isSubscriber = false; await pvpViewer();
  expect(state.options).toEqual({ chat: false }); expect(state.ticket).not.toHaveBeenCalled();
});
it('rejects an account change during ticket renewal', async () => {
  state.ticket.mockResolvedValue(ticket()); await pvpViewer();
  state.ticket.mockResolvedValue(ticket('456'));
  await expect(state.options.siteAuthorization()).rejects.toThrow('connection changed');
});
