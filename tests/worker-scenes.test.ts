import {expect, it, vi} from 'vitest';
import {installWorkerScenes, snapshotWorkerScenes} from '../src/telescope/worker-scenes';

it('reuses decoded scene pixels and exact prescanned spawns, not per-seed variants', () => {
  const pixels = new Uint8Array([1, 2, 3, 255]);
  const spawn = {sourceBiome: 'coalmine', x: 0, y: 0, spawnFunctionIndex: 3};
  const source = {PIXEL_SCENE_DATA: {example: {width: 1, height: 1, imgElement: pixels, variants: {oldSeed: new Uint8Array(4)}}}, PIXEL_SCENE_SPAWN_DATA: {example: [spawn]}};
  const snapshot = snapshotWorkerScenes(source, false);
  expect(snapshot.data.example.imgElement).toBe(pixels);
  expect(snapshot.data.example.variants).toEqual({});
  expect(source.PIXEL_SCENE_DATA.example.variants.oldSeed).toBeDefined();
  const workerCopy = structuredClone(snapshot);
  const target = {injectPixelSceneData: vi.fn(), injectPixelSceneSpawnData: vi.fn()};
  expect(installWorkerScenes(target, workerCopy, false)).toBe(1);
  expect(workerCopy.spawns.example).toEqual([spawn]);
  workerCopy.data.example.imgElement[0] = 99;
  expect(pixels).toEqual(new Uint8Array([1, 2, 3, 255]));
  expect(target.injectPixelSceneSpawnData).toHaveBeenCalledWith(workerCopy.spawns);
});

it('refuses uninitialized, incomplete or mismatched-fork inputs', () => {
  expect(() => snapshotWorkerScenes({PIXEL_SCENE_DATA: {}, PIXEL_SCENE_SPAWN_DATA: {}}, false)).toThrow(/before initialization/);
  const source = {PIXEL_SCENE_DATA: {key: {variants: {}}}, PIXEL_SCENE_SPAWN_DATA: {key: []}};
  const packet = snapshotWorkerScenes(source, false);
  expect(() => installWorkerScenes({}, packet, true)).toThrow(/fork/);
  delete packet.spawns.key;
  expect(() => installWorkerScenes({}, packet, false)).toThrow(/Incomplete/);
});
