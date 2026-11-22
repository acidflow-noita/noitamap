import { expect, it, vi } from "vitest";
import { probeBakedDZIs } from "../src/telescope/baked-dzi-loader";
import { TERRAIN_VERSION } from "../src/telescope/terrain-policy";
import catalog from "../src/data/tilesources.json";
import { bakedWorldMembers, bakedWorldSpan, captureWorlds, visibleWorldSpan } from "../src/telescope/world-coverage";
import { finalizeGeneration } from "../src/telescope/finalize-generation";
import { createBakedWorldMetadata } from "../build_scripts/baked-world-metadata.mjs";

it("covers each captured column exactly once using each physical world's real coordinates", () => {
  const headers = catalog["nightmare-dynamic-main-branch"].map(row => JSON.parse(row.dziContent).Image);
  const left = Math.min(...headers.map(h => Number(h.TopLeft.X)));
  const right = Math.max(...headers.map(h => Number(h.TopLeft.X) + Number(h.Size.Width)));
  expect([left, right]).toEqual([-53760, 53760]);
  const live = captureWorlds("nightmare").sort((a, b) => a - b).map(pw => visibleWorldSpan(pw, 32768, "nightmare"));
  const baked = [-1, 0, 1].map(pw => bakedWorldSpan(pw, 32768, "nightmare"));
  for (const parts of [live, baked]) {
    let x = left;
    for (const part of parts) {
      expect(part.minX).toBe(x);
      x += part.width;
    }
    expect(x).toBe(right);
  }
  expect(live.map(s => s.width)).toEqual([4608, 32768, 32768, 32768, 4608]);
  expect(baked.map(s => s.width)).toEqual([37376, 32768, 37376]);
  for (const [chunk, file, tile] of [[-100, 0, 5], [-101, 0, 4], [103, 2, 71], [104, 2, 72]]) {
    const page = baked[file];
    expect(page.minX + tile * 512).toBe(chunk * 512);
    expect(tile * 512).toBeLessThan(page.width);
  }
  expect(captureWorlds("normal")).toEqual([-1, 0, 1]);
  expect(bakedWorldSpan(-1, 35840, "normal")).toEqual({ minX: -53760, width: 35840 });
  expect(bakedWorldSpan(1, 32768, "ng-plus")).toEqual({ minX: 16384, width: 32768 });
});

it("keeps edge POIs in their true parallel world and retains scenes crossing a capture edge", () => {
  const at = (x: number) => ({ type: "item", x, y: 14336 });
  const gen = finalizeGeneration({ gameMode: "nightmare", worldSize: 64, worldCenter: 32, biomeData: { pixels: new Uint32Array() },
    poisByPW: { "-2,0": [at(-53761), at(-53760), at(-51200)], "2,0": [at(53759), at(53760)] },
    pixelScenesByPW: { "-2,0": [{ x: -53770, y: 0, width: 10 }, { x: -53770, y: 0, width: 20 }] },
  } as any);
  expect(gen.poisByPW["-2,0"].map((p: any) => p.x)).toEqual([-53760, -51200]);
  expect(gen.poisByPW["2,0"].map((p: any) => p.x)).toEqual([53759]);
  expect(gen.pixelScenesByPW["-2,0"].map((s: any) => s.width)).toEqual([20]);
});

it("ships the outer strips' searchable metadata on the matching side host", () => {
  const pws = captureWorlds("nightmare"), seed = 786433191;
  const records = Object.fromEntries(pws.map(pw => [[pw, 0].join(","), [{ x: pw * 32768, y: 0 }]]));
  const metadata = { version: 1, seed, gameMode: "nightmare", ngPlus: 0, isNGP: false, worldSize: 64, worldCenter: 32,
    biomeDataW: 64, biomeDataH: 48, biomeDataPixels: Buffer.alloc(64 * 48 * 4).toString("base64"),
    parallelWorlds: pws, poisByPW: records, pixelScenesByPW: records,
    reportInventory: { seed, version: 3, worlds: Object.fromEntries(pws.map(pw => [pw, { spells: {}, materials: {}, ukkos: {} }])) } };
  for (const [i, world] of ["left","middle","right"].entries()) {
    const out = createBakedWorldMetadata(metadata, world, seed);
    expect(out.parallelWorlds).toEqual(bakedWorldMembers(i - 1, "nightmare"));
    expect(Object.keys(out.poisByPW).sort()).toEqual(out.parallelWorlds.map((pw: number) => [pw, 0].join(",")).sort());
    expect(Object.keys(out.reportInventory.worlds).sort()).toEqual(out.parallelWorlds.map(String).sort());
  }
  expect(() => createBakedWorldMetadata({ ...metadata, parallelWorlds: [-1,0,1] }, "left", seed)).toThrow(/PW -2/);
});

it.each(["published", "wide", "mixed"])("handles %s Nightmare manifest geometry coherently", async kind => {
  const worlds = ["left", "middle", "right"];
  vi.stubGlobal("fetch", async (url: string) => {
    const world = worlds.find(name => url.includes("nightmare-" + name + "."))!;
    const pw = worlds.indexOf(world) - 1;
    const wide = kind === "wide" || (kind === "mixed" && pw === -1);
    const span = bakedWorldSpan(pw, 32768, wide ? "nightmare" : "normal");
    return { ok: true, json: async () => ({ world, seed: 786433191, gameMode: "nightmare", ngPlus: 0,
      baked: true, complete: true, terrainVersion: TERRAIN_VERSION, renderId: "edge-test",
      regions: [{ pw, dzi: "map.dzi", minX: span.minX, minY: -31744, fullW: span.width, fullH: 73728 }] }) };
  });
  try {
    const probe = await probeBakedDZIs("nightmare", 786433191);
    expect(probe.baked).toBe(kind !== "mixed");
    if (probe.baked) expect(probe.includesNightmareEdges).toBe(kind === "wide");
  } finally { vi.unstubAllGlobals(); }
});

it('gives the five overlapping Snowy Chasm chunks to the first Wang rectangle without resizing the later one', async () => {
  const { assignOverlappingWangChunks } = await import('../src/telescope/wang-region-ownership');
  const overlap: [number, number][] = [[8,8],[8,9],[7,9],[6,9],[5,9]];
  const regions: [number, number][][] = [[[4,6],[6,6],[14,9]], [...overlap,[8,10]]];
  const bounds: [number, number, number, number][] = [[4,5,14,9],[5,8,8,10]];
  assignOverlappingWangChunks(regions, bounds);
  expect(regions[0]).toEqual([[4,6],[6,6],[14,9],...overlap]);
  expect(regions[1]).toEqual([[8,10]]);
  expect(bounds[1]).toEqual([5,8,8,10]);
});

it('uses the three game material slices at their own biome and world coordinates', async () => {
  const { nightmarePitScenes, pitMaterialSlice } = await import('../src/telescope/nightmare-lava-pit');
  const { BIOME_BACKGROUND_MAP } = await import('../src/telescope/terrain-policy');
  const colors = new Uint32Array(64 * 48);
  colors.set([0xff77a5bd,0xff006c42,0xff3d3d3d],20 * 64 + 37);
  const scenes = nightmarePitScenes(colors,64,32,{0x77a5bd:'winter_caves',0x006c42:'wandcave',0x3d3d3d:'solid_wall'});
  expect(scenes.map(s => [s.x,s.y,s.width,s.height,s.variantKey])).toEqual([
    [2560,3072,512,512,'biome=winter_caves'],[3072,3072,512,512,'biome=wandcave'],[3584,3072,512,512,'biome=solid_wall'],
  ]);
  const sharp = (await import('sharp')).default;
  const file = new URL('../lib/noita-telescope-vm/data/pixel_scenes/spliced/lavalake_pit_bottom.png', import.meta.url);
  const { data,info } = await sharp(file.pathname).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  // The original image has only white density pixels and untouched black pixels.
  const counts = scenes.map((_, i) => {
    const rgba = pitMaterialSlice({data,width:info.width,height:info.height},i);
    let painted = 0;
    for(let j=0;j<rgba.length;j+=4) {
      if (rgba[j] !== rgba[j+3]) throw Error('Unexpected material alpha in lava pit splice');
      if(rgba[j+3]) painted++;
    }
    return painted;
  });
  expect(counts).toEqual([25253,35145,36194]);
  expect(BIOME_BACKGROUND_MAP.winter_caves).toBe('data/weather_gfx/background_cave_04_alt.png');
});
