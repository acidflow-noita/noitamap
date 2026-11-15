// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGuessrChangelog, GUESSR_CHANGELOG } from '../src/guessr/changelog';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import i18next from '../src/i18n';

vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private element: HTMLDialogElement) {}
  async show() {
    this.element.setAttribute('open', '');
    this.element.dispatchEvent(new Event('shown.bs.dialog', { bubbles: true }));
  }
  async hide() {
    this.element.removeAttribute('open');
    this.element.dispatchEvent(new Event('hidden.bs.dialog', { bubbles: true }));
  }
  dispose() { this.element.removeAttribute('open'); }
} }));
const controllers: ReturnType<typeof createGuessrChangelog>[] = [];
function create(id?: string) {
  const controller = createGuessrChangelog(id ? { ...GUESSR_CHANGELOG, id } : undefined);
  controllers.push(controller); return controller;
}
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const dialog = () => document.querySelector<HTMLDialogElement>('.guessr-changelog');
beforeEach(async () => {
  for (const kind of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(kind, { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  }
  await initializeGuessrTranslations(); await i18next.changeLanguage('en');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Updates must not request game data'); }));
});
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (i18next.isInitialized) await i18next.changeLanguage('en');
  vi.unstubAllGlobals();
});

it('waits for a safe screen, closes when play starts, and does not repeat on navigation or reload', async () => {
  let controller = create(); await flush(); expect(dialog()).toBeNull();
  controller.setSafe(true); await flush(); expect(dialog()?.open).toBe(true);
  controller.setSafe(false); await flush(); expect(dialog()).toBeNull();
  controller.setSafe(true); await flush(); expect(dialog()).toBeNull();
  controller.destroy(); controller = create(); controller.setSafe(true);
  await flush(); expect(dialog()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('remembers a seen release across sessions, but shows a new release in a later session', async () => {
  const first = create(); first.setSafe(true); await flush(); first.destroy();
  sessionStorage.clear(); const same = create(); same.setSafe(true);
  await flush(); expect(dialog()).toBeNull(); same.destroy();
  const next = create('next-release'); next.setSafe(true);
  await flush(); expect(dialog()?.open).toBe(true);
});

it('does not open twice in one session even if another release arrives', async () => {
  const first = create(); first.setSafe(true); await flush(); first.destroy();
  const next = create('next-release'); next.setSafe(true);
  await flush(); expect(dialog()).toBeNull(); next.destroy();
  sessionStorage.clear(); const nextSession = create('next-release'); nextSession.setSafe(true);
  await flush(); expect(dialog()?.open).toBe(true);
});

it('waits for another dialog to close and never opens during play', async () => {
  const other = document.createElement('dialog'); other.open = true; document.body.append(other);
  const controller = create(); controller.setSafe(true); await flush(); expect(dialog()).toBeNull();
  controller.setSafe(false); other.open = false;
  other.dispatchEvent(new Event('hidden.bs.dialog', { bubbles: true }));
  await flush(); expect(dialog()).toBeNull();
  controller.setSafe(true); await flush(); expect(dialog()?.open).toBe(true);
});

it('works with blocked storage without repeating in the current page', async () => {
  for (const storage of [localStorage, sessionStorage]) {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw Error('blocked'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw Error('blocked'); });
  }
  const controller = create(); controller.setSafe(true); await flush(); expect(dialog()?.open).toBe(true);
  controller.setSafe(false); controller.setSafe(true); await flush(); expect(dialog()).toBeNull();
});

it('allows a deliberate reopen and translates the open dialog without rebuilding it', async () => {
  const controller = create(); controller.setSafe(true); await flush(); controller.setSafe(false);
  const trigger = document.createElement('button'); document.body.append(trigger);
  controller.show(trigger); await flush(); const element = dialog()!;
  expect(element.open).toBe(true);
  expect(element.querySelector('h1')?.textContent).toBe("What's new");
  await i18next.changeLanguage('de');
  expect(dialog()).toBe(element);
  expect(element.querySelector('h1')?.textContent).not.toBe("What's new");
  expect(element.querySelectorAll('li')).toHaveLength(GUESSR_CHANGELOG.notes.length);
  expect(element.querySelector('.dialog-footer button')?.textContent).toBe('Schließen');
});
