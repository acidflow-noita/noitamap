// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCreatureSpawnNotice } from '../src/creature-spawn-notice';

const language = vi.hoisted(() => ({ listeners: new Set<() => void>(), values: {} as Record<string, string> }));
vi.mock('../src/i18n', () => ({ default: {
  t: (key: string, fallback: string) => language.values[key] ?? fallback,
  on: (_event: string, fn: () => void) => language.listeners.add(fn),
  off: (_event: string, fn: () => void) => language.listeners.delete(fn),
} }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined;
  document.body.replaceChildren();
  language.values = {};
  expect(language.listeners.size).toBe(0);
});

function setup() {
  document.body.innerHTML = '<nav><div class="container-fluid"><button class="navbar-toggler"></button><div class="collapse"><div id="more-menu"></div></div></div></nav><div id="map-view-controls"></div><input id="focused">';
  const parent = document.getElementById('map-view-controls')!;
  const onUpgrade = vi.fn(), onDismiss = vi.fn();
  const controller = mountCreatureSpawnNotice(parent, onUpgrade, onDismiss);
  dispose = controller.dispose;
  const notice = document.getElementById('creature-spawn-notice')!;
  const message = notice.querySelector<HTMLElement>('[role="status"]')!;
  const [upgrade, close] = Array.from(notice.querySelectorAll('button'));
  return { parent, controller, notice, message, upgrade, close, onUpgrade, onDismiss };
}

describe('shared spawn selection notice', () => {
  it('starts hidden and appears after both menus without stealing focus', () => {
    const { parent, controller, notice, message, upgrade, onUpgrade } = setup();
    const focused = document.getElementById('focused')!;
    focused.focus();
    expect(notice.hidden).toBe(true);
    expect(message.textContent).toBe('');
    expect(notice.parentElement).toBe(parent);
    expect(parent.lastElementChild).toBe(notice);
    expect(notice.closest('nav, .collapse, #more-menu')).toBeNull();
    controller.update('locked');
    expect(notice.hidden).toBe(false);
    expect(message.textContent).toBe('Spawn biome highlighting is a Pro feature.');
    expect(upgrade.hidden).toBe(false);
    expect(upgrade.textContent).toBe('Unlock with Pro');
    expect(document.activeElement).toBe(focused);
    expect(onUpgrade).not.toHaveBeenCalled();
    upgrade.click();
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it('explains unavailable data without offering Pro and hides again on activation', () => {
    const { controller, notice, message, upgrade, onUpgrade } = setup();
    controller.update('locked');
    upgrade.focus();
    controller.update('unavailable');
    expect(notice.hidden).toBe(false);
    expect(message.textContent).toBe('Spawn biomes are unavailable for this creature on this map.');
    expect(upgrade.hidden).toBe(true);
    expect(document.activeElement).not.toBe(upgrade);
    upgrade.click();
    expect(onUpgrade).not.toHaveBeenCalled();
    controller.update(null);
    expect(notice.hidden).toBe(true);
    expect(message.textContent).toBe('');
  });

  it('dismisses once, releases hidden focus, and permits a subsequent shared selection', () => {
    const { controller, notice, close, onDismiss } = setup();
    controller.update('locked');
    close.focus(); close.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(notice.hidden).toBe(true);
    expect(document.activeElement).not.toBe(close);
    close.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    controller.update('unavailable');
    expect(notice.hidden).toBe(false);
  });

  it('updates text and button labels on language changes and disposes its listeners', () => {
    const { controller, notice, message, upgrade, close, onDismiss, onUpgrade } = setup();
    controller.update('locked');
    language.values = {
      'extended.spawnBiomesPro': 'Подсветка биомов появления доступна с Pro.',
      'extended.cta': 'Разблокировать с Pro',
      'seedReport.close': 'Закрыть',
    };
    language.listeners.forEach(fn => fn());
    expect(message.textContent).toBe(language.values['extended.spawnBiomesPro']);
    expect(upgrade.textContent).toBe('Разблокировать с Pro');
    expect(close.title).toBe('Закрыть');
    expect(close.getAttribute('aria-label')).toBe('Закрыть');
    dispose!(); dispose = undefined;
    expect(notice.isConnected).toBe(false);
    expect(language.listeners.size).toBe(0);
    upgrade.click(); close.click();
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    controller.update('unavailable');
    expect(notice.isConnected).toBe(false);
  });
});
