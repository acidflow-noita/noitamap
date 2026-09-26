import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import i18next from '../src/i18n';

vi.mock('../src/i18n', async () => ({ default: (await import('i18next')).createInstance() }));
vi.mock('../src/data_sources/overlays', () => ({
  getAllOverlays: () => [
    ['items', [
      { overlayType: 'poi', name: 'Test Potion', aliases: ['Test Flask'], maps: ['regular-main-branch'], x: 1, y: 2 },
      { overlayType: 'poi', name: 'Test Alternate', maps: ['nightmare-main-branch'], x: 3, y: 4 },
    ]],
    ['bosses', [{ overlayType: 'poi', name: 'Test Boss', maps: ['regular-main-branch'], x: 5, y: 6 }]],
    ['biomeBoundaries', [{ overlayType: 'path', text: 'Test Path', maps: ['regular-main-branch'] }]],
  ],
}));
import { searchOverlays } from '../src/search/static-index';

beforeAll(async () => {
  await i18next.init({
    lng: 'en', fallbackLng: 'en',
    resources: {
      en: { translation: {} },
      fr: { translation: { gameContent: { items: { 'Test Potion': 'Translated Potion' } } } },
    },
  });
});
afterEach(async () => { await i18next.changeLanguage('en'); });

describe('static map search with the installed FlexSearch package', () => {
  it('limits matches to the selected map and deduplicates matching name and alias fields', () => {
    expect(searchOverlays('regular-main-branch', 'Test', new Set()).map(p => (p as any).name).sort())
      .toEqual(['Test Boss', 'Test Potion']);
    expect(searchOverlays('nightmare-main-branch', 'Test', new Set()).map(p => (p as any).name))
      .toEqual(['Test Alternate']);
  });

  it('applies category filters and searches aliases', () => {
    expect(searchOverlays('regular-main-branch', 'Test', new Set(['b'])).map(p => (p as any).name))
      .toEqual(['Test Boss']);
    expect(searchOverlays('regular-main-branch', 'Flask', new Set(['i'])).map(p => (p as any).name))
      .toEqual(['Test Potion']);
  });

  it('refreshes display translations without rebuilding the index', async () => {
    const query = () => searchOverlays('regular-main-branch', 'Potion', new Set()) as any[];
    expect(query()[0].displayName).toBe('Test Potion');
    await i18next.changeLanguage('fr');
    expect(query()[0]).toMatchObject({ name: 'Test Potion', displayName: 'Translated Potion' });
  });
});
