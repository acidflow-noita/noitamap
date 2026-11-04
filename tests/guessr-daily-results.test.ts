// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dailyResultsTable } from '../src/guessr/daily-results';
import type { RankedState } from '../src/guessr/api';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import i18next from '../src/i18n';

const previews = vi.hoisted(() => ({ sources: [] as unknown[], show: vi.fn(async () => true), destroy: vi.fn() }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {
  constructor(mount: HTMLElement, source: unknown) { previews.sources.push(source); mount.append(document.createElement('canvas')); }
  show = previews.show; destroy = previews.destroy;
} }));
beforeEach(async () => {
  previews.sources = []; previews.show.mockClear(); previews.destroy.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Results must not call the API'); }));
  await initializeGuessrTranslations();
});
afterEach(async () => { document.body.replaceChildren(); await i18next.changeLanguage('en'); vi.unstubAllGlobals(); });
function result(): RankedState {
  return { id: 'saved-daily', challengeId: 'daily-2026-11-04', day: '2026-11-04', title: 'Daily', totalRounds: 10,
    round: 10, status: 'complete', revealed: true, revealAt: 0, closesAt: 0, serverNow: 0,
    bounds: { x: 0, y: 0, width: 2048, height: 2048 }, deadline: null, image: null, submitted: [0,1,2,3,4,5,6,7,8,9], score: 40404,
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, name: ordinal === 1 ? 'Coal Pits' : 'Mines', biome: 'Mines',
      answer: { x: 100, y: 100 }, seed: 123, image: '/must-not-fetch',
      clue: { frames: [{ image: `https://images.test/${ordinal}.webp`, x: -256, y: -256, width: 512, height: 512 }] },
      guess: { x: 101, y: 102, score: ordinal === 0 ? 0 : ordinal === 1 ? 404 : 5000,
        area_score: ordinal < 2 ? 0 : 1000, position_score: ordinal === 0 ? 0 : ordinal === 1 ? 404 : 4000,
        distance: ordinal === 0 ? null : ordinal === 1 ? 5120 : 2, elapsed_ms: 0 },
    })) };
}
it('renders every round and totals as aligned numeric columns, keeping distance as text', () => {
  const state = result(), view = dailyResultsTable(state, vi.fn()); document.body.append(view.element);
  const table = view.element.querySelector('table')!;
  expect(table.classList.contains('table')).toBe(true);
  expect([...table.tHead!.rows[0].cells].map(cell => cell.textContent)).toEqual(['Round', 'Location', 'Distance', 'Area', 'Proximity', 'Points', 'Review']);
  const rows = [...table.tBodies[0].rows]; expect(rows).toHaveLength(10);
  for (const row of rows) {
    for (const column of [0, 3, 4, 5]) expect(row.cells[column].classList.contains('numeric')).toBe(true);
    expect(row.cells[2].classList.contains('numeric')).toBe(false);
  }
  expect(rows[0].cells[2].textContent).toBe('Skipped');
  expect(rows[1].cells[2].textContent).toBe('10 chunks away');
  expect(rows[1].cells[5].textContent).toBe('404'); expect(rows[2].cells[5].textContent).toBe('5,000');
  expect([...table.tFoot!.rows[0].cells].map(cell => cell.textContent)).toEqual(['Total', '8,000', '32,404', '40,404', '']);
  expect(fetch).not.toHaveBeenCalled(); view.destroy();
});
it('previews each original starting crop, reviews the correct round and disposes every preview', () => {
  const state = result(), review = vi.fn(), view = dailyResultsTable(state, review); document.body.append(view.element);
  expect(previews.sources).toEqual(state.results!.map(round => round.clue));
  expect(previews.show).toHaveBeenCalledTimes(10);
  for (const call of previews.show.mock.calls) expect(call).toEqual([{ dx: 0, dy: 0, level: 0 }]);
  const row = view.element.querySelectorAll('tbody tr')[7];
  (row.querySelector('.result-preview-open') as HTMLButtonElement).click();
  expect(review).toHaveBeenLastCalledWith(7);
  (row.querySelector('.result-action button') as HTMLButtonElement).click();
  expect(review).toHaveBeenLastCalledWith(7);
  view.destroy(); expect(previews.destroy).toHaveBeenCalledTimes(10);
});
it('updates translated table text and number formatting without reloading its images', async () => {
  const view = dailyResultsTable(result(), vi.fn()); document.body.append(view.element);
  const firstPreview = view.element.querySelector('.result-preview'), loads = previews.show.mock.calls.length;
  await i18next.changeLanguage('de');
  expect(view.element.querySelector('thead')!.textContent).toContain('Punkte');
  expect(view.element.querySelectorAll('tbody tr')[2].children[5].textContent).toBe('5.000');
  expect(view.element.querySelector('.result-preview')).toBe(firstPreview);
  expect(previews.show).toHaveBeenCalledTimes(loads); view.destroy();
});
