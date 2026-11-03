// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACTIVE_MODE_KEY, DAILY_RESUME_KEY } from '../src/guessr/resume-progress';
import { HISTORY_KEY } from '../src/guessr/practice';

const app = vi.hoisted(() => ({ image: vi.fn(), api: vi.fn(), auth: vi.fn(), confirm: vi.fn(), origin: 'http://localhost:8787' as string | null }));
vi.mock('../src/guessr/image-game', () => ({ imageGameRequest: app.image }));
vi.mock('../src/guessr/quit-game', () => ({ confirmQuitGame: app.confirm }));
vi.mock('../src/guessr/api', () => ({ GameApi: class { request = app.api; }, gameApiOrigin: () => app.origin, gameAuth: app.auth }));
vi.mock('../src/guessr/stream-ui', () => ({ StreamUI: class { game = null; save() {} suspend() {} } }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {} }));
vi.mock('../src/guessr/clue-view', () => ({ attachClueControls: vi.fn() }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {} }));
const imageKey = 'noitamap-guessr-images-v1';
const demoId = '12345678-1234-1234-1234-123456789abc';
let saved: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); history.replaceState(null, '', '/guess/');
  app.origin = 'http://localhost:8787';
  document.body.innerHTML = '<div id="guess-app"></div>';
  saved = new Map([[imageKey, JSON.stringify({ version: 'test-map', id: demoId })], [HISTORY_KEY, '[]']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  app.image.mockImplementation(async path => {
    if (path === '/config') return { version: 'test-map', bounds: { x: 0, y: 0, width: 100, height: 100 }, overview: '', map: {} };
    if (path === `/sessions/${demoId}`) return { id: demoId, version: 'test-map', round: 0, totalRounds: 3, stage: 'guess', results: [], current: { id: 'round-1' } };
    throw Error('Unexpected game request');
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const button = (name: string) => [...document.querySelectorAll('button')].find(element => element.textContent === name)!;

it('explains the unconfigured daily and returns home without querying Pro authentication', async () => {
  app.origin = null;
  await import('../src/guessr/main');
  button('Today').click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(document.querySelector('main')!.textContent).toContain('Daily is not configured in this local preview.');
  expect(app.auth).not.toHaveBeenCalled();
  expect(app.api).not.toHaveBeenCalled();
  button('Back').click();
  expect(document.querySelector('.guessr-lobby')).not.toBeNull();
  expect(button('Continue demo')).toBeDefined();
});

it('quits the demo only after confirmation and keeps completed history', async () => {
  await import('../src/guessr/main');
  expect(button('Continue demo')).toBeDefined();
  button('Exit game').click();
  expect(saved.has(imageKey)).toBe(true);
  expect(document.querySelector('.lobby-resume')).not.toBeNull();
  await app.confirm.mock.calls[0][0]();
  expect(saved.has(imageKey)).toBe(false);
  expect(saved.get(HISTORY_KEY)).toBe('[]');
  expect(document.querySelector('.lobby-resume')).toBeNull();
  vi.resetModules(); await import('../src/guessr/main');
  expect(document.querySelector('.lobby-resume')).toBeNull();
});

it('resumes the most recently played daily and forfeits it without deleting an older demo', async () => {
  saved.set(ACTIVE_MODE_KEY, 'daily');
  saved.set(DAILY_RESUME_KEY, JSON.stringify({ id: 'daily-1', day: '2026-10-22', round: 2, totalRounds: 5, completedRounds: 2 }));
  app.api.mockResolvedValue({ status: 'complete' });
  await import('../src/guessr/main');
  expect(button('Continue daily')).toBeDefined();
  expect(button('Continue demo')).toBeUndefined();
  expect(app.api).not.toHaveBeenCalled(); expect(app.auth).not.toHaveBeenCalled();
  button('Exit game').click();
  expect(app.confirm.mock.calls[0][1]).toContain('cannot restart this daily');
  await app.confirm.mock.calls[0][0]();
  expect(app.api).toHaveBeenCalledExactlyOnceWith('/api/attempts/daily-1/quit', { body: {} });
  expect(saved.has(DAILY_RESUME_KEY)).toBe(false);
  expect(saved.has(imageKey)).toBe(true);
  expect(button('Continue demo')).toBeDefined();
});

it('retains the daily bookmark if the quit request fails', async () => {
  saved.set(ACTIVE_MODE_KEY, 'daily');
  saved.set(DAILY_RESUME_KEY, JSON.stringify({ id: 'daily-1', day: '2026-10-22', round: 0, totalRounds: 5, completedRounds: 0 }));
  app.api.mockRejectedValue(Error('Offline'));
  await import('../src/guessr/main'); button('Exit game').click();
  await expect(app.confirm.mock.calls[0][0]()).rejects.toThrow('Offline');
  expect(saved.has(DAILY_RESUME_KEY)).toBe(true);
  expect(button('Continue daily')).toBeDefined();
});
