// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/daily/?a=daily-one&lng=en"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

const app = vi.hoisted(() => ({ request: vi.fn(), image: vi.fn(), source: vi.fn(), board: vi.fn(), pick: (_p: { x: number; y: number }) => {} }));
vi.mock('../src/guessr/image-game', () => ({ imageGameRequest: async () => ({ version: 'captured', bounds: { x: -2000, y: -2000, width: 4000, height: 4000 }, overview: '', map: { tiles: '/captured/' } }) }));
vi.mock('../src/guessr/api', () => ({ GameApi: class { request = app.request; image = app.image; }, gameApiOrigin: () => 'https://guessr-api.sage-data.xyz',
  gameAuth: async () => ({ getState: () => ({ isSubscriber: true }) }) }));
vi.mock('../src/guessr/stream-ui', () => ({ StreamUI: class { game = null; save() {} suspend() {} } }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {
  constructor(_node: unknown, bounds: unknown, _overview: unknown, pick: typeof app.pick, map: unknown) { app.pick = pick; app.board(bounds, map); }
  setMarkers() {} setLocked() {} destroy() {}
} }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {
  constructor(_node: unknown, source: unknown) { app.source(source); }
  async show(_camera: unknown, ready?: () => void) { ready?.(); return true; } destroy() {}
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('uses the daily tile set and shared exploration controls, then submits their score allowance', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  const clue = { frames: [{ image: 'https://a1b2c3d4.daily-test.pages.dev/images/' + 'a'.repeat(32) + '.webp', x: -1200, y: -600, width: 2400, height: 1200 }] };
  const config = { version: 'daily-version', bounds: { x: -1000, y: -1000, width: 2000, height: 2000 }, overview: '', map: { tiles: '/daily-reference/' } };
  const daily = { id: 'daily-one', challengeId: 'daily-test', day: '2026-10-25', title: 'Daily', totalRounds: 10, round: 0,
    status: 'active', config, clue, bounds: config.bounds, image: null, submitted: [], results: [] };
  app.request.mockImplementation(async (path: string, options?: { body: any }) => {
    if (path === '/api/attempts/daily-one') return daily;
    if (path.endsWith('/guess')) return { ...daily, round: 1, results: [{ ordinal: 0, answer: { x: 0, y: 0 }, name: 'Mines', biome: 'Mines',
      seed: 123, clue, difficultyTier: 'normal', guess: { x: 0, y: 0, score: options!.body.maximum, distance: 0 } }] };
    throw new Error('Unexpected daily request');
  });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Zoom out"]')).not.toBeNull());
  expect(app.board).toHaveBeenCalledWith(config.bounds, config.map);
  expect(app.source).toHaveBeenCalledWith(clue);
  const zoom = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!;
  await vi.waitFor(() => expect(zoom.disabled).toBe(false)); zoom.click();
  await vi.waitFor(() => expect(zoom.disabled).toBe(false));
  app.pick({ x: 0, y: 0 });
  document.querySelector<HTMLButtonElement>('#confirm-guess')!.click();
  await vi.waitFor(() => expect(app.request).toHaveBeenCalledWith('/api/attempts/daily-one/guess', expect.objectContaining({ body: expect.objectContaining({ maximum: 4600, guess: { x: 0, y: 0 } }) })));
  expect(app.image).not.toHaveBeenCalled();
});


it('restores a completed ten-round Daily from the API into a table with previews after F5', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  history.replaceState(null, '', '/guess/daily/?a=daily-saved&lng=en');
  const clue = { frames: [{ image: 'https://images.test/clue.webp', x: -1024, y: -512, width: 2048, height: 1024 }] };
  const state = { id: 'daily-saved', challengeId: 'daily-test', day: '2026-11-04', title: 'Daily', totalRounds: 10,
    round: 10, status: 'complete', score: 45000, bounds: { x: -1000, y: -1000, width: 2000, height: 2000 }, submitted: [],
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, answer: { x: 0, y: 0 }, name: 'Mines', biome: 'Mines', seed: 123, clue,
      difficultyTier: 'normal', guess: { x: 10, y: 10, score: 4500, distance: 14, area_score: 1000, position_score: 3500 } })) };
  app.request.mockImplementation(async (path: string) => { if (path === '/api/attempts/daily-saved') return state; throw new Error('Unexpected request'); });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.daily-results-table tbody tr')).toHaveLength(10));
  expect(document.querySelectorAll('.result-preview')).toHaveLength(10);
  expect(document.querySelectorAll('.board-row')).toHaveLength(0);
  expect(document.querySelector('.daily-results-table tfoot')!.textContent).toContain('45,000');
  expect(app.request).toHaveBeenCalledExactlyOnceWith('/api/attempts/daily-saved');
  expect(app.image).not.toHaveBeenCalled();
  expect(app.source).toHaveBeenCalledTimes(10);
  document.querySelector<HTMLButtonElement>('.result-preview-open')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Back to results'));
  expect(app.request).toHaveBeenCalledTimes(1);
});


it('shows completed Daily history in aligned columns instead of calling a finished run in progress', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  history.replaceState(null, '', '/guess/daily/?lng=en');
  app.request.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/daily?')) return { challenge: { id: 'daily-test', day: '2026-11-04', title: 'Daily', totalRounds: 10 }, attemptId: 'daily-saved' };
    if (path === '/api/history') return { attempts: [{ id: 'daily-saved', day: '2026-11-04', title: 'Daily', complete: true, score: 43210, revealAt: Date.now() + 86400000 }] };
    throw new Error('Unexpected request');
  });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('.daily-results-table tbody tr')).not.toBeNull());
  const row = document.querySelector('.daily-results-table tbody tr')!;
  expect(row.children[1].textContent).toBe('43,210');
  expect(row.children[1].classList.contains('numeric')).toBe(true);
  expect(row.querySelector('button')!.textContent).toBe('View results');
  expect(row.textContent).not.toContain('In progress');
  expect(app.request).toHaveBeenCalledTimes(2);
});
