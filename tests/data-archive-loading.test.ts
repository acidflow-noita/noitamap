import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const url = 'https://noitamap.test/data.zip';
let original: ArrayBuffer;
let updated: ArrayBuffer;
let stored: Map<string, Response>;
let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
let storage: { open: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  original = await new JSZip().file('test.txt', 'original archive').generateAsync({ type: 'arraybuffer' });
  updated = await new JSZip().file('test.txt', 'updated archive').generateAsync({ type: 'arraybuffer' });
});
beforeEach(() => {
  vi.resetModules();
  stored = new Map();
  cache = {
    match: vi.fn(async (key: string) => stored.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { stored.set(key, response.clone()); }),
  };
  storage = { open: vi.fn(async () => cache), delete: vi.fn(async () => true) };
  vi.stubGlobal('caches', storage);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { baseURI: 'https://noitamap.test/' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function archive(bytes = original, extra: Record<string, string> = {}) {
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.byteLength), ...extra },
  });
}

async function load() {
  const { getZip } = await import('../src/data-archive');
  const zip = await getZip('main', true);
  expect(zip).not.toBeNull();
  return zip!.file('test.txt')!.async('string');
}

describe('archive requests and cached freshness', () => {
  it.each<{ headers: Record<string, string>; expected: string | null }>([
    { headers: { ETag: '"archive-v1"', 'Last-Modified': 'Tue, 01 Sep 2026 00:00:00 GMT' }, expected: '"archive-v1"' },
    { headers: { 'Last-Modified': 'Tue, 01 Sep 2026 00:00:00 GMT' }, expected: 'Tue, 01 Sep 2026 00:00:00 GMT' },
    { headers: {}, expected: null },
  ])('downloads a cold archive directly and caches GET metadata ($expected)', async ({ headers, expected }) => {
    const fetch = vi.fn(async () => archive(original, headers));
    vi.stubGlobal('fetch', fetch);
    await expect(load()).resolves.toBe('original archive');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const cached = stored.get(url)!;
    expect(cached.headers.get('X-Archive-Meta')).toBe(expected ?? String(original.byteLength));
    expect(await cached.clone().arrayBuffer()).toEqual(original);
  });

  it('makes only a GET without the Cache API and reuses the decoded archive', async () => {
    vi.stubGlobal('caches', undefined);
    const fetch = vi.fn(async () => archive());
    vi.stubGlobal('fetch', fetch);
    const { getZip } = await import('../src/data-archive');
    const [first, second] = await Promise.all([getZip('main', true), getZip('main', true)]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await getZip('main', true)).toBe(first);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url);
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('validates a warm archive with HEAD and skips GET when its metadata matches', async () => {
    stored.set(url, archive(original, { 'X-Archive-Meta': '"same-version"' }));
    const fetch = vi.fn(async () => new Response(null, { headers: { ETag: '"same-version"' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(load()).resolves.toBe('original archive');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { method: 'HEAD', cache: 'no-cache' });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('replaces changed cache data and stores the GET version if it changed again after HEAD', async () => {
    stored.set(url, archive(original, { 'X-Archive-Meta': '"v1"' }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: '"v2"' } }))
      .mockResolvedValueOnce(archive(updated, { ETag: '"v3"' }));
    vi.stubGlobal('fetch', fetch);
    await expect(load()).resolves.toBe('updated archive');
    expect(fetch.mock.calls).toEqual([[url, { method: 'HEAD', cache: 'no-cache' }], [url]]);
    expect(stored.get(url)!.headers.get('X-Archive-Meta')).toBe('"v3"');
    expect(await stored.get(url)!.clone().arrayBuffer()).toEqual(updated);
  });

  it.each(['offline', 'http-error'])('keeps a usable warm archive when HEAD fails ($0)', async failure => {
    stored.set(url, archive(original, { 'X-Archive-Meta': '"cached"' }));
    const fetch = vi.fn();
    if (failure === 'offline') fetch.mockRejectedValue(new Error('offline'));
    else fetch.mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(load()).resolves.toBe('original archive');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { method: 'HEAD', cache: 'no-cache' });
    expect(cache.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('lets a worker decode the main-thread cache with no HEAD or network request', async () => {
    const fetch = vi.fn(async () => archive(original, { ETag: '"worker-compatible"' }));
    vi.stubGlobal('fetch', fetch);
    await expect(load()).resolves.toBe('original archive');
    vi.resetModules();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('self', { location: { href: 'https://noitamap.test/build/worker.js' } });
    fetch.mockClear();
    await expect(load()).resolves.toBe('original archive');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.open).toHaveBeenLastCalledWith('noitamap-archive-main-v2');
    expect(cache.match).toHaveBeenLastCalledWith(url);
  });
});
