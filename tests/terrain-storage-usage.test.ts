import { afterEach, expect, it, vi } from 'vitest';
import { reportTerrainStorageUsage } from '../src/telescope/terrain-storage-usage';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports estimated site storage and quota with readable sizes and raw bytes', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 256 * 1024 ** 2, quota: 8 * 1024 ** 3 }) } });
  await reportTerrainStorageUsage(new AbortController().signal, 42);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[Instant terrain] Site storage: 256.00 MiB used / 8.00 GiB quota',
    expect.objectContaining({ seed: 42, usageBytes: 256 * 1024 ** 2, quotaBytes: 8 * 1024 ** 3 }),
  );
});

it('keeps missing estimates unknown instead of claiming zero storage', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('navigator', { storage: { estimate: async () => ({}) } });
  await reportTerrainStorageUsage(new AbortController().signal);
  expect(log.mock.calls[0][0]).toBe('[Instant terrain] Site storage: unknown used / unknown quota');
});

it.each([undefined, { estimate: async () => { throw new Error('denied'); } }])('tolerates unavailable storage estimates', async storage => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('navigator', { storage });
  await reportTerrainStorageUsage(new AbortController().signal, 42);
  expect(log).toHaveBeenCalledExactlyOnceWith('[Instant terrain] Site storage estimate unavailable', { seed: 42 });
});

it('discards estimates that arrive after a reseed', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  let resolve!: (value: StorageEstimate) => void;
  vi.stubGlobal('navigator', { storage: { estimate: () => new Promise<StorageEstimate>(done => { resolve = done; }) } });
  const controller = new AbortController();
  const pending = reportTerrainStorageUsage(controller.signal);
  controller.abort(); resolve({ usage: 100, quota: 1000 });
  await pending;
  expect(log).not.toHaveBeenCalled();
});
