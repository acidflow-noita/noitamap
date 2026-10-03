// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import revision from '../src/data/spritesheet-revision.json';

const stored = new Map<string, Response>();
let loaded: string[];
beforeEach(() => {
  vi.resetModules();
  stored.clear();
  loaded = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('caches', { open: async () => ({
    match: async (request: Request) => stored.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { stored.set(request.url, response.clone()); },
  }) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })));
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(url: string) { loaded.push(url); queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:local-sheet');
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('reuses the persistent local spritesheet across reloads and coalesces callers', async () => {
  let api = await import('../src/telescope/poi-spatial-index');
  const [a, b] = await Promise.all([api.loadSpritesheetAndAtlas(), api.loadSpritesheetAndAtlas()]);
  expect(a.spritesheet).toBe(b.spritesheet);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`./assets/spritesheet.png?v=${revision}`, expect.anything());
  expect(loaded).toEqual(['blob:local-sheet']);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-sheet');
  vi.resetModules();
  api = await import('../src/telescope/poi-spatial-index');
  await api.loadSpritesheetAndAtlas();
  expect(fetch).toHaveBeenCalledOnce();
  expect(loaded).toEqual(['blob:local-sheet', 'blob:local-sheet']);
});

it('keeps same-origin image loading available if fetch is restricted', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('connect-src denied'));
  const api = await import('../src/telescope/poi-spatial-index');
  await expect(api.loadSpritesheetAndAtlas()).resolves.toHaveProperty('spritesheet');
  expect(loaded).toEqual([`./assets/spritesheet.png?v=${revision}`]);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
