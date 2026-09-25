import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTerrainTileAdmission,
  installTerrainAdmission,
} from "../src/osd-terrain-admission";

class Events {
  handlers = new Map<string, Set<(event: any) => void>>();
  addHandler(name: string, handler: (event: any) => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  removeHandler(name: string, handler: (event: any) => void) {
    this.handlers.get(name)?.delete(handler);
  }
  raiseEvent(name: string, event: any = {}) {
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
}

function fixture() {
  vi.useFakeTimers();
  const world = new Events() as any,
    viewer = new Events() as any;
  viewer.world = world;
  let area = { x: 0, y: 0, width: 1, height: 1 };
  const started: any[] = [];
  const item = {
    source: {
      __instantTerrain: true,
      getClosestLevel: () => 8,
      getPixelRatio: (level: number) => ({ x: 2 ** (10 - level) }),
      hasCachedTile: (tile: any) => !!tile.cached,
    },
    getBounds: () => ({ width: 1 }),
    getDrawArea: () => ({ getBoundingBox: () => area }),
    getLoadArea: () => ({ getBoundingBox: () => area }),
    viewport: { deltaPixelsFromPointsNoRotate: (point: any) => point },
    _loadTile: (tile: any) => {
      started.push(tile);
      tile.loading = true;
    },
  };
  world.getItemCount = () => 1;
  world.getItemAt = () => item;
  const original = item._loadTile,
    dispose = installTerrainAdmission(viewer);
  const tile = (x: number, level = 10, cached = false) => ({
    level,
    x,
    y: 0,
    cached,
    exists: true,
    loaded: false,
    loading: false,
    bounds: { x, y: 0.1, width: 0.1, height: 0.1 },
  });
  return {
    viewer,
    world,
    item,
    tile,
    original,
    dispose,
    started,
    pan(x: number) {
      area = { ...area, x };
      viewer.raiseEvent("pan");
    },
    async finish(tile: any) {
      tile.loading = false;
      tile.loaded = true;
      viewer.raiseEvent("tile-loaded", { tile, promise: Promise.resolve() });
      await vi.advanceTimersByTimeAsync(1);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("generated tile admission before timed ImageJobs", () => {
  it("admits only two cold tiles while cached tiles bypass occupied render slots", async () => {
    const f = fixture();
    try {
      const cold = [0.1, 0.3, 0.5].map((x) => f.tile(x));
      for (const tile of cold) f.item._loadTile(tile);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.started).toHaveLength(2);
      const cached = f.tile(0.7, 10, true);
      f.item._loadTile(cached);
      expect(f.started).toHaveLength(3);
      expect(f.viewer.terrainAdmissionStats).toMatchObject({
        active: 2,
        queued: 1,
        cached: 1,
      });
      await f.finish(f.started[0]);
      expect(f.started).toHaveLength(4);
      expect(f.viewer.terrainAdmissionStats).toMatchObject({
        active: 2,
        queued: 0,
      });
    } finally {
      f.dispose();
    }
  });

  it("discards obsolete unstarted demand without marking tiles missing and admits the new camera first", async () => {
    const f = fixture();
    try {
      const cold = [0.1, 0.3, 0.5].map((x) => f.tile(x));
      for (const tile of cold) f.item._loadTile(tile);
      await vi.advanceTimersByTimeAsync(1);
      const queued = cold.find((tile) => !f.started.includes(tile))!;
      const ticket = getTerrainTileAdmission(queued)!;
      const cancelled = expect(ticket.started).rejects.toMatchObject({
        name: "AbortError",
      });
      const fail = vi.fn();
      f.viewer.addHandler("tile-load-failed", fail);
      f.pan(10);
      const current = f.tile(10.4);
      f.item._loadTile(current);
      await vi.advanceTimersByTimeAsync(1);
      await cancelled;
      expect(queued).toMatchObject({ loading: false, exists: true });
      expect(fail).not.toHaveBeenCalled();
      await f.finish(f.started[0]);
      expect(f.started.at(-1)).toBe(current);
    } finally {
      f.dispose();
    }
  });

  it("keeps explicitly retained offscreen coverage queued and releases it when the plan expires", async () => {
    const f = fixture();
    try {
      for (const x of [0.2, 0.4]) f.item._loadTile(f.tile(x));
      await vi.advanceTimersByTimeAsync(1);
      const background = f.tile(10);
      f.item._loadTile(background);
      const ticket = getTerrainTileAdmission(background)!;
      const release = ticket.retain(() => true);
      await vi.advanceTimersByTimeAsync(40000);
      expect(f.viewer.terrainAdmissionStats).toMatchObject({
        active: 2,
        queued: 1,
      });
      expect(background.loading).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(background).toMatchObject({ loading: false, exists: true });
      expect(getTerrainTileAdmission(background)).toBeUndefined();
    } finally {
      f.dispose();
    }
  });

  it("frees slots on genuine failure and restores the original loader on removal", async () => {
    const f = fixture();
    try {
      for (const x of [0.2, 0.4, 0.6]) f.item._loadTile(f.tile(x));
      await vi.advanceTimersByTimeAsync(1);
      f.viewer.raiseEvent("tile-load-failed", {
        tile: f.started[0],
        message: "Real render failure",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.started).toHaveLength(3);
      f.world.raiseEvent("remove-item", { item: f.item });
      expect(f.item._loadTile).toBe(f.original);
      expect(f.viewer.terrainAdmissionStats).toMatchObject({
        active: 0,
        queued: 0,
      });
    } finally {
      f.dispose();
    }
  });
});
