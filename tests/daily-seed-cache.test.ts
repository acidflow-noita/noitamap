import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDailySeedCache,
  fetchDailySeed,
  fetchPreviousDailySeed,
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
it.each(["0", "1.5", "42garbage", "4294967296", "", "-1"])(
  "rejects invalid seed metadata %s instead of accepting a prefix",
  async (text) => {
    fetcher.mockImplementation(async () => new Response(text));
    await expect(fetchDailySeed()).rejects.toThrow(/parse/);
    expect(await fetchPreviousDailySeed()).toBeNull();
  },
);
