import { describe, expect, it, vi } from 'vitest';
import { createBuildCache } from '../build_scripts/vite-build-cache.ts';

describe('shared build input preparation', () => {
  it('coalesces page/worker reads and refreshes on the next root/watch build', async () => {
    const prepare = vi.fn(async () => ({ revision: prepare.mock.calls.length }));
    const cache = createBuildCache(prepare);
    const [page, worker] = await Promise.all([cache.read(), cache.read()]);
    expect(worker).toBe(page);
    expect(prepare).toHaveBeenCalledTimes(1);
    cache.invalidate();
    expect(await cache.read()).toEqual({ revision: 2 });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('retries a failed preparation without discarding a newer build in flight', async () => {
    let rejectOld!: (reason: Error) => void;
    const prepare = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockRejectedValueOnce(new Error('bad input'))
      .mockResolvedValue('updated');
    const cache = createBuildCache(prepare);
    const old = cache.read();
    cache.invalidate();
    await expect(cache.read()).rejects.toThrow('bad input');
    const current = cache.read();
    rejectOld(new Error('old build'));
    await expect(old).rejects.toThrow('old build');
    expect(cache.read()).toBe(current);
    expect(await current).toBe('updated');
    expect(prepare).toHaveBeenCalledTimes(3);
  });
});
