import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  ensureScenePixels,
  initPixelSceneTextures,
  loadPixelSceneData,
  PIXEL_SCENE_DATA,
  PIXEL_SCENE_SPAWN_DATA,
} from "../lib/noita-telescope-vm/js/pixel_scene_generation.js";
import { snapshotWorkerScenes } from "../src/telescope/worker-scenes";

it("keeps startup metadata-only and decodes actual scene pixels only when requested", async () => {
  // The upstream atlas uses browser-relative fetch even in Node; supply its
  // actual repository bytes while the PNG reader uses upstream's native path.
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), new URL("../lib/noita-telescope-vm/js/", import.meta.url));
    return new Response(await readFile(url));
  });
  try {
    await loadPixelSceneData();
    expect(await initPixelSceneTextures()).toBeTruthy();
    const data = PIXEL_SCENE_DATA as Record<string, any>;
    const spawnData = PIXEL_SCENE_SPAWN_DATA as Record<string, any[]>;
    const records = Object.values(data);
    expect(records.length).toBeGreaterThan(100);
    expect(records.every((record) => record.imgElement === null)).toBe(true);
    const scene = data["general/essenceroom"];
    expect(scene).toBeTruthy();
    const spawns = structuredClone(spawnData[scene.key]);
    await Promise.all([ensureScenePixels(scene), ensureScenePixels(scene)]);
    expect(scene.imgElement).toBeInstanceOf(Uint8Array);
    expect(scene.imgElement.length).toBe(scene.width * scene.height * 4);
    expect(scene.imgElement.some((byte: number) => byte !== 0)).toBe(true);
    expect(scene.visualArt?.data.length).toBeGreaterThan(0);
    expect(spawnData[scene.key]).toEqual(spawns);
    expect(records.filter((record) => record.imgElement !== null)).toHaveLength(1);
    const { scenes: metadata } = JSON.parse(await readFile(new URL("../lib/noita-telescope-vm/data/pixel_scene_meta.json", import.meta.url), "utf8"));
    expect([scene.width, scene.height]).toEqual([metadata[scene.key].width, metadata[scene.key].height]);
    const packet = snapshotWorkerScenes({ PIXEL_SCENE_DATA, PIXEL_SCENE_SPAWN_DATA, ensureScenePixels }, true);
    expect(packet.data[scene.key].imgElement).toBeNull();
    expect(packet.spawns[scene.key]).toEqual(spawns);
  } finally {
    fetch.mockRestore();
  }
});
