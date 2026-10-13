import { beforeEach, expect, it, vi } from "vitest";
import { encodeScenePack } from "../src/telescope/scene-pack";
import { unpackSceneInputs } from "../src/telescope/unpack-scene-inputs";

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
  offThread: vi.fn(),
  worker: vi.fn(),
  packs: { full: { url: "/full.bin.gz", scenes: 1, bytes: 0 } },
}));
vi.mock("virtual:noitamap-scene-assets", () => ({
  provenance: "revision", packs: fixture.packs,
}));
vi.mock("../src/telescope/immutable-assets", () => ({
  immutableTelescopeAssets: { fetch: fixture.fetch },
  revisionedAssetUrl: (url: string) => url,
}));
vi.mock("../src/telescope/prepared-scenes-worker?worker", () => ({
  default: class { constructor() { fixture.worker(); } },
}));
vi.mock("../src/telescope/scene-input-loader", () => ({
  loadSceneInputsOffThread: fixture.offThread,
}));

const snapshot = {
  version: 1 as const, fullPixels: true,
  data: { room: { width: 8, height: 8, imgElement: null, visualArt: null, variants: {} } },
  spawns: { room: [{ x: 2, y: 3, type: "heart" }] },
};

beforeEach(() => {
  vi.resetModules();
  fixture.fetch.mockReset(); fixture.offThread.mockReset(); fixture.worker.mockReset();
  const bytes = encodeScenePack(snapshot, "revision");
  fixture.packs.full.bytes = bytes.byteLength;
  fixture.fetch.mockImplementation(async () => new Response(bytes.buffer as ArrayBuffer));
  fixture.offThread.mockImplementation((bytes, size, revision, createWorker) => {
    createWorker();
    return unpackSceneInputs(bytes, size, revision);
  });
});

function sceneModule() {
  return { initPixelSceneTextures: vi.fn(), injectPixelSceneData: vi.fn(), injectPixelSceneSpawnData: vi.fn() };
}

it("installs PW metadata without starting rendering assets or a nested unpack worker", async () => {
  const scenes = sceneModule();
  scenes.initPixelSceneTextures.mockImplementation(() => { throw new Error("PW worker requested texture assets"); });
  const { installPreparedScenes } = await import("../src/telescope/prepared-scenes");
  await installPreparedScenes(scenes, true, true);
  expect(scenes.initPixelSceneTextures).not.toHaveBeenCalled();
  expect(fixture.offThread).not.toHaveBeenCalled();
  expect(fixture.worker).not.toHaveBeenCalled();
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.fetch.mock.calls[0][0]).toBe("prepared-scenes/full");
  expect(scenes.injectPixelSceneData).toHaveBeenCalledWith(snapshot.data);
  expect(scenes.injectPixelSceneSpawnData).toHaveBeenCalledWith(snapshot.spawns);
});

it("keeps main rendering texture warmup independent of scene installation", async () => {
  const scenes = sceneModule();
  scenes.initPixelSceneTextures.mockReturnValue(new Promise(() => {}));
  const { installPreparedScenes } = await import("../src/telescope/prepared-scenes");
  await installPreparedScenes(scenes, true);
  expect(scenes.initPixelSceneTextures).toHaveBeenCalledOnce();
  expect(fixture.offThread).toHaveBeenCalledOnce();
  expect(fixture.worker).toHaveBeenCalledOnce();
  expect(scenes.injectPixelSceneData).toHaveBeenCalledWith(snapshot.data);
  expect(scenes.injectPixelSceneSpawnData).toHaveBeenCalledWith(snapshot.spawns);
});
