import { expect, it, vi } from "vitest";
import { readFileSync } from 'node:fs';
import { createScenePrefetch } from "../src/telescope/scene-prefetch";

it('gates the actual bridge prefetch loop before every missing scene and resumes missing work later', async () => {
  // Exercise the production loop without importing the full map UI/generator.
  const source = readFileSync('src/telescope/telescope-osd-bridge.ts', 'utf8');
  const start = source.indexOf('export const prefetchAllSceneBitmaps =');
  const end = source.indexOf('\n});', start) + 4;
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const cached = new Set<string>(), close = vi.fn();
  const composite = vi.fn(async () => ({ bitmap: { close }, blob: new Blob(['image']), width: 2, height: 2 }));
  const dependencies = {
    createScenePrefetch, getAllPixelSceneKeys: () => ['one', 'two', 'three'],
    carvedRoomBiome: () => null, isWaterCaveLayout: () => false,
    getCachedSceneBitmapKeys: async () => cached, getScenePngIndex: async () => ({}),
    getPixelSceneData: () => ({ width: 2, height: 2 }),
    compositeSceneBitmap: composite,
    cacheSceneBitmap: async (key: string) => { cached.add(key); },
    console: { log() {}, warn: vi.fn() },
  };
  const prefetch = new Function(...Object.keys(dependencies),
    source.slice(start, end).replace(/^export /, '') + '; return prefetchAllSceneBitmaps;')(...Object.values(dependencies));
  let current = true;
  const grants: Array<(ready: boolean) => void> = [];
  const first = prefetch(() => current, () => new Promise<boolean>(done => grants.push(done)));
  await vi.waitFor(() => expect(grants).toHaveLength(1));
  expect(composite).not.toHaveBeenCalled();
  grants[0](true);
  await vi.waitFor(() => expect(grants).toHaveLength(2));
  expect([...cached]).toEqual(['one']); expect(close).toHaveBeenCalledOnce();
  const nextGate = vi.fn(async () => true);
  const second = prefetch(() => true, nextGate);
  current = false; grants[1](false);
  await Promise.all([first, second]);
  expect(composite.mock.calls.map(call => (call as unknown[])[0])).toEqual(['one', 'two', 'three']);
  expect([...cached]).toEqual(['one', 'two', 'three']);
  expect(nextGate).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(3);
});

it("retries after an empty pre-initialization scene table", async () => {
  let keys: string[] = [];
  const cached = new Set<string>();
  const run = vi.fn(async () => {
    for (const key of keys) cached.add(key);
  });
  const prefetch = createScenePrefetch(run);
  await prefetch();
  keys = ["watercave", "coalmine"];
  await prefetch();
  expect(run).toHaveBeenCalledTimes(2);
  expect([...cached]).toEqual(keys);
});

it("finishes missing work for a new view after its joined obsolete pass stops", async () => {
  const cached = new Set<string>(),
    keys = ["one", "two", "three"];
  let current = true,
    release!: () => void,
    active = 0,
    maximum = 0;
  const old = new Promise<void>((done) => {
    release = done;
  });
  const run = vi.fn(async (isCurrent: () => boolean) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      for (const key of keys) {
        if (!isCurrent()) break;
        if (cached.has(key)) continue;
        cached.add(key);
        if (key === "one") await old;
      }
    } finally {
      active--;
    }
  });
  const prefetch = createScenePrefetch(run);
  const first = prefetch(() => current);
  await vi.waitFor(() => expect(cached.has("one")).toBe(true));
  const second = prefetch(() => true);
  current = false;
  release();
  await Promise.all([first, second]);
  expect([...cached]).toEqual(keys);
  expect(run).toHaveBeenCalledTimes(2);
  expect(maximum).toBe(1);
});

it("does not restart a waiting caller which also became obsolete", async () => {
  let release!: () => void,
    current = true;
  const run = vi.fn(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const prefetch = createScenePrefetch(run),
    first = prefetch();
  await Promise.resolve();
  const second = prefetch(() => current);
  current = false;
  release();
  await Promise.all([first, second]);
  expect(run).toHaveBeenCalledOnce();
});
