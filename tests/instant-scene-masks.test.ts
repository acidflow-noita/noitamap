import { expect, it, vi } from "vitest";
import { loadInstantSceneMasks } from "../src/telescope/instant-scene-masks";

const raw = () => ({
  width: 2,
  height: 2,
  imgElement: new Uint8Array([
    20,
    30,
    40,
    255, // authored material
    0,
    0,
    66,
    255, // force air
    0,
    0,
    0,
    255, // empty material
    90,
    80,
    70,
    0, // transparent art
  ]),
});

it("bounds delayed unique decodes at eight and preserves all placements and material/air masks", async () => {
  const placements = Array.from({ length: 1000 }, (_, i) => ({
    key: `scene-${i % 19}`,
    x: i * 7,
    y: -i,
  }));
  let active = 0,
    peak = 0;
  const pending: (() => void)[] = [];
  const load = vi.fn(() => {
    active++;
    peak = Math.max(peak, active);
    return new Promise<ReturnType<typeof raw>>((resolve) =>
      pending.push(() => {
        active--;
        resolve(raw());
      }),
    );
  });
  const result = loadInstantSceneMasks(placements, load);
  expect(load).toHaveBeenCalledTimes(8);
  // Finish batches in reverse order so decode completion cannot accidentally
  // determine placement order. The next bounded group starts immediately.
  while (load.mock.calls.length < 19 || pending.length) {
    pending
      .splice(0)
      .reverse()
      .forEach((finish) => finish());
    await Promise.resolve();
  }
  const masks = await result;
  expect(peak).toBe(8);
  expect(load).toHaveBeenCalledTimes(19);
  expect(masks).toHaveLength(placements.length);
  expect(masks.map(({ x, y }) => ({ x, y }))).toEqual(
    placements.map(({ x, y }) => ({ x, y })),
  );
  for (const mask of masks) {
    expect(mask.width).toBe(2);
    expect(mask.height).toBe(2);
    expect([...mask.bits]).toEqual([1]);
    expect([...mask.airBits!]).toEqual([2]);
  }
  expect(masks[0].bits).toBe(masks[19].bits);
  expect(masks[0].airBits).toBe(masks[19].airBits);
});

it("skips the same unusable material records without removing valid duplicate placements", async () => {
  const scenes = ["valid", "missing", "small", "image", "valid"].map(
    (key, x) => ({ key, x, y: 2 }),
  );
  const load = vi.fn(async (key: string) =>
    key === "missing"
      ? undefined
      : key === "small"
        ? { ...raw(), width: 1 }
        : key === "image"
          ? { ...raw(), imgElement: {} }
          : raw(),
  );
  const masks = await loadInstantSceneMasks(scenes, load);
  expect(masks.map((mask) => mask.x)).toEqual([0, 4]);
  expect(load).toHaveBeenCalledTimes(4);
});

it("propagates loader errors and stops admitting more keys after failure", async () => {
  const failure = new Error("Scene decode failed");
  let reject!: (error: Error) => void;
  const finish: (() => void)[] = [];
  const load = vi.fn(
    () =>
      new Promise<ReturnType<typeof raw>>((resolve, fail) => {
        reject = fail;
        finish.push(() => resolve(raw()));
      }),
  );
  const result = loadInstantSceneMasks(
    Array.from({ length: 20 }, (_, x) => ({ key: String(x), x, y: 0 })),
    load,
  );
  expect(load).toHaveBeenCalledTimes(8);
  const rejected = expect(result).rejects.toBe(failure);
  reject(failure);
  await rejected;
  finish.forEach(resolve => resolve());
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(8);
});
