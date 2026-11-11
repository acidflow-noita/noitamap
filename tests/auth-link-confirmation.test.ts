// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ listeners: new Set<() => void>(), prefix: '' }));
vi.mock('../src/i18n', () => ({
  default: { loadNamespaces: async () => {}, t: (key: string) => mocks.prefix + key,
    on: (_: string, fn: () => void) => mocks.listeners.add(fn), off: (_: string, fn: () => void) => mocks.listeners.delete(fn) },
  initializeTranslations: async () => {}, registerTranslationNamespace: () => {},
}));
vi.mock('../src/auth/control-translations', () => ({ bindAuthText: (node: Node, _key: string, text: string) => { node.textContent = text; } }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private element: HTMLDialogElement) {}
  async show() { this.element.open = true; this.element.dispatchEvent(new Event('shown.bs.dialog')); }
  async hide() { this.element.open = false; this.element.dispatchEvent(new Event('hidden.bs.dialog')); }
  dispose() {}
} }));
import { confirmAccountLink } from '../src/auth/confirm-link';
const review = { current: [{ provider: 'patreon' as const, userId: '123', name: 'Current' }],
  target: { provider: 'twitch' as const, userId: '456', name: '<img src=x onerror=alert(1)>' } };
afterEach(() => { document.body.replaceChildren(); mocks.listeners.clear(); mocks.prefix = ''; });
it('defaults focus to Cancel, renders identities as text and does not link on dismiss', async () => {
  const decision = confirmAccountLink(review);
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  expect(document.activeElement?.textContent).toBe('Cancel');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('strong')?.textContent).toContain(review.target.name);
  (document.activeElement as HTMLButtonElement).click();
  expect(await decision).toBe(false); expect(document.querySelector('dialog')).toBeNull();
  expect(mocks.listeners.size).toBe(0);
});
it('updates the confirmation labels on language change and requires a single explicit click', async () => {
  const decision = confirmAccountLink(review);
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  mocks.prefix = 'Translated: '; mocks.listeners.forEach(fn => fn());
  const button = document.querySelector('button.theme-primary') as HTMLButtonElement;
  expect(button.textContent).toBe('Translated: Connect account');
  button.dispatchEvent(new MouseEvent('click', { detail: 2 }));
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  button.click(); expect(await decision).toBe(true);
});
