import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDailySeedCache,
  fetchDailySeed,
  fetchPreviousDailySeed,
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
