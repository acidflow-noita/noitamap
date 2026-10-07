import { afterEach, expect, it, vi } from 'vitest';
import { fetchMapVersions, getTileData } from '../src/data_sources/tile_data';
import { STARTUP_REQUEST_TIMEOUT_MS } from '../src/startup';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps successful per-origin versions and bypasses cached manifests', async () => {
  const fetcher = vi.fn(async (url: URL) => new Response(` ${url.host}-current \n`));
  vi.stubGlobal('fetch', fetcher);
  const versions = await fetchMapVersions('dynamic-main-branch');
  for (const { url } of getTileData('dynamic-main-branch')) {
    const origin = new URL(url).origin;
    expect(versions[origin]).toBe(`${new URL(url).host}-current`);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [, options] of fetcher.mock.calls as any[]) {
    expect(options.cache).toBe('no-store'); expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});

it.each(['headers', 'body'])('falls back to fresh cache-bust values if version %s stall', async stage => {
  const controllers: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const stalled = (signal: AbortSignal) => new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const bodies = vi.fn();
  vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => {
    if (stage === 'headers') return stalled(options.signal!);
    return Promise.resolve({ status: 200, text: () => { bodies(); return stalled(options.signal!); } });
  }));
  const pending = fetchMapVersions('dynamic-main-branch');
  expect(controllers).toHaveLength(3);
  if (stage === 'body') await vi.waitFor(() => expect(bodies).toHaveBeenCalledTimes(3));
  controllers.forEach(controller => controller.abort(new DOMException('Version request timed out', 'TimeoutError')));
  const versions = await pending;
  expect(Object.keys(versions)).toHaveLength(3);
  expect(Object.values(versions).every(value => /^[a-z0-9]+$/.test(value))).toBe(true);
  expect(timeout).toHaveBeenCalledWith(STARTUP_REQUEST_TIMEOUT_MS);
});
