// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeScenePOIs } from "../src/telescope/scene-pois";
import { hydrateBakedGeneration, serializeGenerationForBake } from "../src/telescope/baked-generation";
import { getCachedGeneration } from "../src/telescope/tile-cache";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import fixture from "./fixtures/search/786433191-meditation-cube.json";

const expectedCube = { item: "meditation_cube", x: -357, y: 1626.5, clickOnly: true };
const cube = (result: typeof fixture) => result.poisByPW["0,0"].find((p) => p.item === "meditation_cube");
afterEach(() => vi.unstubAllGlobals());

describe("scene-backed POIs", () => {
  it("anchors seed 786433191's cube to its actual scene, not the portal above it", () => {
    const before = structuredClone(fixture);
    const result = normalizeScenePOIs(fixture);
    expect(cube(result)).toMatchObject(expectedCube);
    expect(getAllPOIsFlat(result).filter((p) => p.item === "meditation_cube")).toMatchObject([
      { worldX: -357, worldY: 1626.5, clickOnly: true },
    ]);
    expect(result.poisByPW["0,0"][1]).toBe(fixture.poisByPW["0,0"][1]); // chamber untouched
    expect(fixture).toEqual(before); // don't rewrite old caches/metadata in place
    expect(normalizeScenePOIs(result)).toBe(result); // never move it again
  });

  it("handles multiple cubes and world offsets without matching a scene in another plane", () => {
    const portal = fixture.poisByPW["0,0"][0];
    const scene = fixture.pixelScenesByPW["0,0"][0];
    const result = normalizeScenePOIs({
      poisByPW: {
        "0,0": [portal, { ...portal, x: portal.x+512, y:portal.y+512 }],
        "1,-1": [{ ...portal, x: portal.x+35840, y:portal.y-24576 }],
        "-1,0": [{ ...portal }],
      },
      pixelScenesByPW: {
        "0,0": [scene, { ...scene, x:scene.x+512,y:scene.y+512 }],
        "1,-1": [{ ...scene,x:scene.x+35840,y:scene.y-24576 }],
      },
    });
    expect(result.poisByPW["0,0"][0]).toMatchObject(expectedCube);
    expect(result.poisByPW["0,0"][1]).toMatchObject({ x:155,y:2138.5,clickOnly:true });
    expect(result.poisByPW["1,-1"][0]).toMatchObject({ x:35483,y:-22949.5,clickOnly:true });
    expect(result.poisByPW["-1,0"][0]).toEqual(portal);
  });

  it("keeps the sprite fallback when no corresponding cube scene exists", () => {
    const candidates: Array<Record<string, typeof fixture.pixelScenesByPW["0,0"]> | undefined> = [undefined, {}, { "0,0": [fixture.pixelScenesByPW["0,0"][1]] }];
    for (const pixelScenesByPW of candidates) {
      const result = { ...fixture, pixelScenesByPW };
      expect(normalizeScenePOIs(result)).toBe(result);
    }
    const wrongLocation = { ...fixture, poisByPW:{"0,0":[{...fixture.poisByPW["0,0"][0],x:999}]}};
    expect(normalizeScenePOIs(wrongLocation)).toBe(wrongLocation);
  });

  it("repairs old baked metadata and survives another serialize/hydrate round trip", () => {
    const legacy = {
      ...fixture, ngPlus:0, isNGP:false, worldSize:70, parallelWorlds:[0], tileLayers:[], eyes:undefined,
      biomeData:{pixels:new Uint32Array(70*48)},
    };
    const baked = serializeGenerationForBake(legacy as any)!;
    expect(baked.poisByPW["0,0"][0].y).toBe(1567); // an old bake, not pre-normalized
    const hydrated = hydrateBakedGeneration([baked]);
    expect(hydrated.poisByPW["0,0"][0]).toMatchObject(expectedCube);
    expect(hydrateBakedGeneration([serializeGenerationForBake(hydrated)!]).poisByPW["0,0"][0]).toMatchObject(expectedCube);
  });

  it("repairs old IndexedDB generation data on read without invalidating all seed caches", async () => {
    const entry = {
      ...structuredClone(fixture), cacheKey:"786433191-all", timestamp:Date.now(), ngPlus:0, isNGP:false,
      worldSize:70, parallelWorlds:[0], tileLayers:[], biomeDataPixels:new ArrayBuffer(0),
    };
    const request = (result: unknown) => {
      const req: any = { result };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const db = { close:vi.fn(), transaction:()=>({ objectStore:()=>({ get:()=>request(entry) }) }) };
    vi.stubGlobal("indexedDB", { open:()=>request(db) });
    const result = await getCachedGeneration("786433191-all");
    expect(result?.poisByPW["0,0"][0]).toMatchObject(expectedCube);
    expect(entry.poisByPW["0,0"][0].y).toBe(1567);
  });
});
