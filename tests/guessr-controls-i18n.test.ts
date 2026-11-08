// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://noitamap.test/guess/?lng=en"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18next from '../src/i18n';
import { attachClueControls } from '../src/guessr/clue-view';
import { ClueViewport } from '../src/guessr/clue-viewport';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import { maximumScore, newClueProgress, type ClueProgress } from '../src/guessr/rules';
import { difficultyIndicator, maximumIndicator, updateRoundIndicators } from '../src/guessr/round-status';

let dispose: (() => void) | undefined;
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected network request'); }));
  await initializeGuessrTranslations();
  await i18next.changeLanguage('en');
  i18next.addResourceBundle('de', 'translation', {}, true, true);
  i18next.addResourceBundle('de', 'guessr', {
    'Zoom out': 'Verkleinern',
    'Zoom in': 'Vergrößern',
    'Free action': 'Kostenlose Aktion',
    'Free': 'Kostenlos',
    'Normal difficulty': 'Normale Schwierigkeit',
    'Up to {{points}} points_one': 'Bis zu {{points}} Punkt',
    'Up to {{points}} points_other': 'Bis zu {{points}} Punkte',
    '{{points}} points_one': '{{points}} Punkt',
    '{{points}} points_other': '{{points}} Punkte',
    'Zoom in to move': 'Zum Bewegen vergrößern',
    'Travel east': 'Nach Osten bewegen',
    'Costs {{points}} points_one': 'Kostet {{points}} Punkt',
    'Costs {{points}} points_other': 'Kostet {{points}} Punkte',
    'Costs {{points}} points if the image loads_one': 'Kostet {{points}} Punkt, wenn das Bild geladen wird',
    'Costs {{points}} points if the image loads_other': 'Kostet {{points}} Punkte, wenn das Bild geladen wird',
    'Retry image': 'Bild erneut laden',
    'Image could not load. No points were charged.': 'Bild nicht geladen. Keine Punkte abgezogen.',
    'The location to identify': 'Gesuchter Ort',
    'Loading clue map…': 'Karte wird geladen…',
    'Paused': 'Pausiert',
    'Zoom and return to start': 'Zoom und Rückkehr zum Start',
    '{{distance}} px east': '{{distance}} px nach Osten',
    '{{position}} from start. Your original starting spot stays the answer.': '{{position}} vom Start. Der Start bleibt die Lösung.',
  }, true, true);
  vi.spyOn(ClueViewport.prototype, 'show').mockImplementation(async (_camera, ready) => {
    await Promise.resolve(); ready?.(); return true;
  });
});
afterEach(async () => {
  dispose?.(); dispose = undefined;
  document.body.replaceChildren();
  await i18next.changeLanguage('en');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function fixture(progress: ClueProgress = newClueProgress()) {
  const root = document.createElement('div'); root.className = 'game-grid'; document.body.append(root);
  const clue = document.createElement('div'); root.append(difficultyIndicator(), maximumIndicator(), clue);
  const changed = vi.fn();
  dispose = attachClueControls(clue, { frames: [{ image: '/fixture.webp', x: -864, y: -384, width: 1728, height: 768 }] }, progress, 256, changed, { difficultyTier: 'normal' });
  await flush();
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  return { clue, changed, progress, button };
}

it('changes live labels and formatted costs without replacing icons, moving the camera, or charging points', async () => {
  const f = await fixture({ ...newClueProgress(), level: 5, widest: 5 });
  const out = f.button('Zoom out'), inside = f.button('Zoom in'), east = f.button('Travel east');
  const svg = out.querySelector('svg'), canvas = f.clue.querySelector('canvas');
  const previous = structuredClone(f.progress);
  out.focus();
  await i18next.changeLanguage('de');
  expect(f.progress).toEqual(previous);
  expect(ClueViewport.prototype.show).toHaveBeenCalledTimes(1);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(f.clue.querySelector('canvas')).toBe(canvas);
  expect(out.querySelector('svg')).toBe(svg);
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect(document.activeElement).toBe(out);
  expect(out.getAttribute('aria-label')).toBe('Verkleinern');
  expect(document.querySelector('[data-clue-difficulty]')?.textContent).toBe('Normal');
  expect(document.querySelector('[data-clue-difficulty]')?.getAttribute('aria-label')).toBe('Normale Schwierigkeit');
  expect(document.querySelector('[data-clue-maximum]')?.textContent).toBe('Bis zu 2.000 Punkte');
  expect(out.getAttribute('aria-description')).toBe('Verkleinern — Kostet 1.000 Punkte');
  expect(out.querySelector('.clue-control-cost')?.textContent).toBe('-1.000');
  expect(document.querySelector('[data-bs-toggle="popover"], .popover')).toBeNull();
  expect(canvas?.getAttribute('aria-label')).toBe('Gesuchter Ort');
  expect(f.clue.dataset.loadingLabel).toBe('Karte wird geladen…');
  expect(f.clue.dataset.pausedLabel).toBe('Pausiert');
  expect(document.querySelector('.camera-zoom')?.getAttribute('aria-label')).toBe('Zoom und Rückkehr zum Start');
  out.click(); await flush();
  expect(maximumScore(f.progress)).toBe(1000);
  expect(inside.getAttribute('aria-description')).toBe('Vergrößern — Kostenlose Aktion');
  expect(inside.querySelector('.clue-control-cost')?.textContent).toBe('Kostenlos');
  expect(east.disabled).toBe(true);
  expect(east.getAttribute('aria-description')).toBe('Nach Osten bewegen — Zum Bewegen vergrößern');
  expect(east.querySelector('.clue-control-cost')?.textContent).toBe('—');
  inside.click(); await flush();
  expect(maximumScore(f.progress)).toBe(1000);
});

it('keeps return and backtracking free and translates the position without changing its coordinates', async () => {
  const f = await fixture();
  const east = f.button('Travel east'), west = f.button('Travel west'), start = f.button('Return to start');
  east.click(); await flush();
  expect(f.progress.dx).toBe(24);
  expect(maximumScore(f.progress)).toBe(4900);
  expect(start.getAttribute('aria-description')).toBe('Return to start — Free action');
  expect(start.querySelector('.clue-control-cost')?.textContent).toBe('Free');
  expect(west.getAttribute('aria-description')).toBe('Travel west — Free action');
  expect(west.querySelector('.clue-control-cost')?.textContent).toBe('Free');
  await i18next.changeLanguage('de');
  expect(document.querySelector('.fine-print')!.textContent).toBe('24 px nach Osten vom Start. Der Start bleibt die Lösung.');
  expect(f.progress.dx).toBe(24);
  west.click(); await flush();
  expect(f.progress.dx).toBe(0);
  expect(maximumScore(f.progress)).toBe(4900);
  expect(east.getAttribute('aria-description')).toBe('Nach Osten bewegen — Kostenlose Aktion');
  expect(east.querySelector('.clue-control-cost')?.textContent).toBe('Kostenlos');
});

it('shows the remaining maximum before a guess and updates it only after successful exploration', async () => {
  const f = await fixture(), budget = document.querySelector('[data-clue-maximum]')!;
  expect(document.querySelector('[data-clue-difficulty]')?.textContent).toBe('Normal');
  expect(budget.textContent).toBe('Up to 5,000 points');
  const text = budget.firstChild;
  updateRoundIndicators(document, f.progress, 'normal');
  expect(budget.firstChild).toBe(text);
  f.button('Travel east').click(); await flush(); expect(budget.textContent).toBe('Up to 4,900 points');
  f.button('Travel west').click(); await flush(); expect(budget.textContent).toBe('Up to 4,900 points');
  f.button('Zoom out').click(); await flush(); expect(budget.textContent).toBe('Up to 4,500 points');
  vi.mocked(ClueViewport.prototype.show).mockRejectedValueOnce(Error('Image failure'));
  f.button('Zoom out').click(); await flush(); expect(budget.textContent).toBe('Up to 4,500 points');
  expect(document.querySelector('.clue-control')?.classList.contains('theme-primary')).toBe(false);
  expect(document.querySelector('.clue-control')?.classList.contains('theme-secondary')).toBe(true);
});

it('uses singular remaining point costs and keeps the retry action alive when the error language changes', async () => {
  const f = await fixture({ ...newClueProgress(), widest: 6, travelSpent: 999 });
  const east = f.button('Travel east');
  await i18next.changeLanguage('de');
  expect(east.getAttribute('aria-description')).toBe('Nach Osten bewegen — Kostet 1 Punkt');
  expect(east.querySelector('.clue-control-cost')?.textContent).toBe('-1');
  vi.mocked(ClueViewport.prototype.show).mockRejectedValueOnce(Error('Image failure'));
  east.click(); await flush();
  expect(f.progress.dx).toBe(0);
  expect(maximumScore(f.progress)).toBe(1);
  const error = document.querySelector('.error')!, retry = error.querySelector<HTMLButtonElement>('button')!;
  expect(error.textContent).toContain('Keine Punkte abgezogen.');
  expect(retry.getAttribute('aria-description')).toBe('Bild erneut laden — Kostet 1 Punkt, wenn das Bild geladen wird');
  await i18next.changeLanguage('en');
  expect(error.querySelector('button')).toBe(retry);
  expect(error.textContent).toContain('Image could not load. No points were charged.');
  expect(retry.firstElementChild?.textContent).toBe('Retry image');
  expect(retry.querySelector('.clue-control-cost')?.textContent).toBe('-1');
  retry.click(); await flush();
  expect(f.progress.dx).toBe(24);
  expect(maximumScore(f.progress)).toBe(0);
  expect(error.children).toHaveLength(0);
});

it('updates visible costs through zoom levels, return trips, and the edge of the available map', async () => {
  const f = await fixture(), out = f.button('Zoom out'), inside = f.button('Zoom in');
  const cost = (button: HTMLButtonElement) => button.querySelector('.clue-control-cost')!.textContent;
  for (const expected of [400, 500, 600, 700, 800, 1000]) {
    expect(cost(out)).toBe(`-${expected.toLocaleString('en-US')}`);
    const before = maximumScore(f.progress);
    out.click(); await flush();
    expect(before - maximumScore(f.progress)).toBe(expected);
    expect(cost(inside)).toBe('Free');
  }
  expect(out.disabled).toBe(true); expect(cost(out)).toBe('—');
  for (let i = 0; i < 6; i++) { inside.click(); await flush(); }
  expect(cost(out)).toBe('Free');
  const east = f.button('Travel east'), start = f.button('Return to start');
  let steps = 0;
  while (!east.disabled && steps++ < 50) { east.click(); await flush(); }
  expect(east.disabled).toBe(true); expect(cost(east)).toBe('—');
  expect(cost(start)).toBe('Free');
  start.click(); await flush();
  expect(f.progress.dx).toBe(0); expect(cost(start)).toBe('—');
  expect(cost(east)).toBe('Free');
});
