// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountAccountMenu, bindViewerAccount } from '../src/guessr/account-menu';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';

const model = vi.hoisted(() => ({
  state: { authenticated: true, accountId: 'one', username: 'Player', isSubscriber: false,
    linkedAccounts: [{ provider: 'twitch', userId: '123', username: 'Player', membershipStatus: 'inactive' }] },
  listeners: new Set<() => void>(), refresh: vi.fn(), logout: vi.fn(), login: vi.fn(),
}));
vi.mock('../src/guessr/api', () => ({ gameAuth: async () => ({ getState: () => model.state,
  subscribe: (listener: () => void) => { model.listeners.add(listener); return () => model.listeners.delete(listener); },
  refreshMembership: model.refresh, logout: model.logout, login: model.login, loginTwitch: model.login,
}) }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  static getInstance() { return { dispose() {} }; }
  constructor(private node: HTMLDialogElement) {}
  async show() { this.node.setAttribute('open', ''); }
  async hide() { this.node.dispatchEvent(new Event('hidden.bs.dialog')); }
  dispose() {}
} }));
let dispose = () => {};
beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  await initializeGuessrTranslations(); model.state.isSubscriber = false; model.listeners.clear(); vi.clearAllMocks();
  document.body.innerHTML = '<header><div class="header-actions"></div></header>';
  localStorage.setItem('noitamap_jwt', 'test.account.session');
  dispose = mountAccountMenu(document.querySelector('.header-actions')!);
  await Promise.resolve(); await Promise.resolve();
});
afterEach(() => { dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('keeps account actions separate and updates the same identity when Pro is granted', async () => {
  document.querySelector<HTMLButtonElement>('.guessr-account')!.click();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector('.account-name')!.textContent).toBe('Player');
  expect(dialog.querySelector('.badge.pro')).toBeNull();
  expect(dialog.textContent).not.toMatch(/Playing as|How to play|Exit game/);
  expect(dialog.querySelectorAll('.btn-close')).toHaveLength(1);
  expect(dialog.querySelector('.dialog-footer')).toBeNull();
  model.refresh.mockImplementation(async () => { model.state.isSubscriber = true; model.listeners.forEach(notify => notify()); });
  [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Refresh Pro status')!.click();
  await vi.waitFor(() => expect(dialog.querySelector('.account-name')!.nextElementSibling?.textContent).toBe('Pro'));
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(document.querySelector('.guessr-account .badge.pro')).not.toBeNull();
  expect(model.logout).not.toHaveBeenCalled();
});

it('does not display another signed-in account’s Pro badge on a different chatter identity', () => {
  model.state.isSubscriber = true;
  const release = bindViewerAccount({ getState: () => ({ connected: true, userId: '456', login: 'other', displayName: 'Other' }),
    subscribe: (listener: () => void) => { listener(); return () => {}; },
  } as unknown as TwitchViewer);
  expect(document.querySelector('.account-label')!.textContent).toBe('Other');
  expect(document.querySelector('.guessr-account .badge.pro')).toBeNull();
  release(); expect(document.querySelector('.account-label')!.textContent).toBe('Player');
});
