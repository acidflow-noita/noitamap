// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let updateOverflowMenu: typeof import('../src/overflow-menu').updateOverflowMenu;
let media: EventTarget & { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
let row: HTMLElement;

function resize(narrowDesktop: boolean): void {
  media.matches = narrowDesktop;
  media.dispatchEvent(new Event('change'));
}

beforeEach(async () => {
  vi.resetModules();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  row = parsed.getElementById('map-menu-controls')!;
  document.body.append(row);
  // These controls are created at runtime. They must remain beside boundaries
  // while the existing secondary controls move between their two containers.
  for (const id of ['dynamicGenerateWrapper', 'seed-report-ui-wrapper', 'drawing-ui-wrapper']) {
    const control = document.createElement('div');
    control.id = id;
    row.append(control);
  }
  const target = new EventTarget();
  media = Object.assign(target, {
    matches: false,
    addEventListener: vi.fn(target.addEventListener.bind(target)),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  ({ updateOverflowMenu } = await import('../src/overflow-menu'));
});

afterEach(() => {
  resize(false);
  updateOverflowMenu('regular-main-branch');
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('responsive overflow controls', () => {
  it('moves static secondary controls at narrow desktop widths and restores the same live elements', () => {
    const originalOrder = Array.from(row.children);
    const overlays = document.getElementById('overlay-selector')!;
    const input = document.getElementById('structuresToggler') as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>('label[for="structuresToggler"]')!;
    const change = vi.fn();
    input.checked = true;
    input.addEventListener('change', change);
    media.matches = true;

    updateOverflowMenu('regular-main-branch');
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 992px) and (max-width: 1199.98px)');
    for (const id of ['overlay-selector', 'shareButton', 'spoilerFreeToggle']) {
      expect(document.getElementById(id)!.parentElement?.id).toBe('more-menu-controls');
    }
    for (const id of ['dynamicGenerateWrapper', 'biome-boundaries-ui-wrapper', 'seed-report-ui-wrapper', 'drawing-ui-wrapper']) {
      expect(document.getElementById(id)!.parentElement).toBe(row);
    }
    expect(document.getElementById('structuresToggler')).toBe(input);
    expect(input.checked).toBe(true);
    label.click();
    expect(change).toHaveBeenCalledOnce();
    expect(input.checked).toBe(false);

    resize(false);
    expect(overlays.parentElement).toBe(row);
    expect(Array.from(row.children)).toEqual(originalOrder);
    expect(document.getElementById('structuresToggler')).toBe(input);
    label.click();
    expect(change).toHaveBeenCalledTimes(2);
    expect(input.checked).toBe(true);
  });

  it('responds to desktop and mobile breakpoint changes with one listener and no duplicate controls', () => {
    updateOverflowMenu('regular-main-branch');
    const originalOrder = Array.from(row.children);
    // False represents either a wide desktop or the collapsed mobile layout.
    for (const narrow of [true, false, true, false]) {
      resize(narrow);
      updateOverflowMenu('regular-main-branch');
      expect(document.getElementById('overlay-selector')!.parentElement?.id)
        .toBe(narrow ? 'more-menu-controls' : 'map-menu-controls');
      expect(document.querySelectorAll('#structuresToggler')).toHaveLength(1);
      expect(document.querySelectorAll('label[for="spoilerFreeToggle"]')).toHaveLength(1);
    }
    expect(window.matchMedia).toHaveBeenCalledOnce();
    expect(media.addEventListener).toHaveBeenCalledOnce();
    expect(Array.from(row.children)).toEqual(originalOrder);
  });

  it('keeps dynamic controls in More across resizes and uses the current map when restoring static controls', () => {
    updateOverflowMenu('dynamic-main-branch');
    const overlays = document.getElementById('overlay-selector')!;
    for (const narrow of [true, false]) {
      resize(narrow);
      expect(overlays.parentElement?.id).toBe('more-menu-controls');
    }
    resize(true);
    updateOverflowMenu('regular-main-branch');
    expect(overlays.parentElement?.id).toBe('more-menu-controls');
    resize(false);
    expect(overlays.parentElement).toBe(row);
    updateOverflowMenu('dynamic-main-branch');
    expect(overlays.parentElement?.id).toBe('more-menu-controls');
    updateOverflowMenu('regular-main-branch');
    expect(overlays.parentElement).toBe(row);
  });
});
