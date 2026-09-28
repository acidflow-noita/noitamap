import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { RetainedTerrain, type StoredTerrain } from "../src/telescope/retained-terrain";
import { holdTerrainRetirement } from "../src/telescope/terrain-retirement";

let idle: (() => void)[];
const owners: RetainedTerrain[] = [];
const holds: (() => void)[] = [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function nextIdle() {
  const callback = idle.shift();
  expect(callback, "an idle task should be scheduled").toBeDefined();
  callback!();
  await settle();
}
async function drain() {
  await settle();
  for (let count = 0; idle.length && count < 100; count++) await nextIdle();
  expect(idle).toHaveLength(0);
}
function hold() {
  const release = holdTerrainRetirement();
  holds.push(release);
  return release;
}
function retained(pages = 1) {
  const records = new Map<string, StoredTerrain>();
  const write = vi.fn(async (entries: { key: string; value: StoredTerrain }[]) => {
    for (const entry of entries) records.set(entry.key, entry.value);
  });
  const dispose = vi.fn();
  const owner = new RetainedTerrain({ read: async key => records.get(key), write, dispose });
  owners.push(owner);
  const reads: MockInstance[] = [];
  for (let i = 0; i < pages; i++) {
    const context = createCanvas(256, 256).getContext("2d");
    context.fillStyle = "#cc3311";
    context.fillRect(0, 0, 256, 256);
    context.clearRect(0, 0, 1, 1);
    reads.push(vi.spyOn(context, "getImageData"));
    owner.install(`tile/${i}`, context as unknown as CanvasRenderingContext2D, new Uint8Array([1]), 1, 1, true);
  }
  return { owner, records, write, dispose, readCount: () => reads.reduce((n, spy) => n + spy.mock.calls.length, 0) };
}

beforeEach(() => {
  idle = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle.push(callback); return idle.length; });
});
afterEach(async () => {
  holds.splice(0).forEach(release => release());
  owners.splice(0).forEach(owner => owner.dispose());
  await drain();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("does no synchronous disposal readback and waits for overlapping handoffs before persisting exact pages", async () => {
  const first = hold(), second = hold(), retainedMap = retained(2);
  retainedMap.owner.dispose();
  retainedMap.owner.dispose();
  expect(retainedMap.readCount()).toBe(0);
  expect(retainedMap.write).not.toHaveBeenCalled();
  expect(idle).toHaveLength(0);
  first();
  first();
  await settle();
  expect(idle).toHaveLength(0);
  second();
  expect(retainedMap.readCount()).toBe(0);
  await drain();
  await retainedMap.owner.flush();
  expect(retainedMap.readCount()).toBe(2);
  expect(retainedMap.records.size).toBe(2);
  expect([...retainedMap.records.get("tile/0")!.pixels.subarray(0, 8)])
    .toEqual([0, 0, 0, 0, 204, 51, 17, 255]);
  expect(retainedMap.owner.stats.bytes).toBe(0);
  expect(retainedMap.dispose).toHaveBeenCalledOnce();
});

it("rechecks the handoff gate before queued work and between bounded write batches", async () => {
  const retainedMap = retained(40);
  let finishWrite!: () => void;
  retainedMap.write.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  retainedMap.owner.dispose();
  const release = hold();
  await nextIdle(); // Scheduled before the hold: it must recheck readiness.
  expect(retainedMap.readCount()).toBe(0);
  expect(idle).toHaveLength(0);
  release();
  await nextIdle();
  expect(retainedMap.readCount()).toBeGreaterThan(0);
  expect(retainedMap.readCount()).toBeLessThan(40);
  expect(retainedMap.owner.stats.snapshotBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const readsAfterFirst = retainedMap.readCount(), secondRelease = hold();
  finishWrite();
  await settle();
  expect(retainedMap.readCount()).toBe(readsAfterFirst);
  expect(idle).toHaveLength(0);
  secondRelease();
  expect(retainedMap.readCount()).toBe(readsAfterFirst);
  await drain();
  expect(retainedMap.readCount()).toBe(40);
  expect(retainedMap.write.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(retainedMap.dispose).toHaveBeenCalledOnce();
});

it("bounds rapid switches to two retired working sets without removing saved records", async () => {
  const release = hold(), old = retained(), middle = retained(), latest = retained();
  const persisted: StoredTerrain = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]),
    coverage: new Uint8Array([1]), columns: 1, rows: 1 };
  old.records.set("already-saved", persisted);
  old.owner.dispose();
  middle.owner.dispose();
  latest.owner.dispose();
  await settle();
  expect(old.owner.stats.bytes).toBe(0);
  expect(old.readCount()).toBe(0);
  expect(old.write).not.toHaveBeenCalled();
  expect(old.records.get("already-saved")).toBe(persisted);
  expect(old.dispose).toHaveBeenCalledOnce();
  expect(middle.owner.stats.pages).toBe(1);
  expect(latest.owner.stats.pages).toBe(1);
  release();
  await drain();
  expect(middle.write).toHaveBeenCalledOnce();
  expect(latest.write).toHaveBeenCalledOnce();
});

it("serializes retired snapshots and lets an already started write finish when its generation is discarded", async () => {
  const old = retained(20), middle = retained(), latest = retained();
  let finishWrite!: () => void;
  old.write.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  old.owner.dispose();
  await nextIdle();
  const reads = old.readCount();
  middle.owner.dispose();
  latest.owner.dispose();
  await settle();
  expect(old.owner.stats.bytes).toBe(0);
  expect(old.dispose).not.toHaveBeenCalled();
  expect(middle.readCount()).toBe(0);
  expect(latest.readCount()).toBe(0);
  finishWrite();
  await settle();
  expect(old.dispose).toHaveBeenCalledOnce();
  await drain();
  expect(old.readCount()).toBe(reads);
  expect(middle.readCount()).toBe(1);
  expect(latest.readCount()).toBe(1);
});

it("keeps current-map persistence independent of the outgoing handoff gate", async () => {
  hold();
  const current = retained(2);
  await current.owner.flush();
  expect(current.readCount()).toBe(2);
  expect(current.records.size).toBe(2);
  expect(idle).toHaveLength(0);
});
