import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setFullPixelTerrainForBake } from "../src/renderer_settings";
import {
  clearGLTerrain,
  createGLTerrainTileSource,
  ensureGLTerrain,
  terrainCamera,
  type GLTerrainDeps,
  type GLTerrainSourceOpts,
} from "../src/telescope/gl-terrain-tile-source";

vi.mock("../src/telescope/terrain-footprint", () => ({ createTerrainFootprint: () => () => true }));
vi.mock('../src/telescope/terrain-presentation', () => ({
  createTerrainPresentation: async () => (ctx:any,image:any) => ctx.drawImage(image,0,0),
}));
const drawImage = vi.fn();
const resourceBuild = vi.fn(() => true);
const render = vi.fn((view: any) => ({
  width: view.width,
  height: view.height,
}));
class Renderer {
  ensureResources = resourceBuild;
  render = render;
  invalidate() {}
  rendersWorld(y: number) {
    return y === 0;
  }
}
const deps: GLTerrainDeps = {
  GLTerrainRenderer: Renderer,
  initMaterialAtlas: async () => ({}),
  getWorldCenter: () => 35,
  getWorldSize: () => 70,
  GENERATOR_CONFIG: {},
};
const opts = (pw = 0): GLTerrainSourceOpts => ({
  deps,
  gen: {
    seed: 42,
    isNGP: false,
    tileLayers: [{}],
    biomeData: { pixels: new Uint32Array(70 * 48) },
  },
  pw,
  worldX: -17920 + pw * 35840,
  worldY: -7168,
  worldW: 8,
  worldH: 8,
});

beforeEach(() => {
  setFullPixelTerrainForBake(true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas: any = { width: 0, height: 0 };
      const context = { canvas, drawImage, clearRect() {} };
      canvas.getContext = () => context;
      return canvas;
    },
  });
  vi.stubGlobal("OpenSeadragon", {
    TileSource: class {
      constructor(options: any) {
        Object.assign(this, options);
      }
    },
  });
  vi.clearAllMocks();
});
afterEach(() => {
  clearGLTerrain();
  setFullPixelTerrainForBake(false);
  vi.unstubAllGlobals();
});

function job(source: any, level = source.maxLevel) {
  let resolve!: (value: any) => void;
  const done = new Promise<any>((r) => {
    resolve = r;
  });
  const context: any = {
    tile: { level, x: 0, y: 0 },
    jobId: setTimeout(() => {}, 30000),
    finish: vi.fn((image: any) => {
      // Mirror OSD 6.1: a falsy jobId causes finish() to ignore the result.
      if (context.jobId) {
        context.jobId = null;
        resolve(image.canvas || image);
      }
    }),
    fail: vi.fn((error: string) => {
      context.jobId = null;
      resolve(error);
    }),
  };
  source.downloadTileStart(context);
  return { context, done };
}

describe("GL terrain tiles (no browser/GPU)", () => {
  it("does not initialize live rendering for public maps with an old saved opt-in", async () => {
    setFullPixelTerrainForBake(false);
    vi.stubGlobal("localStorage", { getItem: () => "1" });
    expect(await ensureGLTerrain(deps, opts().gen)).toBe(false);
    expect(resourceBuild).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("waits for material textures before the first resource upload", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const ready = ensureGLTerrain(
      { ...deps, initMaterialAtlas: () => waiting },
      opts().gen,
    );
    expect(resourceBuild).not.toHaveBeenCalled();
    release();
    expect(await ready).toBe(true);
    expect(resourceBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ engineTerrain: true, seed: 42 }),
    );
  });

  it.each([-2, -1, 0, 1, 2])(
    "uses correct absolute material coordinates in PW %i",
    (pw) => {
      const o = opts(pw);
      const tile = { level: 3, x: 1, y: 2, width: 7, height: 5 };
      const view = terrainCamera(o, tile);
      const shaderX = view.camX - view.width / 2 - 35 * 512 + pw * 70 * 512;
      const shaderY = view.camY - view.height / 2 - 14 * 512;
      expect(shaderX).toBe(o.worldX + 512);
      expect(shaderY).toBe(o.worldY + 1024);
      expect(view).toMatchObject({
        camZ: 1,
        edgeNoise: true,
        materialTextures: true,
        engineTerrain: true,
      });
    },
  );

  it("finishes real OSD-style jobs asynchronously, at 1:1 even for coarse tiles", async () => {
    await ensureGLTerrain(deps, opts().gen);
    const source = createGLTerrainTileSource(opts());
    const { context, done } = job(source, 0);
    expect(context.finish).not.toHaveBeenCalled();
    expect(await done).toMatchObject({ width: 1, height: 1 });
    expect(context.fail).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ camZ: 1, width: 8, height: 8 }),
    );
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("settles cancelled-generation jobs instead of hanging the image loader", async () => {
    await ensureGLTerrain(deps, opts().gen);
    const source = createGLTerrainTileSource(opts());
    const { context, done } = job(source);
    clearGLTerrain();
    expect(await done).toContain("cancelled");
    expect(context.fail).toHaveBeenCalledTimes(1);
    expect(context.finish).not.toHaveBeenCalled();
  });

  it("does not upload an obsolete generation after a delayed atlas fetch", async () => {
    let release!: () => void;
    const pending = ensureGLTerrain(
      {
        ...deps,
        initMaterialAtlas: () =>
          new Promise<void>((r) => {
            release = r;
          }),
      },
      opts().gen,
    );
    clearGLTerrain();
    release();
    expect(await pending).toBe(false);
    expect(resourceBuild).not.toHaveBeenCalled();
  });

  it("reports unavailable textures rather than caching blank tiles", async () => {
    const failure = vi.fn();
    window.addEventListener("fullPixelTerrainError", failure);
    expect(
      await ensureGLTerrain(
        {
          ...deps,
          initMaterialAtlas: async () => {
            throw new Error("missing atlas");
          },
        },
        opts().gen,
      ),
    ).toBe(false);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(resourceBuild).not.toHaveBeenCalled();
  });
});
