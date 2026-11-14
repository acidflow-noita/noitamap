// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountPvpSetup } from '../src/guessr/pvp-setup';

const mocks = vi.hoisted(() => ({ pro: true, provider: 'twitch', login: vi.fn(), start: vi.fn(async () => ({ id: 'match', mode: 'pvp', transport: 'parallel' })) }));
vi.mock('../src/guessr/stream-api', () => ({ StreamApi: class { origin = 'https://api.test'; start = mocks.start; } }));
vi.mock('../src/guessr/api', () => ({ gameAuth: async () => ({ getState: () => ({ isSubscriber: mocks.pro, provider: mocks.provider }), registerLoginPreparation() {}, loginTwitch: mocks.login }) }));
vi.mock('../src/auth/pro-controls', () => ({ createProControls: () => document.createElement('div') }));
afterEach(() => { mocks.pro = true; mocks.provider = 'twitch'; vi.clearAllMocks(); document.body.replaceChildren(); });
it('creates the private default-five-round match with streaming off, and sends an explicit override when checked', async () => {
  const main = document.createElement('main'); document.body.append(main); const opened = vi.fn();
  const dispose = mountPvpSetup(main, opened, vi.fn());
  await vi.waitFor(() => expect(main.querySelector('fieldset')!.disabled).toBe(false));
  const toggle = main.querySelector<HTMLInputElement>('#pvp-streaming')!;
  expect(toggle.checked).toBe(false);
  const create = [...main.querySelectorAll('button')].find(b => b.textContent === 'Create match')!;
  create.click(); await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('match'));
  expect(mocks.start).toHaveBeenLastCalledWith('parallel', 5, 90, false, 'pvp');
  toggle.click(); create.click();
  await vi.waitFor(() => expect(mocks.start).toHaveBeenLastCalledWith('parallel', 5, 90, true, 'pvp'));
  dispose();
});
it('requires Pro to create the match while explaining that the invited opponent is free', async () => {
  mocks.pro = false;
  const main = document.createElement('main'); document.body.append(main);
  const dispose = mountPvpSetup(main, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(main.textContent).toContain('The Pro player creates the match. Their opponent can play for free.'));
  expect(main.querySelector('fieldset')!.disabled).toBe(true); expect(mocks.start).not.toHaveBeenCalled(); dispose();
});
it('offers the existing account-link flow to a Patreon Pro player without a linked Twitch identity', async () => {
  mocks.provider = 'patreon';
  const main = document.createElement('main'); document.body.append(main);
  const dispose = mountPvpSetup(main, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(main.textContent).toContain('Connect Twitch to your Pro account to create a 1v1 match.'));
  expect(main.querySelector('fieldset')!.disabled).toBe(true);
  [...main.querySelectorAll('button')].find(button => button.textContent === 'Connect Twitch')!.click();
  expect(mocks.login).toHaveBeenCalledOnce(); dispose();
});
