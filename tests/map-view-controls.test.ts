// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountCreatureSpawnNotice } from '../src/creature-spawn-notice';
import { placeBiomeBoundariesButton, updateOverflowMenu } from '../src/overflow-menu';

vi.mock('../src/i18n', () => ({ default: {
  t: (_key: string, fallback: string) => fallback,
  on: vi.fn(),
  off: vi.fn(),
} }));

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const disposers: Array<() => void> = [];

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.append(parsed.querySelector('.full-viewport-wrapper')!);
});

afterEach(() => {
  updateOverflowMenu('regular-main-branch');
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe('temporary map controls in the application layout', () => {
  it('keeps a signed-out shared-link notice out of the navbar flex row and both collapsed menus', () => {
    const host = document.getElementById('map-view-controls')!;
    const map = document.getElementById('osContainer')!;
    const navbar = document.querySelector('.mapNavbar')!;
    const search = document.getElementById('search-form')!;
    const searchParent = search.parentElement;
    const upgrade = vi.fn();
    const dismiss = vi.fn();
    const notice = mountCreatureSpawnNotice(host, upgrade, dismiss);
    disposers.push(notice.dispose);
    notice.update('locked');

    // The wrapper reverses its column: navbar, controls, then the map. The
    // notice must never become a full-width item in the desktop navbar row.
    expect(map.nextElementSibling).toBe(host);
    expect(host.nextElementSibling).toBe(navbar);
    expect(host.parentElement).toBe(navbar.parentElement);
    expect(host.closest('.navbar, .navbar-collapse, #more-menu')).toBeNull();

    for (const name of ['dynamic-main-branch', 'regular-main-branch', 'dynamic-main-branch']) {
      updateOverflowMenu(name);
      const message = host.querySelector<HTMLElement>('#creature-spawn-notice')!;
      expect(message.parentElement).toBe(host);
      expect(message.hidden).toBe(false);
      expect(search.parentElement).toBe(searchParent);
      expect(host.querySelector('#search-form')).toBeNull();
      expect(document.querySelector('.navbar-collapse.show')).toBeNull();
    }

    const [unlock, close] = host.querySelectorAll<HTMLButtonElement>('#creature-spawn-notice button');
    unlock.click();
    expect(upgrade).toHaveBeenCalledOnce();
    close.click();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLElement>('#creature-spawn-notice')!.hidden).toBe(true);
  });

  it('keeps the original biome toggle between Generate and Report across map changes', () => {
    const boundaries = document.getElementById('biome-boundaries-ui-wrapper')!;
    const input = document.getElementById('biomeBoundariesToggler') as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>('label[for="biomeBoundariesToggler"]')!;
    const row = boundaries.parentElement!;
    const generate = document.createElement('span');
    generate.id = 'dynamicGenerateWrapper';
    const report = document.createElement('div');
    report.id = 'seed-report-ui-wrapper';
    row.append(generate, report);
    input.checked = true;
    const listener = vi.fn();
    input.addEventListener('change', listener);

    placeBiomeBoundariesButton();
    for (const name of ['dynamic-main-branch', 'regular-main-branch', 'dynamic-main-branch']) {
      updateOverflowMenu(name);
      placeBiomeBoundariesButton();
      expect(generate.nextElementSibling).toBe(boundaries);
      expect(boundaries.nextElementSibling).toBe(report);
      expect(boundaries.parentElement).toBe(row);
      expect(boundaries.closest('#more-menu')).toBeNull();
      expect(document.querySelectorAll('#biomeBoundariesToggler')).toHaveLength(1);
      expect(document.getElementById('biomeBoundariesToggler')).toBe(input);
      expect(input.checked).toBe(true);
      expect(label.dataset.i18nTitle).toBe('biomeBoundaries.title');
      expect(document.getElementById('chunkGridToggler')!.closest('#overlay-selector')).not.toBeNull();
      expect(document.getElementById('sideworldToggler')!.closest('#overlay-selector')).not.toBeNull();
    }

    label.click();
    expect(listener).toHaveBeenCalledOnce();
    expect(input.checked).toBe(false);
  });

  it('places boundaries before Report when Generate has not been created', () => {
    const boundaries = document.getElementById('biome-boundaries-ui-wrapper')!;
    const row = boundaries.parentElement!;
    const report = document.createElement('div');
    report.id = 'seed-report-ui-wrapper';
    row.prepend(report);
    placeBiomeBoundariesButton();
    expect(boundaries.nextElementSibling).toBe(report);
    expect(boundaries.parentElement).toBe(row);
  });
});
