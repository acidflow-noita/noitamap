import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDailySeedCache,
  fetchDailySeed,
  fetchPreviousDailySeed,
  getCachedDailySeed,
  getCachedPreviousDailySeed,
  getCachedDailyComparisonTarget,
  getCachedDailySeedIdentity,
} from "../src/data_sources/daily_seed";
let today = 1318860803,
  previous = 1993746523;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearDailySeedCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T00:00:10Z"));
  today = 1318860803;
  previous = 1993746523;
  fetcher = vi.fn(
    async (url: string) =>
      new Response(String(url.includes("previous") ? previous : today)),
  );
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("does not pin yesterday all day when the seed publisher updates after midnight", async () => {
  today = 1993746523;
  expect(await fetchDailySeed()).toBe(1993746523);
  today = 1318860803;
  vi.setSystemTime(new Date("2026-09-17T00:01:11Z"));
  expect(await fetchDailySeed()).toBe(1318860803);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("explicit daily buttons bypass even a fresh in-memory cache and HTTP caching", async () => {
  expect(await fetchDailySeed()).toBe(today);
  today = 42;
  expect(await fetchDailySeed()).not.toBe(42);
  expect(await fetchDailySeed(true)).toBe(42);
  expect(await fetchPreviousDailySeed()).toBe(previous);
  previous = 41;
  expect(await fetchPreviousDailySeed(true)).toBe(41);
  expect(
    fetcher.mock.calls.every(([, options]) => options.cache === "no-store"),
  ).toBe(true);
});
it("expires both caches at UTC rollover even within a minute", async () => {
  vi.setSystemTime(new Date("2026-09-16T23:59:59Z"));
  await fetchDailySeed();
  await fetchPreviousDailySeed();
  today = 7;
  previous = 6;
  vi.setSystemTime(new Date("2026-09-17T00:00:01Z"));
  expect(await fetchDailySeed()).toBe(7);
  expect(await fetchPreviousDailySeed()).toBe(6);
});
it("labels today's, previous and arbitrary seeds using known pointers without fetching", async () => {
  expect(getCachedDailyComparisonTarget(today)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  await fetchDailySeed();
  expect(getCachedDailyComparisonTarget(today)).toEqual({ kind: 'previous' });
  await fetchPreviousDailySeed();
  fetcher.mockClear();
  expect(getCachedDailyComparisonTarget(today)).toEqual({ kind: 'previous', seed: previous });
  expect(getCachedDailySeedIdentity(today)).toBe('today');
  expect(getCachedDailySeedIdentity(previous)).toBe('previous');
  expect(getCachedDailySeedIdentity(42)).toBeNull();
  expect(getCachedDailyComparisonTarget(previous)).toEqual({ kind: 'today', seed: today });
  expect(getCachedDailyComparisonTarget(42)).toEqual({ kind: 'today', seed: today });
  expect(fetcher).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-09-18T00:00:01Z'));
  expect(getCachedDailyComparisonTarget(today)).toBeNull();
  expect(getCachedDailySeedIdentity(today)).toBeNull();
});
it("does not label an inconsistent daily pointer pair as a valid comparison", async () => {
  previous = today;
  await fetchDailySeed();
  await fetchPreviousDailySeed();
  expect(getCachedDailyComparisonTarget(today)).toBeNull();
});
it.each(["0", "1.5", "42garbage", "4294967296", "", "-1"])(
  "rejects invalid seed metadata %s instead of accepting a prefix",
  async (text) => {
    fetcher.mockImplementation(async () => new Response(text));
    await expect(fetchDailySeed()).rejects.toThrow(/parse/);
    expect(await fetchPreviousDailySeed()).toBeNull();
  },
);

function pendingResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const { name, load, cached } of [
  { name: "current", load: fetchDailySeed, cached: getCachedDailySeed },
  { name: "previous", load: fetchPreviousDailySeed, cached: getCachedPreviousDailySeed },
]) {
  it(`shares concurrent cold ${name} seed reads`, async () => {
    const response = pendingResponse();
    fetcher.mockReturnValue(response.promise);
    const readers = [load(), load(), load()];
    expect(fetcher).toHaveBeenCalledTimes(1);
    response.resolve(new Response("42"));
    expect(await Promise.all(readers)).toEqual([42, 42, 42]);
  });

  it(`forces a fresh ${name} read and ignores the older request's late completion`, async () => {
    const older = pendingResponse(), newer = pendingResponse();
    fetcher.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const original = load();
    const refreshed = load(true);
    const follower = load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    newer.resolve(new Response("42"));
    expect(await refreshed).toBe(42);
    expect(await follower).toBe(42);
    older.resolve(new Response("41"));
    expect(await original).toBe(41);
    expect(cached()).toBe(42);
    expect(await load()).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it(`clearing ${name} cache invalidates a pending read without disturbing its replacement`, async () => {
    const older = pendingResponse(), newer = pendingResponse();
    fetcher.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const original = load();
    clearDailySeedCache();
    const replacement = load();
    older.resolve(new Response("41"));
    expect(await original).toBe(41);
    expect(cached()).toBeNull();
    const follower = load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    newer.resolve(new Response("42"));
    expect(await replacement).toBe(42);
    expect(await follower).toBe(42);
    expect(cached()).toBe(42);
  });

  it(`does not reuse an in-flight ${name} request across UTC midnight`, async () => {
    vi.setSystemTime(new Date("2026-09-16T23:59:59Z"));
    const older = pendingResponse(), newer = pendingResponse();
    fetcher.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const original = load();
    vi.setSystemTime(new Date("2026-09-17T00:00:01Z"));
    const replacement = load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    older.resolve(new Response("41"));
    expect(await original).toBe(41);
    expect(cached()).toBeNull();
    newer.resolve(new Response("42"));
    expect(await replacement).toBe(42);
    expect(cached()).toBe(42);
  });

  it(`retries a failed ${name} request instead of retaining its rejected promise`, async () => {
    const response = pendingResponse();
    fetcher.mockReturnValueOnce(response.promise).mockResolvedValueOnce(new Response("42"));
    const outcomes = Promise.allSettled([load(), load()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    response.reject(new Error("network unavailable"));
    const results = await outcomes;
    if (name === "current") expect(results.every((result) => result.status === "rejected")).toBe(true);
    else expect(results).toEqual([{ status: "fulfilled", value: null }, { status: "fulfilled", value: null }]);
    expect(cached()).toBeNull();
    expect(await load()).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
}
