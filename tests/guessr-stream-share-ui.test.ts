// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/results/saved-game/?token=never-export"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamResultsView } from '../src/guessr/stream-results';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import i18next from '../src/i18n';
import type { StreamResult } from '../src/guessr/stream-types';

const mocks = vi.hoisted(() => ({ render: vi.fn(), download: vi.fn(), share: vi.fn(), count: 0 }));
vi.mock('../src/guessr/stream-share-image', async original => ({ ...await original<object>(), renderStreamShareImage: mocks.render }));
vi.mock('../src/image-export', () => ({ downloadBlob: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('../src/guessr/button-notice', () => ({ buttonNotice: () => ({ show() {}, dispose() {} }) }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private element: HTMLElement) {}
  async show() { this.element.setAttribute('open', ''); }
  dispose() { this.element.removeAttribute('open'); }
} }));
let view: ReturnType<typeof streamResultsView> | undefined;
function result(): StreamResult {
  return { schema: 1, id: 'saved-game', version: 'captured', createdAt: 1, finishedAt: Date.UTC(2026, 10, 11),
    host: { id: '123', login: 'streamer', name: 'StreamerName' },
    rounds: Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: 'Hidden', answer: { x: 1, y: 2 }, difficultyTier: 'normal' })),
    players: [
      { id: '123', login: 'streamer', name: 'StreamerName', rank: 2, score: 40000,
        rounds: Array.from({ length: 10 }, () => ({ score: 4000, areaScore: 1000, positionScore: 3000 })) },
      { id: '456', login: 'chatter', name: 'ChatterName', color: '#38BDF8', rank: 1, score: 45000,
        rounds: Array.from({ length: 10 }, () => ({ score: 4500, areaScore: 1000, positionScore: 3500 })) },
    ],
  };
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const png = () => new Blob(['test png'], { type: 'image/png' });
const choose = (id: string) => document.querySelector('.result-share-player [role="combobox"]')!
  .dispatchEvent(Object.assign(new Event('change.bs.combobox'), { value: id }));
async function open(viewerId?: string) {
  view = streamResultsView(result(), viewerId); document.body.append(view);
  button('Share result').click();
  await vi.waitFor(() => expect(button('Download PNG').disabled).toBe(false));
}
beforeEach(async () => {
  vi.clearAllMocks(); await initializeGuessrTranslations(); await i18next.changeLanguage('en');
  mocks.render.mockReset().mockResolvedValue(png());
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Export must reuse the loaded result'); }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:stream-${++mocks.count}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'share', { configurable: true, value: mocks.share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
});
afterEach(async () => { view?.destroy(); view = undefined; document.body.replaceChildren();
  await i18next.changeLanguage('en'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens a personal comparison on demand, then exports only the PNG without fetching results or profiles', async () => {
  view = streamResultsView(result(), '456'); document.body.append(view);
  expect(mocks.render).not.toHaveBeenCalled(); button('Share result').click();
  await vi.waitFor(() => expect(button('Download PNG').disabled).toBe(false));
  expect(mocks.render).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'chatter', headline: 'Beat StreamerName by 5,000 points', player: expect.objectContaining({ name: 'ChatterName' }), streamer: expect.objectContaining({ name: 'StreamerName' }) }));
  const picker = document.querySelector('.result-share-player [role="combobox"]')!;
  expect(picker.textContent).toBe('ChatterName');
  button('Download PNG').click();
  expect(mocks.download).toHaveBeenCalledWith(expect.any(File), 'noitaguessr-streamer-chatter-2026-11-11.png');
  button('Share image').click();
  expect(Object.keys(mocks.share.mock.calls[0][0]).sort()).toEqual(['files', 'title']);
  expect(JSON.stringify(mocks.share.mock.calls[0][0])).not.toMatch(/token|saved-game|http|Hidden/);
  expect(fetch).not.toHaveBeenCalled();
});
it('lets a signed-out result reader choose a chatter and switch back to the streamer summary locally', async () => {
  await open();
  expect(mocks.render.mock.lastCall![0]).toMatchObject({ kind: 'streamer', outscored: 'Chatters outscored: 0 / 1' });
  choose('456'); await vi.waitFor(() => expect(mocks.render.mock.lastCall![0].kind).toBe('chatter'));
  choose('123'); await vi.waitFor(() => expect(mocks.render.mock.lastCall![0].kind).toBe('streamer'));
  expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')?.textContent).not.toContain('Sign in');
});
it('ignores stale player renders, updates translations and closes the export when its result view is disposed', async () => {
  await open('456');
  let resolveOld!: (value: Blob) => void;
  mocks.render.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  choose('123'); await vi.waitFor(() => expect(mocks.render.mock.lastCall![0].kind).toBe('streamer'));
  choose('456'); await vi.waitFor(() => expect(button('Download PNG').disabled).toBe(false));
  const preview = document.querySelector<HTMLImageElement>('.result-share-preview img')!, url = preview.src;
  resolveOld(png()); await Promise.resolve(); expect(preview.src).toBe(url);
  await i18next.changeLanguage('ru');
  await vi.waitFor(() => expect(mocks.render.mock.lastCall![0].headline).toBe('Вы набрали больше очков, чем StreamerName (разница: 5\u00a0000 очков)'));
  const count = mocks.render.mock.calls.length;
  view!.destroy(); expect(document.querySelector('dialog')).toBeNull();
  await i18next.changeLanguage('en'); expect(mocks.render).toHaveBeenCalledTimes(count);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
});
