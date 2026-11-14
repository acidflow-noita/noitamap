// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { gameCode } from '../src/guessr/routes';

const app = vi.hoisted(() => ({ request: vi.fn(), picker: vi.fn(), auth: vi.fn(), saved: vi.fn(), publicResult: vi.fn() }));
vi.mock('../src/guessr/image-game', () => ({ imageGameRequest: app.request }));
vi.mock('../src/guessr/stream-ui', () => ({ StreamUI: class {
  constructor(private hooks: { shell(game: boolean): HTMLElement }) {}
  save() {} suspend() {} publicResult = app.publicResult;
  picker() { app.picker(); this.hooks.shell(true); }
} }));
vi.mock('../src/guessr/stream-result-archive', () => ({ StreamResultArchive: class { get = app.saved; } }));
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

it('opens a locally saved PvP result on the same match URL without connecting to the match or Pro auth', async () => {
  vi.resetModules(); vi.clearAllMocks();
  const id = '11111111-1111-4111-8111-111111111111', url = `/guess/pvp/${gameCode(id, 'pvp')}/`;
  history.replaceState(null, '', url); document.body.innerHTML = '<div id="guess-app"></div>';
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  app.saved.mockResolvedValue({ result: { id, mode: 'pvp' }, published: false });
  app.request.mockImplementation(async path => {
    if (path !== '/config') throw Error('Unexpected game server request');
    return { version: 'map-version', bounds: { x: 0, y: 0, width: 100, height: 100 }, overview: '', map: {} };
  });
  await import('../src/guessr/main');
  await vi.waitFor(() => expect(app.publicResult).toHaveBeenCalledExactlyOnceWith(id));
  expect(app.auth).not.toHaveBeenCalled(); expect(app.picker).not.toHaveBeenCalled();
  expect(app.request).toHaveBeenCalledExactlyOnceWith('/config'); expect(location.pathname).toBe(url);
});
