import { describe, expect, it, vi } from "vitest";
import { TerrainFrameController, visibleTerrainTiles, type TerrainRegion } from "../src/telescope/terrain-viewport";

const region: TerrainRegion = {
  x: -17920, y: -7168, width: 35840, height: 24576,
  source: { maxLevel: 16, getFinalTile: vi.fn() },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("completed terrain viewport frames", () => {
  it("requests only the visible level, without OSD overview ancestors", () => {
    const tiles = visibleTerrainTiles(region, { x: -731, y: 7049, width: 1202, height: 800 }, 1);
    expect(tiles.length).toBeLessThanOrEqual(12);
    expect(new Set(tiles.map(t => t.level))).toEqual(new Set([16]));
    for (const tile of tiles) {
      expect(tile.worldX + 512).toBeGreaterThan(-731);
      expect(tile.worldX).toBeLessThan(-731 + 1202);
    }
  });
  it("uses exact reductions without disabling any passes at small zoom", () => {
    const tiles = visibleTerrainTiles(region, { x: -731, y: 7049, width: 1202, height: 800 }, 0.125);
    expect(new Set(tiles.map(t => t.level))).toEqual(new Set([13]));
    expect(tiles.every(t => t.scale === 8)).toBe(true);
  });
  it("limits CPU fallback to visible native leaves at the reported overview zoom", () => {
    const width = 2 ** 13.69, bounds = { x: -3060 - width / 2, y: 3548 - width * 9 / 32, width, height: width * 9 / 16 };
    const tiles = visibleTerrainTiles({ ...region, nativeOnly: true }, bounds, 1024 / width);
    expect(new Set(tiles.map(t => t.level))).toEqual(new Set([region.source.maxLevel]));
    for (const tile of tiles) {
      expect(tile.worldX + 512).toBeGreaterThan(bounds.x);
      expect(tile.worldX).toBeLessThan(bounds.x + width);
      expect(tile.worldY + 512).toBeGreaterThan(bounds.y);
      expect(tile.worldY).toBeLessThan(bounds.y + bounds.height);
    }
  });
  it("does not request offscreen parallel or vertical worlds", () => {
    const bounds = { x: -1000, y: 1000, width: 1000, height: 1000 };
    expect(visibleTerrainTiles({ ...region, x: region.x + region.width }, bounds, 1)).toEqual([]);
    expect(visibleTerrainTiles({ ...region, y: region.y + region.height }, bounds, 1)).toEqual([]);
  });
  it("publishes only completed current frames, even when cancelled work resolves late", async () => {
    const first = deferred<string>(), second = deferred<string>();
    const signals: AbortSignal[] = [], publish = vi.fn(), error = vi.fn();
    const renderer = new TerrainFrameController<number, string>((view, signal) => {
      signals.push(signal); return view === 1 ? first.promise : second.promise;
    }, publish, error);
    const a = renderer.request(1), b = renderer.request(2);
    expect(signals[0].aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    second.resolve("final second frame"); await b;
    first.resolve("stale frame"); await a;
    expect(publish.mock.calls).toEqual([["final second frame", 2]]);
    expect(error).not.toHaveBeenCalled();
  });
  it("reports real errors and prevents publication after a seed is disposed", async () => {
    const failure = new Error("GPU lost"), error = vi.fn(), publish = vi.fn();
    const pending = deferred<string>();
    const renderer = new TerrainFrameController<number, string>(view => view === 1 ? Promise.reject(failure) : pending.promise, publish, error);
    await renderer.request(1);
    expect(error).toHaveBeenCalledWith(failure);
    const last = renderer.request(2);
    renderer.dispose(); pending.resolve("old seed"); await last;
    expect(publish).not.toHaveBeenCalled();
  });
});
