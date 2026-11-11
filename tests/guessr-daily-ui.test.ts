// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/daily/?a=daily-one&lng=en"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  app.publicResult.mockRejectedValue(new app.ApiError(409, 'The player has not finished this game yet.'));
  app.auth.mockResolvedValue({ getState: () => ({ isSubscriber: true }) });
  history.replaceState(null, '', '/guess/daily/?a=daily-one&lng=en');
});

const app = vi.hoisted(() => ({ request: vi.fn(), publicResult: vi.fn(), auth: vi.fn(), marks: vi.fn(), ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } }, image: vi.fn(), source: vi.fn(), board: vi.fn(), pick: (_p: { x: number; y: number }) => {} }));
vi.mock('../src/guessr/image-game', () => ({ imageGameRequest: async () => ({ version: 'captured', bounds: { x: -2000, y: -2000, width: 4000, height: 4000 }, overview: '', map: { tiles: '/captured/' } }) }));
vi.mock('../src/guessr/api', () => ({ ApiError: app.ApiError, GameApi: class { request = app.request; publicResult = app.publicResult; image = app.image; }, gameApiOrigin: () => 'https://guessr-api.sage-data.xyz',
  gameAuth: app.auth }));
vi.mock('../src/guessr/stream-ui', () => ({ StreamUI: class { game = null; save() {} suspend() {} } }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {
  constructor(_node: unknown, bounds: unknown, _overview: unknown, pick: typeof app.pick, map: unknown) { app.pick = pick; app.board(bounds, map); }
  setMarkers = app.marks; setLocked() {} destroy() {}
} }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {
  constructor(_node: unknown, source: unknown) { app.source(source); }
  async show(_camera: unknown, ready?: () => void) { ready?.(); return true; } destroy() {}
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows already played and only result review for a completed Daily even without a history row', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  history.replaceState(null, '', '/guess/daily/?lng=en');
  const today = new Date().toISOString().slice(0, 10);
  app.request.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/daily?')) return { challenge: { id: 'daily-today', day: today, title: 'Daily', totalRounds: 10 },
      attemptId: 'completed-today', attemptStatus: 'complete' };
    if (path === '/api/history') return { attempts: [] };
    throw Error('A completed Daily must not start another attempt');
  });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('.daily-already-played')?.textContent).toBe('You’ve already played today’s Daily.'));
  expect(document.querySelector('.daily-start button')?.textContent).toBe('View results');
  expect(document.querySelector('.daily-start')?.textContent).not.toContain('Start daily');
  expect(app.request).toHaveBeenCalledTimes(2);
});

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
  expect(document.querySelector('.daily-share-open')).toBeNull();
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


it('opens shared scores without auth or previews after F5 and reveals answers only on explicit click', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  history.replaceState(null, '', '/guess/daily/?a=daily-saved&lng=en');
  const clue = { frames: [{ image: 'https://images.test/clue.webp', x: -1024, y: -512, width: 2048, height: 1024 }] };
  const state = { id: 'daily-saved', challengeId: 'daily-test', day: '2026-11-04', title: 'Daily', totalRounds: 10,
    round: 10, status: 'complete', score: 45000, bounds: { x: -1000, y: -1000, width: 2000, height: 2000 }, submitted: [],
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, answer: { x: 0, y: 0 }, name: 'Mines', biome: 'Mines', seed: 123, clue,
      difficultyTier: 'normal', guess: { x: 10, y: 10, score: 4500, distance: 14, area_score: 1000, position_score: 3500 } })) };
  app.request.mockRejectedValue(new Error('Public results must not request a ticket'));
  app.auth.mockRejectedValue(new Error('Public results must not check membership'));
  const summary = { ...state, results: state.results.map(r => ({ ordinal: r.ordinal, guess: { score: r.guess.score, area_score: r.guess.area_score, position_score: r.guess.position_score } })) };
  app.publicResult.mockImplementation(async (_id: string, answers = false) => answers ? state : summary);
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.daily-results-table tbody tr')).toHaveLength(10));
  expect(document.querySelectorAll('.result-preview')).toHaveLength(0);
  expect(app.source).not.toHaveBeenCalled();
  expect(app.auth).not.toHaveBeenCalled();
  expect(app.request).not.toHaveBeenCalled();
  expect(app.publicResult).toHaveBeenCalledExactlyOnceWith('daily-saved');
  const reveal = document.querySelector<HTMLButtonElement>('.daily-view-answers')!;
  expect(reveal.getAttribute('aria-description')).toContain('in this browser');
  expect(reveal.hasAttribute('title')).toBe(false);
  const { default: i18next } = await import('../src/i18n');
  await i18next.changeLanguage('ru');
  expect(reveal.textContent).toBe('Посмотреть ответы');
  expect(reveal.getAttribute('aria-description')).toContain('в этом браузере');
  expect(app.publicResult).toHaveBeenCalledTimes(1);
  expect(app.source).not.toHaveBeenCalled();
  await i18next.changeLanguage('en');
  reveal.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.result-preview')).toHaveLength(10));
  expect(document.querySelectorAll('.board-row')).toHaveLength(0);
  expect(document.querySelector('.daily-results-table tfoot')!.textContent).toContain('45,000');
  expect(document.querySelector('.daily-share-open')?.textContent).toBe('Share result');
  expect(app.request).not.toHaveBeenCalled();
  expect(app.auth).not.toHaveBeenCalled();
  expect(app.publicResult).toHaveBeenLastCalledWith('daily-saved', true);
  expect(app.image).not.toHaveBeenCalled();
  expect(app.source).toHaveBeenCalledTimes(10);
  document.querySelector<HTMLButtonElement>('.result-preview-open')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Back to results'));
  expect(app.publicResult).toHaveBeenCalledTimes(2);
  expect(app.marks).toHaveBeenLastCalledWith({ x: 10, y: 10 }, { x: 0, y: 0 }, 'Player’s map marker');
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

function storedBrowser() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  document.body.innerHTML = '<div id="guess-app"></div>';
  return values;
}
function publicScore() {
  return { id: 'shared-result', day: '2026-11-11', status: 'complete', totalRounds: 10, score: 0,
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, guess: null })) };
}

it('keeps play available for score-only viewing, then persists the restriction and removes only the matching resume bookmark', async () => {
  const values = storedBrowser(), summary = publicScore();
  const bookmark = 'noitamap-guessr-daily-resume-v1', flag = 'noitamap-guessr-answers-v1-' + summary.day;
  values.set(bookmark, JSON.stringify({ id: 'my-attempt', day: summary.day, round: 3, totalRounds: 10, completedRounds: 3 }));
  history.replaceState(null, '', '/guess/daily/?a=shared-result&lng=en');
  app.publicResult.mockImplementation(async (_id: string, answers = false) => answers
    ? { ...summary, round: 10, submitted: [], bounds: { x: 0, y: 0, width: 2000, height: 2000 }, results: [] } : summary);
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('.daily-view-answers')).not.toBeNull());
  expect(new URL(location.href).searchParams.get('a')).toBe(summary.id);
  expect(values.has(flag)).toBe(false);
  expect(values.has(bookmark)).toBe(true);
  document.querySelector<HTMLButtonElement>('.daily-view-answers')!.click();
  await vi.waitFor(() => expect(values.get(flag)).toBe('1'));
  expect(values.has(bookmark)).toBe(false);
  expect(app.auth).not.toHaveBeenCalled();
  expect(app.request).not.toHaveBeenCalled();

  // A fresh page load must block both starting and continuing this date.
  vi.resetModules();
  document.body.innerHTML = '<div id="guess-app"></div>';
  history.replaceState(null, '', '/guess/daily/?lng=en');
  app.request.mockImplementation(async (path: string) => path === '/api/history' ? { attempts: [] }
    : { challenge: { id: 'daily-test', day: summary.day, title: 'Daily', totalRounds: 10 }, attemptId: 'my-attempt', attemptStatus: 'active' });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('.daily-already-played')?.textContent).toContain('in this browser'));
  const start = document.querySelector<HTMLButtonElement>('.daily-start button')!;
  expect(start.disabled).toBe(true);
  start.click();
  expect(app.request.mock.calls.some(([path]) => path === '/api/attempts/my-attempt' || path === '/api/attempts')).toBe(false);
});

it('does not restrict play when answers fail to load and keeps the button available for retry', async () => {
  const values = storedBrowser(), summary = publicScore();
  app.publicResult.mockImplementation(async (_id: string, answers = false) => {
    if (answers) throw new Error('Network unavailable');
    return summary;
  });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('.daily-view-answers')).not.toBeNull());
  const reveal = document.querySelector<HTMLButtonElement>('.daily-view-answers')!;
  reveal.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Answers are temporarily unavailable.'));
  expect(reveal.disabled).toBe(false);
  expect(values.has('noitamap-guessr-answers-v1-' + summary.day)).toBe(false);
  expect(app.source).not.toHaveBeenCalled();
  expect(app.auth).not.toHaveBeenCalled();
});

it('shows a missing public result without asking for Pro or login', async () => {
  storedBrowser();
  app.publicResult.mockRejectedValue(new app.ApiError(404, 'No results were found for this link.'));
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.body.textContent).toContain('No results were found for this link.'));
  expect(app.auth).not.toHaveBeenCalled();
  expect(app.request).not.toHaveBeenCalled();
});

it('keeps owner resume working while the older Worker is still deployed', async () => {
  storedBrowser();
  app.publicResult.mockRejectedValue(new app.ApiError(401, 'Sign in to continue.'));
  app.request.mockResolvedValue({ id: 'daily-one', day: '2026-11-11', status: 'active', totalRounds: 10, round: 0,
    submitted: [], results: [], bounds: { x: -1000, y: -1000, width: 2000, height: 2000 } });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('#confirm-guess')).not.toBeNull());
  expect(app.request).toHaveBeenCalledExactlyOnceWith('/api/attempts/daily-one');
});

it('blocks direct active-attempt refresh after viewing answers', async () => {
  const values = storedBrowser();
  values.set('noitamap-guessr-answers-v1-2026-11-11', '1');
  app.request.mockResolvedValue({ id: 'daily-one', day: '2026-11-11', status: 'active', totalRounds: 10, round: 2, submitted: [0, 1] });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.body.textContent).toContain('You viewed the answers.'));
  expect(document.querySelector('#confirm-guess')).toBeNull();
  expect(app.source).not.toHaveBeenCalled();
});

it('refuses a submission if the answers were viewed in another tab after this round opened', async () => {
  const values = storedBrowser();
  app.request.mockResolvedValue({ id: 'daily-one', day: '2026-11-11', status: 'active', totalRounds: 10, round: 0,
    submitted: [], results: [], bounds: { x: -1000, y: -1000, width: 2000, height: 2000 } });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(document.querySelector('#confirm-guess')).not.toBeNull());
  app.pick({ x: 0, y: 0 });
  values.set('noitamap-guessr-answers-v1-2026-11-11', '1');
  document.querySelector<HTMLButtonElement>('#confirm-guess')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('You viewed the answers.'));
  expect(app.request.mock.calls.some(([path]) => path.endsWith('/guess'))).toBe(false);
});
