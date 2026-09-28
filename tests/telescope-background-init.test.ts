// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/data-archive", () => ({ getDataZip: vi.fn(async () => ({})) }));
vi.mock("../src/renderer_settings", () => ({
  useRenderPerfGeneration: () => true,
}));
vi.mock("../src/telescope/terrain-elevator", () => ({
  prepareElevatorShafts: vi.fn(),
  withoutElevatorEndpointSpawns: vi.fn(),
}));
vi.mock("../src/telescope/load-telescope", () => ({
  loadTelescopeModules: vi.fn(),
}));
vi.mock("../src/telescope/telescope-dom-shim", () => ({
  installTelescopeShim: vi.fn(),
}));
vi.mock("../src/telescope/telescope-data-bridge", () => ({
  installFetchInterceptor: vi.fn(),
  installImageSrcInterceptor: vi.fn(),
}));
vi.mock("../src/telescope/telescope-cache-version", () => ({
  ensureTelescopeCacheVersion: vi.fn(async () => {}),
}));
vi.mock("../src/telescope/prepared-scenes", () => ({
  prepareSceneInputs: vi.fn(async () => {}),
  installPreparedScenes: vi.fn(async () => {}),
}));
vi.mock("../src/telescope/pw-worker?worker", () => ({ default: class {} }));
import { loadTelescopeModules } from "../src/telescope/load-telescope";
import { initTelescope } from "../src/telescope/telescope-adapter";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("joins and promotes background Telescope initialization without waiting for its queued idle callback", async () => {
  const idle = vi.fn(() => 1),
    cancel = vi.fn();
  vi.stubGlobal("requestIdleCallback", idle);
  vi.stubGlobal("cancelIdleCallback", cancel);
  const loads: string[] = [];
  const config = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `biome-${i}`,
      { wangFile: `wang/${i}.png` },
    ]),
  );
  const modules: Record<string, any> = {};
  for (const name of [
    "biomeGenMod",
    "tileGenMod",
    "poiScannerMod",
    "pixelSceneMod",
    "unlocksMod",
    "utilsMod",
    "eyeMessagesMod",
    "imageProcessingMod",
    "staticSpawnsMod",
    "appMod",
    "potionConfigMod",
  ])
    modules[name] = {};
  modules.genConfigMod = { GENERATOR_CONFIG: config };
  modules.settingsMod = { updateSettings: vi.fn() };
  modules.translationsMod = { loadTranslations: vi.fn(async () => {}) };
  modules.pngSanitizerMod = {
    loadPNG: vi.fn(async (file: string) => {
      loads.push(file);
      return { data: new Uint8Array(4) };
    }),
  };
  vi.mocked(loadTelescopeModules).mockResolvedValue(modules);
  const background = initTelescope({ background: true });
  await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  expect(loads.filter((file) => file.startsWith("wang/"))).toHaveLength(0);
  const foreground = initTelescope();
  await Promise.all([background, foreground]);
  expect(cancel).toHaveBeenCalledWith(1);
  expect(loadTelescopeModules).toHaveBeenCalledOnce();
  expect(loads.filter((file) => file.startsWith("wang/"))).toHaveLength(12);
  for (const entry of Object.values(config))
    expect(entry).toHaveProperty("wangData");
});
