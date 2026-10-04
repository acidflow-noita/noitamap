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
  // determine placement order. Allow preparation's foreground task yields.
  while (load.mock.calls.length < 19 || pending.length) {
    pending
      .splice(0)
      .reverse()
      .forEach((finish) => finish());
    await new Promise<void>(resolve => setTimeout(resolve, 0));
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

it('reuses immutable material masks across seeds while creating fresh placements', async () => {
  const image = raw(), load = vi.fn(async () => image);
  const first = await loadInstantSceneMasks([{ key: 'room', x: 0, y: 1 }], load);
  const next = await loadInstantSceneMasks([
    { key: 'room', x: -35840, y: 512 }, { key: 'alias', x: 35840, y: -512 },
  ], load);
  expect(next.map(({ x, y }) => ({ x, y }))).toEqual([{ x: -35840, y: 512 }, { x: 35840, y: -512 }]);
  expect(first[0]).toMatchObject({ x: 0, y: 1 });
  for (const mask of next) {
    expect(mask).not.toBe(first[0]);
    expect(mask.bits).toBe(first[0].bits);
    expect(mask.airBits).toBe(first[0].airBits);
    expect([...mask.bits]).toEqual([1]);
    expect([...mask.airBits!]).toEqual([2]);
  }
  const workerCopy = structuredClone(next);
  workerCopy[0].bits.fill(0);
  workerCopy[0].airBits!.fill(0);
  expect([...first[0].bits]).toEqual([1]);
  expect([...first[0].airBits!]).toEqual([2]);
  // Loading still validates the current asset; a scene key alone cannot
  // establish that its decoded pixels survived an asset reload.
  expect(load).toHaveBeenCalledTimes(3);
});

it('rebuilds masks when a scene key is reloaded with different pixels', async () => {
  let image = raw();
  const load = async () => image, placements = [{ key: 'room', x: 0, y: 0 }];
  const first = await loadInstantSceneMasks(placements, load);
  image = raw();
  image.imgElement.set([0, 0, 66, 255], 0);
  image.imgElement.set([0, 0, 0, 0], 4);
  const next = await loadInstantSceneMasks(placements, load);
  expect(next[0].bits).not.toBe(first[0].bits);
  expect([...first[0].bits]).toEqual([1]);
  expect([...first[0].airBits!]).toEqual([2]);
  expect([...next[0].bits]).toEqual([0]);
  expect([...next[0].airBits!]).toEqual([1]);
});

it('does not confuse distinct pixel views into the same buffer', async () => {
  const source = raw(), bytes = new Uint8Array(32);
  bytes.set(source.imgElement);
  bytes.set(source.imgElement, 16);
  bytes.set([0, 0, 66, 255], 16);
  const masks = await loadInstantSceneMasks([{ key: 'first', x: 0, y: 0 }, { key: 'second', x: 2, y: 0 }],
    async key => ({ ...source, imgElement: bytes.subarray(key === 'first' ? 0 : 16, key === 'first' ? 16 : 32) }));
  expect([...masks[0].bits]).toEqual([1]);
  expect([...masks[1].bits]).toEqual([0]);
  expect([...masks[0].airBits!]).toEqual([2]);
  expect([...masks[1].airBits!]).toEqual([3]);
});

it('does not reuse old bounds when a pixel view is supplied with a different shape', async () => {
  const pixels = new Uint8Array(4 * 8).fill(255);
  let image = { width: 2, height: 4, imgElement: pixels };
  const load = async () => image, placements = [{ key: 'room', x: 0, y: 0 }];
  const first = await loadInstantSceneMasks(placements, load);
  image = { width: 4, height: 2, imgElement: pixels };
  const next = await loadInstantSceneMasks(placements, load);
  expect(first[0]).toMatchObject({ width: 2, height: 4 });
  expect(next[0]).toMatchObject({ width: 4, height: 2 });
  expect(next[0].bits).not.toBe(first[0].bits);
  expect([...next[0].bits]).toEqual([255]);
});

it('does not hide a missing or failed asset behind a previously prepared scene key', async () => {
  const image = raw(), placements = [{ key: 'room', x: 0, y: 0 }];
  const load = vi.fn<() => Promise<ReturnType<typeof raw> | undefined>>().mockResolvedValue(image);
  await loadInstantSceneMasks(placements, load);
  load.mockResolvedValue(undefined);
  expect(await loadInstantSceneMasks(placements, load)).toEqual([]);
  const failure = new Error('Reload failed');
  load.mockRejectedValue(failure);
  await expect(loadInstantSceneMasks(placements, load)).rejects.toBe(failure);
});

it('does not reuse old masks after the source view loses its buffer', async () => {
  const image = raw(), placements = [{ key: 'room', x: 0, y: 0 }];
  const first = await loadInstantSceneMasks(placements, async () => image);
  structuredClone(image.imgElement, { transfer: [image.imgElement.buffer] });
  const next = await loadInstantSceneMasks(placements, async () => image);
  expect(next[0].bits.byteLength).toBe(0);
  expect(next[0].airBits!.byteLength).toBe(0);
  expect([...first[0].bits]).toEqual([1]);
  expect([...first[0].airBits!]).toEqual([2]);
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
