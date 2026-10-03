import { expect, it, vi } from "vitest";
import { createScenePrefetch } from "../src/telescope/scene-prefetch";

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
