// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ request: vi.fn(), picker: vi.fn(), auth: vi.fn() }));
vi.mock('../src/guessr/image-game', () => ({ imageGameRequest: app.request }));
vi.mock('../src/guessr/stream-ui', () => ({ StreamUI: class {
  constructor(private hooks: { shell(game: boolean): HTMLElement }) {}
  save() {} picker() { app.picker(); this.hooks.shell(true); }
} }));
vi.mock('../src/guessr/api', () => ({ GameApi: class {}, gameApiOrigin: () => null, gameAuth: app.auth }));
vi.mock('../src/guessr/map-board', () => ({ MapBoard: class {} }));
vi.mock('../src/guessr/lobby', () => ({ createLobby: vi.fn() }));
vi.mock('../src/guessr/clue-view', () => ({ attachClueControls: vi.fn() }));
vi.mock('../src/guessr/clue-viewport', () => ({ ClueViewport: class {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(['/guess/?channel=wuote#clue=snapshot', '/guess/stream/wuote/#clue=snapshot'])('opens %s without restoring a saved demo or requesting Pro authentication', async (url) => {
  vi.resetModules(); vi.clearAllMocks();
  history.replaceState(null, '', url);
  document.body.innerHTML = '<div id="guess-app"></div>';
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => JSON.stringify({
    version: 'map-version', id: '12345678-1234-1234-1234-123456789abc',
  })), setItem: vi.fn() });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  app.request.mockImplementation(async path => {
    if (path !== '/config') throw Error('Unexpected game server request');
    return { version: 'map-version', bounds: { x: 0, y: 0, width: 100, height: 100 }, overview: '', map: {} };
  });
  await import('../src/guessr/main');
  expect(app.request).toHaveBeenCalledExactlyOnceWith('/config');
  expect(app.picker).toHaveBeenCalledOnce();
  expect(app.auth).not.toHaveBeenCalled();
  expect(localStorage.getItem).not.toHaveBeenCalled();
  expect(location.pathname).toBe('/guess/stream/wuote/');
  expect(location.search).toBe('');
  expect(location.hash).toBe('#clue=snapshot');
  expect(document.querySelector('.header-actions')!.textContent).not.toContain('Back to map');
});
