// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import i18next from '../src/i18n';

// Terrain generation and camera placement are independent of card contents.
vi.mock('../src/telescope/prepared-scene-pixels', () => ({ prepareScenePixelInputs: vi.fn() }));
vi.mock('../src/telescope/load-telescope', () => ({ loadTelescopeModules: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({}));
vi.mock('../src/telescope/terrain-elevator', () => ({}));
vi.mock('../src/telescope/telescope-data-bridge', () => ({}));
vi.mock('../src/dynamic-map', () => ({ getCurrentDynamicSeed: () => 1, getCurrentIsDaily: () => true }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prepareInstantTerrain: vi.fn() }));
vi.mock('../src/telescope/biome-background-layer', () => ({}));
vi.mock('../src/data-archive', () => ({ getDataZip: vi.fn() }));
vi.mock('../src/telescope/poi-card-placement', async importOriginal => ({
  ...await importOriginal<typeof import('../src/telescope/poi-card-placement')>(),
  mountPOICardPlacement: () => () => {},
}));
const access = vi.hoisted(() => ({ pro: false }));
vi.mock('../src/auth/auth-service', () => ({ authService: {
  getState: () => ({ authenticated: access.pro, isSubscriber: access.pro }),
  subscribe: () => () => {},
} }));

beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  await i18next.init({ lng: 'en', resources: { en: { translation: { gameContent: { biomes: { biome_wandcave: 'Magical temple' } } } } } });
  vi.stubGlobal('OpenSeadragon', { Point: class { constructor(readonly x: number, readonly y: number) {} } });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([false, true])('keeps the Shapechanger stats, optional biome and position in separate rows (Pro %s)', async pro => {
  access.pro = pro;
  const catalog = readFileSync('public/assets/full_creatures.json', 'utf8');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('full_creatures.json') ? catalog : '[]')));
  const { openTooltipForPOI, closePOICard } = await import('../src/telescope/telescope-osd-bridge');
  const viewer = { canvas: document.createElement('div'), panToTarget: async () => true };
  const marker = { id: 'shapechanger', type: 'entity', entity: 'necromancer', isHorde: true, x: -4853, y: 4473 };
  try {
    for (const biome of ['wandcave', undefined]) {
      openTooltipForPOI(marker.id, viewer, { fallbackPoi: { ...marker, biome } });
      await vi.waitFor(() => expect(document.querySelector('.poi-card-body')).toBeTruthy());
      const body = document.querySelector<HTMLElement>('.poi-card-body')!;
      expect(body.previousElementSibling?.querySelector('button.btn-close')).toBeTruthy();
      const sections = Array.from(body.children, el => el.className);
      expect(sections).toEqual(['poi-card-header', 'poi-card-meta', 'extended-info-section',
        ...(biome ? ['poi-card-biome'] : []), 'poi-card-footer']);
      await vi.waitFor(() => expect(body.querySelector(pro ? '.extended-info-group' : '.extended-info-placeholder')).toBeTruthy());
      if (biome) expect(body.querySelector('.poi-card-biome')?.textContent).toBe('Biome: Magical temple');
      expect(body.lastElementChild?.textContent).toContain('(-4853, 4473)');
      closePOICard();
    }
  } finally { closePOICard(); }
});

it('puts the section gap on the shared card body so optional and hidden rows do not leave margins', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('public/css/poi-cards.css', 'utf8');
  document.head.append(style);
  try {
    const layer = style.sheet!.cssRules[0] as CSSGroupingRule;
    const body = Array.from(layer.cssRules).find(rule => (rule as CSSStyleRule).selectorText === '.poi-card-body') as CSSStyleRule;
    expect(body.style.getPropertyValue('display')).toBe('grid');
    expect(body.style.getPropertyValue('gap')).toBe('var(--section-gap)');
  } finally { style.remove(); }
});
