import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBakedDZIsToOSD,
  probeBakedDZIs,
} from "../src/telescope/baked-dzi-loader";
import { TERRAIN_VERSION } from "../src/telescope/terrain-policy";
import { getDailyBakeStatus } from '../src/telescope/daily-bake-status';
import {
  isGLTerrainEnabled,
  isInstantTerrainEnabled,
  setFullPixelTerrainForBake,
} from "../src/renderer_settings";
afterEach(() => {
  setFullPixelTerrainForBake(false);
  vi.unstubAllGlobals();
});
describe("baked DZI rendering", () => {
  it('allows live NG+1 before publication and keeps partial or previously seen bakes out of the generator', async () => {
    const seed = 117, missing = { ok: false };
    const fetcher = vi.fn(async (_url: string): Promise<any> => missing);
    vi.stubGlobal('fetch', fetcher);
    const probe = () => probeBakedDZIs('ng-plus-daily', seed);
    expect(await probe()).toMatchObject({ baked: false, unpublishedNGPlus: true });
    const manifest = (url: string) => {
      const world = new URL(url).hostname.split('.')[0].split('-').at(-1)!;
      const pw = ['left', 'middle', 'right'].indexOf(world) - 1;
      return { ok: true, json: async () => ({ seed, world, gameMode: 'normal', ngPlus: 1,
        complete: true, baked: true, renderId: 'first-ng-plus', terrainVersion: TERRAIN_VERSION,
        regions: [{ pw, dzi: 'map.dzi', minX: [-53760, -16384, 16384][pw + 1], minY: -31744,
          fullW: pw ? 37376 : 32768, fullH: 73728 }] }) };
    };
    fetcher.mockImplementation(async url => url.includes('middle') ? manifest(url) : missing);
    expect(await probe()).toEqual({ baked: false, reason: expect.any(String) });
    fetcher.mockImplementation(async url => manifest(url));
    const ready = await probe();
    expect(ready).toMatchObject({ baked: true, prefix: 'ng-plus-daily', placements: [
      { x: -53760, width: 37376 }, { x: -16384, width: 32768 }, { x: 16384, width: 37376 },
    ] });
    fetcher.mockResolvedValue(missing);
    expect(await probe()).toEqual({ baked: false, reason: expect.any(String) });
    expect(await probeBakedDZIs('ng-plus-daily', seed + 1)).toMatchObject({ baked: false, unpublishedNGPlus: true });
  });

  it.each([0, 1])('clips only obsolete final crystals in a regular bake with crystal version %i', async version => {
    const worlds = ['left','middle','right'];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pw = worlds.indexOf(new URL(url).hostname.split('-')[1].split('.')[0]) - 1;
      return { ok: true, json: async () => ({ seed: 499625176, baked: true, templeCrystalVersion: version,
        regions: [{ pw, dzi: 'map.dzi', minX: pw * 35840 - 17920, minY: -31744, fullW: 35840 }] }) };
    }));
    const result = await probeBakedDZIs('daily', 499625176);
    if (!result.baked) throw Error(result.reason);
    for (const placement of result.placements) {
      const item = { source: {}, getContentSize: () => ({ x: 35840, y: 73728 }), setCroppingPolygons: vi.fn() };
      addBakedDZIsToOSD({ addTiledImage: (args: any) => args.success({ item }) }, [placement]);
      if (version) { expect(item.setCroppingPolygons).not.toHaveBeenCalled(); continue; }
      const [outer, ...holes] = item.setCroppingPolygons.mock.calls[0][0];
      expect(outer).toEqual([{x:0,y:0},{x:35840,y:0},{x:35840,y:73728},{x:0,y:73728}]);
      expect(holes).toHaveLength(placement.pw === 0 ? 1 : 2);
      for (const hole of holes) {
        const [topLeft,bottomLeft,bottomRight,topRight] = hole;
        expect(bottomRight.x - topLeft.x).toBe(8);
        expect(bottomRight.y - topLeft.y).toBe(14);
        expect(bottomLeft.x).toBe(topLeft.x); expect(topRight.y).toBe(topLeft.y);
      }
      expect(holes.map(([p]: [{x: number; y: number}]) => [p.x+4+placement.x,p.y+7+placement.y]))
        .toEqual(placement.pw === 0 ? [[1830,13108]] : [[placement.pw*35840+2280,13226],[placement.pw*35840+1830,13108]]);
    }
  });

  it.each(['valid', 'preserved', 'absent', 'stale', 'missing-file-name', 'oversized'])(
    'keeps Daily usable with a %s optional liquid mask, without fetching masks on startup', async mode => {
      const sha256 = 'a'.repeat(64), renderId = 'seed-render-liquid1';
      const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
        seed: 901, complete: true, baked: true, terrainVersion: TERRAIN_VERSION, renderId,
        liquidMask: mode === 'absent' ? undefined : { version: 1, seed: mode === 'stale' ? 900 : 901,
          capturedVersion: mode === 'preserved' ? 1 : undefined,
          renderId, path: mode === 'missing-file-name' ? '../secret.bin' : 'liquid-mask.bin',
          bytes: mode === 'oversized' ? 26 * 1024 * 1024 : 512, sha256 },
        regions: [{ pw: 0, dzi: 'map.dzi', minX: -17920, minY: -31744, fullW: 35840 }],
      }) }));
      vi.stubGlobal('fetch', fetcher);
      const result = await probeBakedDZIs('daily', 901);
      expect(result.baked).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3);
      if (result.baked) for (const placement of result.placements) {
        if (mode === 'valid' || mode === 'preserved') expect(placement.liquidMask).toMatchObject({
          url: expect.stringContaining(`/liquid-mask.bin?v=${sha256}`), bytes: 512, sha256,
          preservesCapturedFluids: mode === 'preserved',
        });
        else expect(placement.liquidMask).toBeUndefined();
      }
    });
  it.each(['missing', 'stale', 'invalid', 'network'])(
    'reports an unavailable bake when a world manifest is %s', async failure => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (failure === 'network') throw new TypeError('Network unavailable');
        return {
          ok: failure !== 'missing',
          json: async () => failure === 'invalid' ? {} : { seed: 900, regions: [{}] },
        };
      }));
      expect((await probeBakedDZIs('daily', 901)).baked).toBe(false);
      expect(getDailyBakeStatus('daily', 901)).toBe('unavailable');
      expect(getDailyBakeStatus('daily', 900)).toBeNull();
    },
  );

  it('does not report a cancelled probe as a failed daily bake', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      throw new DOMException('Cancelled', 'AbortError');
    }));
    await probeBakedDZIs('daily', 902, controller.signal);
    expect(getDailyBakeStatus('daily', 902)).toBe('unknown');
  });

  it('keeps a successful retry when an older probe fails later', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { await waiting; return { ok: false }; }));
    const old = probeBakedDZIs('daily', 903);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      seed: 903, regions: [{ pw: 0, dzi: 'map.dzi', minX: 0, minY: 0, fullW: 35840 }],
    }) })));
    await probeBakedDZIs('daily', 903);
    release();
    await old;
    expect(getDailyBakeStatus('daily', 903)).toBe('ready');
  });

  it.each(["daily", "previous-daily"] as const)(
    "loads published %s bakes independently of the live GPU cache revision",
    async (prefix) => {
      vi.stubGlobal("window", {
        location: { hostname: "localhost", search: "?terrain=gpu" },
      });
      // The deployed CPU baker currently publishes v9. A newer live renderer
      // revision must not turn an available daily bake into local generation.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const world = url.match(/-(left|middle|right)\./)![1];
          const pw = { left: -1, middle: 0, right: 1 }[world]!;
          return {
            ok: true,
            json: async () => ({
              seed: 239365546,
              world,
              terrainVersion: "full-pixel-v9",
              complete: true,
              baked: true,
              generatedAt: "2026-09-28T00:07:46.454Z",
              regions: [{
                pw,
                dzi: "map.dzi",
                minX: -17920 + pw * 35840,
                minY: -31744,
                fullW: 35840,
                fullH: 73728,
              }],
            }),
          };
        }),
      );
      expect(isInstantTerrainEnabled()).toBe(true);
      expect(isGLTerrainEnabled()).toBe(false);
      const result = await probeBakedDZIs(prefix, 239365546);
      expect(result.baked).toBe(true);
      expect(getDailyBakeStatus(prefix, 239365546)).toBe('ready');
      if (result.baked) {
        expect(result.decorationsBaked).toBe(true);
        expect(result.placements.map(p => p.pw)).toEqual([-1, 0, 1]);
        expect(result.placements.map(p => p.dziUrl)).toEqual(
          ["left", "middle", "right"].map(world =>
            `https://${prefix}-${world}.acidflow.stream/map.dzi`),
        );
        // This flag certifies the current renderer's pixels, not whether the
        // independently published daily map is usable.
        expect(result.fullPixelsBaked).toBe(false);
      }
    },
  );

  it("preserves alpha and all mip levels on the baked overlay", () => {
    const source: Record<string, any> = { minLevel: 0 };
    addBakedDZIsToOSD(
      {
        addTiledImage(options: any) {
          options.success({ item: { source } });
        },
      },
      [
        {
          pw: 0,
          dziUrl: "https://daily-middle.acidflow.stream/map.dzi",
          x: 0,
          y: 0,
          width: 35840,
          bust: "today",
        },
      ],
    );
    expect(source.hasTransparency()).toBe(true);
    expect(source.minLevel).toBe(0);
    expect(source.__bakedDzi).toBe(true);
    expect(source.queryParams).toBe("?v=today");
  });
  it.each(["0", "1"])(
    "uses completed full-pixel bakes with live rendering disabled, ignoring old preference (%s)",
    async (preference) => {
      vi.stubGlobal("localStorage", { getItem: () => preference });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            seed: 123,
            terrainVersion: TERRAIN_VERSION,
            complete: true,
            baked: true,
            regions: [
              {
                pw: 0,
                dzi: "map.dzi",
                minX: 0,
                minY: 0,
                fullW: 35840,
                fullH: 73728,
              },
            ],
          }),
        })),
      );
      const result = await probeBakedDZIs("daily", 123);
      expect(result.baked).toBe(true);
      expect(isGLTerrainEnabled()).toBe(false);
      if (result.baked) {
        expect(result.decorationsBaked).toBe(true);
        expect(result.fullPixelsBaked).toBe(true);
      }
    },
  );
  it("does not label legacy or mixed daily worlds as already full-pixel", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "0" });
    for (const legacy of [
      {},
      { complete: false, terrainVersion: TERRAIN_VERSION },
      { complete: true, terrainVersion: "obsolete-renderer" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: true,
          json: async () => ({
            seed: 123,
            baked: true,
            regions: [{ pw: 0, dzi: "map.dzi" }],
            ...(url.includes("-left.")
              ? legacy
              : { complete: true, terrainVersion: TERRAIN_VERSION }),
          }),
        })),
      );
      const result = await probeBakedDZIs("previous-daily", 123);
      expect(result.baked).toBe(true);
      if (result.baked) expect(result.fullPixelsBaked).toBe(false);
    }
  });
  it("marks a completed previous-daily map full-pixel as well", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "0" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          seed: 123,
          baked: true,
          complete: true,
          terrainVersion: TERRAIN_VERSION,
          regions: [{ pw: 0, dzi: "map.dzi" }],
        }),
      })),
    );
    const result = await probeBakedDZIs("previous-daily", 123);
    expect(result.baked && result.fullPixelsBaked).toBe(true);
  });
  it("rejects coarse or incomplete bakes in explicit offline full-pixel mode", async () => {
    setFullPixelTerrainForBake(true);
    for (const incomplete of [
      {},
      { terrainVersion: TERRAIN_VERSION, complete: false },
      { terrainVersion: "full-pixel-v9", complete: true },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            seed: 123,
            ...incomplete,
            regions: [{ dzi: "map.dzi" }],
          }),
        })),
      );
      expect((await probeBakedDZIs("daily", 123)).baked).toBe(false);
    }
  });
  it.each(["missing", "wrong-seed"])(
    "leaves approximate generation selected when a daily world is %s",
    async (failure) => {
      vi.stubGlobal("localStorage", { getItem: () => "1" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: !(failure === "missing" && url.includes("-right.")),
          json: async () => ({
            seed:
              failure === "wrong-seed" && url.includes("-right.") ? 456 : 123,
            baked: true,
            complete: true,
            terrainVersion: TERRAIN_VERSION,
            regions: [{ pw: 0, dzi: "map.dzi" }],
          }),
        })),
      );
      expect((await probeBakedDZIs("daily", 123)).baked).toBe(false);
      expect(isGLTerrainEnabled()).toBe(false);
    },
  );
});
