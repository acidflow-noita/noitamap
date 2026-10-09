// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from '../src/app';
import { showOverlay } from '../src/data_sources/overlays';

vi.mock('../src/app_osd', () => ({
  AppOSD: class {
    setMap = vi.fn(async () => {});
    getZoomPos = () => ({ x: 0, y: 0, z: 1 });
    onLoading = vi.fn();
    addHandler = vi.fn();
  },
}));
vi.mock('../src/data_sources/overlays', () => ({
  getAllOverlays: () => [
    ['biomeBoundaries', [{ maps: ['dynamic-main-branch', 'regular-main-branch'] }]],
    ['structures', [{ maps: ['regular-main-branch', 'ups-main'] }]],
  ],
  showOverlay: vi.fn(),
}));
vi.mock('../src/data_sources/map_definitions', () => ({ getAllMapDefinitions: () => [] }));
vi.mock('../src/i18n-dom', () => ({ updateTranslations: vi.fn() }));

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  disposed = false;
  constructor(private element: Element) { Popover.instances.set(element, this); }
  dispose() { this.disposed = true; Popover.instances.delete(this.element); }
}

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.append(parsed.querySelector('.full-viewport-wrapper')!);
  Popover.instances.clear();
  vi.stubGlobal('bootstrap', { Popover });
  vi.clearAllMocks();
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

const createApp = (map: Parameters<typeof App.create>[0]['initialState']['map']) => App.create({
  mountTo: document.getElementById('osContainer')!,
  overlayButtons: document.getElementById('overlay-selector') as HTMLDivElement,
  initialState: { map },
  useWebGL: false,
});

describe('standalone biome boundaries availability', () => {
  it('initializes the primary control and its popover on a supported map', async () => {
    await createApp('dynamic-main-branch');
    const input = document.getElementById('biomeBoundariesToggler') as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>('label[for="biomeBoundariesToggler"]')!;
    expect(input.disabled).toBe(false);
    expect(input.classList.contains('d-none')).toBe(false);
    expect(label.classList.contains('d-none')).toBe(false);
    expect(input.closest('#overlay-selector')).toBeNull();
    expect(Popover.getInstance(label)).not.toBeNull();
  });

  it('clears unavailable boundaries and restores the same toggle and popover on map return', async () => {
    const app = await createApp('regular-main-branch');
    const input = document.getElementById('biomeBoundariesToggler') as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>('label[for="biomeBoundariesToggler"]')!;
    const wrapper = document.getElementById('biome-boundaries-ui-wrapper')!;
    const originalPopover = Popover.getInstance(label)!;
    input.checked = true;

    await app.setMap('ups-main');
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false);
    expect(wrapper.classList.contains('d-none')).toBe(true);
    expect(label.classList.contains('d-none')).toBe(true);
    expect(originalPopover.disposed).toBe(true);
    expect(Popover.getInstance(label)).toBeNull();
    expect(showOverlay).toHaveBeenCalledWith('biomeBoundaries', false);
    expect((document.getElementById('structuresToggler') as HTMLInputElement).disabled).toBe(false);

    await app.setMap('dynamic-main-branch');
    expect(document.getElementById('biomeBoundariesToggler')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.checked).toBe(false);
    expect(wrapper.classList.contains('d-none')).toBe(false);
    expect(label.classList.contains('d-none')).toBe(false);
    expect(label.dataset.i18nTitle).toBe('biomeBoundaries.title');
    expect(Popover.getInstance(label)).not.toBeNull();
  });
});
