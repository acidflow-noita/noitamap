// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import en from '../src/locales/en/translation.json';
import ru from '../src/locales/ru/translation.json';
import { getPOISpawnDetails } from '../src/telescope/poi-spawn-details';
import { EGG_SPAWNS } from '../src/telescope/egg-spawns';
import { SPAWNER_SPAWNS } from '../src/telescope/spawner-spawns';

const { translator, auth } = vi.hoisted(() => ({
  translator: { current: null as any },
  auth: { state: { authenticated: false, isSubscriber: false }, listeners: new Set<() => void>() },
}));
vi.mock('../src/i18n', () => ({ default: new Proxy({}, {
  get(_target, key) {
    const value = translator.current[key];
    return typeof value === 'function' ? value.bind(translator.current) : value;
  },
}) }));
vi.mock('../src/auth/auth-service', () => ({ authService: {
  getState: () => auth.state,
  subscribe: (listener: () => void) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); },
} }));
vi.mock('../src/auth/auth-ui', () => ({ AuthUI: { showGetProModal: vi.fn() } }));
let buildExtendedSection: typeof import('../src/extended-info').buildExtendedSection;
const setPro = (enabled: boolean) => {
  auth.state = { authenticated: enabled, isSubscriber: enabled };
  for (const listener of auth.listeners) listener();
};

beforeAll(async () => {
  translator.current = createInstance();
  await translator.current.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ru: { translation: ru } } });
  ({ buildExtendedSection } = await import('../src/extended-info'));
});
beforeEach(async () => {
  document.body.replaceChildren(); auth.listeners.clear(); setPro(false);
  await translator.current.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
});
afterEach(() => { document.body.replaceChildren(); auth.listeners.clear(); vi.unstubAllGlobals(); });

it('exposes outcome relationships, count and species without paid odds or conditions', () => {
  const pois = [
    ...Object.keys(EGG_SPAWNS).map(item => ({ type: 'item', item })),
    ...Object.keys(SPAWNER_SPAWNS).map(entity => ({ type: 'entity', entity })),
  ];
  for (const poi of pois) {
    const details = getPOISpawnDetails(poi)!;
    expect(details).toBeDefined();
    expect(details.notes).toEqual([]);
    expect(details.outcomes.every(outcome => outcome.length === 2)).toBe(true);
    const extended = getPOISpawnDetails(poi, true)!;
    for (const key of ['heading', 'selection', 'repeatable', 'separator', 'relationship'] as const)
      expect(details[key]).toEqual(extended[key]);
    expect(details).not.toHaveProperty('maxSpawns');
    expect(details).not.toHaveProperty('spawnCheck');
  }
  expect(getPOISpawnDetails({ type: 'item', item: 'egg_worm' })).toMatchObject({
    heading: en.poi.hatchesOneOf, separator: en.poi.spawnOr,
  });
  expect(getPOISpawnDetails({ type: 'entity', entity: 'firebugnest' })).toMatchObject({
    heading: en.poi.oneOptionPerSpawn, relationship: en.poi.spawnOptionsOverTime,
  });
});

it('shows the existing Pro gate, with no spawn odds/notes or extended fetches for free users', () => {
  const egg = buildExtendedSection('spawner', 'egg_worm');
  const nest = buildExtendedSection('creature', 'spidernest');
  document.body.append(egg, nest);
  for (const section of [egg, nest]) {
    expect(section.querySelector('.extended-info-cta')?.textContent).toBe(en.extended.cta);
    expect(section.querySelector('.extended-info-spawner')).toBeNull();
  }
  for (const privateText of ['343/512', '101', '200', '15', 'hatches'])
    expect(document.body.textContent).not.toContain(privateText);
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the card cleanup when its Pro button dismisses it', () => {
  const card = document.createElement('div');
  card.className = 'marker-tooltip';
  const close = vi.fn(() => card.remove());
  (card as HTMLElement & { __close?: () => void }).__close = close;
  card.appendChild(buildExtendedSection('spawner', 'egg_worm'));
  document.body.appendChild(card);
  card.querySelector<HTMLButtonElement>('.extended-info-cta')!.click();
  expect(close).toHaveBeenCalledOnce();
  expect(card.isConnected).toBe(false);
});

it('cannot reveal delayed spawner information after logout', async () => {
  let resolve!: (response: any) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
  setPro(true);
  const nest = buildExtendedSection('creature', 'spidernest');
  document.body.appendChild(nest);
  setPro(false);
  resolve({ ok: true, json: async () => [] });
  await new Promise(done => setTimeout(done, 0));
  expect(nest.querySelector('.extended-info-cta')).not.toBeNull();
  expect(nest.querySelector('.extended-info-spawner')).toBeNull();
  expect(nest.textContent).not.toContain('75/101');
});

it('unlocks exact egg probabilities and hides them again when the subscription is removed', () => {
  const egg = buildExtendedSection('spawner', 'egg_worm');
  document.body.appendChild(egg);
  setPro(true);
  expect(egg.querySelector('.extended-info-cta')).toBeNull();
  expect(egg.textContent).toContain('343/512 (66.9921875%)');
  expect(egg.textContent).toContain('147/512 (28.7109375%)');
  expect(egg.textContent).toContain('11/256 (4.296875%)');
  expect(egg.textContent).toContain(en.poi.eggHatch);
  auth.state = { authenticated: true, isSubscriber: false };
  for (const listener of auth.listeners) listener();
  expect(egg.querySelector('.extended-info-cta')).not.toBeNull();
  expect(egg.textContent).not.toContain('343/512');
  expect(egg.textContent).not.toContain(en.poi.eggHatch);
});

it('shows localized timing, range and lifetime limits only in the paid nest section', async () => {
  setPro(true);
  const nest = buildExtendedSection('creature', 'spidernest');
  document.body.appendChild(nest);
  await vi.waitFor(() => expect(nest.querySelector('.extended-info-spawner')).not.toBeNull());
  expect(nest.textContent).toContain('Checks every 101 game frames.');
  await translator.current.changeLanguage('ru');
  await vi.waitFor(() => expect(nest.textContent).toContain('Проверка каждые 101 игровых кадров.'));
  expect(nest.textContent).not.toContain('Checks every');
  expect(nest.textContent).toContain('75/101');
  expect(nest.textContent).toContain('200');
  expect(nest.textContent).toContain('15');
  setPro(false);
  expect(nest.textContent).not.toContain('75/101');
  expect(nest.querySelector('.extended-info-cta')).not.toBeNull();
});
