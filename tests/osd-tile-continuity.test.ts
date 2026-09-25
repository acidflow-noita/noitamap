import { describe, expect, it, vi } from 'vitest';
import { installTileContinuity, protectTileContinuity } from '../src/osd-tile-continuity';

class Events {
  handlers = new Map<string, Set<(event: any) => void>>();
  addHandler(name: string, handler: (event: any) => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  removeHandler(name: string, handler: (event: any) => void) { this.handlers.get(name)?.delete(handler); }
  raiseEvent(name: string, event = {}) { for (const handler of this.handlers.get(name) ?? []) handler(event); }
}

function tile(level = 12, bounds = { x: 0, y: 0, width: 1, height: 1 }) {
  return { level, bounds, loaded: true, opacity: 1, beingDrawn: false, squaredDistance: 0 };
}

function image(tiles: any[]) {
  const item: any = {
    scale: 1, frameTiles: tiles, opacity: 1, minPixelRatio: .5,
    discardLevelsBelowDownsampleRatio: 1, _scaleSpring: { current: { value: 1 } },
    source: { minLevel: 0, maxLevel: 12, tileOverlap: 0,
      getPixelRatio: (level: number) => ({ x: 2 ** (12 - level) }) },
    viewport: {
      deltaPixelsFromPointsNoRotate: (point: any) => ({ x: point.x * item.scale }),
      getCenter: () => ({ x: 0, y: 0 }), pixelFromPoint: (point: any) => point,
    },
    area: { x: 0, y: 0, width: 1, height: 1 },
    getDrawArea: () => item.area && { getBoundingBox: () => item.area },
    _loadTile: vi.fn(), _positionTile: vi.fn(), _lastDrawn: [],
    getTilesToDraw() {
      for (const info of this._lastDrawn) info.tile.beingDrawn = false;
      this._lastDrawn = this.frameTiles.map((tile: any) => {
        tile.beingDrawn = true;
        return { tile, level: tile.level };
      });
      return this._lastDrawn;
    },
  };
  return item;
}

function viewer(items: any[]) {
  const result: any = new Events();
  result.world = new Events();
  result.world.getItemCount = () => items.length;
  result.world.getItemAt = (index: number) => items[index];
  return result;
}

describe('bounded OSD detail continuity references', () => {
  it('keeps the entire visible old tile until useful replacement covers all of it', () => {
    const fine = tile(), item = image([fine]);
    const release = protectTileContinuity(item);
    item.getTilesToDraw();
    item.scale = .25;
    // A tiny fully-loaded overview is coverage, but not a useful replacement.
    const overview = tile(8), half = tile(10, { x: 0, y: 0, width: .5, height: 1 });
    item.frameTiles = [overview, half];
    expect(item.getTilesToDraw().map((info: any) => info.tile)).toEqual([overview, half, fine]);
    expect(item._positionTile).toHaveBeenCalledWith(fine, 0, item.viewport, { x: 0, y: 0 }, undefined);
    const rest = tile(10, { x: .5, y: 0, width: .5, height: 1 });
    item.frameTiles = [half, rest];
    expect(item.getTilesToDraw().map((info: any) => info.tile)).toEqual([half, rest]);
    expect(fine.beingDrawn).toBe(false);
    expect(item._loadTile).not.toHaveBeenCalled();
    release();
  });

  it('releases unloaded and offscreen references without reloading fine tiles', () => {
    const left = tile(12, { x: 0, y: 0, width: .5, height: 1 });
    const right = tile(12, { x: .5, y: 0, width: .5, height: 1 });
    const item = image([left, right]), release = protectTileContinuity(item);
    item.getTilesToDraw(); item.scale = .25; item.frameTiles = [];
    expect(item.getTilesToDraw()).toHaveLength(2);
    left.loaded = false;
    item.area = { x: 0, y: 0, width: .4, height: 1 };
    expect(item.getTilesToDraw()).toHaveLength(0);
    expect(left.beingDrawn || right.beingDrawn).toBe(false);
    item.area = { x: 0, y: 0, width: 1, height: 1 };
    expect(item.getTilesToDraw()).toHaveLength(0);
    expect(item._loadTile).not.toHaveBeenCalled();
    release();
  });

  it('retains two overlapping FHD layers with 135 tiles each at the normal shared budget', () => {
    const grid = () => Array.from({ length: 135 }, (_, i) => tile(12,
      { x: (i % 15) / 15, y: Math.floor(i / 15) / 9, width: 1 / 15, height: 1 / 9 }));
    const layers = [image(grid()), image(grid())], owner = viewer(layers);
    const release = installTileContinuity(owner);
    for (const item of layers) item.getTilesToDraw();
    for (const item of layers) {
      item.scale = .25; item.frameTiles = [];
      expect(item.getTilesToDraw()).toHaveLength(135);
      expect(item._loadTile).not.toHaveBeenCalled();
    }
    release();
    for (const item of layers) expect(item._lastDrawn.every((info: any) => !info.tile.beingDrawn)).toBe(true);
  });

  it('bounds rediscovered cache pixels and excludes unloaded/processing data without requesting tiles', () => {
    const cached = Array.from({ length: 20 }, () => tile());
    const item = image([]);
    item.blendTime = 0;
    // Preloaded pixels can be ready before their first draw sets opacity.
    for (const entry of cached) entry.opacity = 0;
    const pending = { ...tile(), processing: true }, unloaded = { ...tile(), loaded: false };
    item._tileCache = { getLoadedTilesFor: vi.fn(() => [pending, unloaded, ...cached]) };
    const release = protectTileContinuity(item, { maxTiles: 3 });
    item.scale = .25;
    const drawn = item.getTilesToDraw();
    expect(drawn).toHaveLength(3);
    expect(drawn.every((info: any) => cached.includes(info.tile))).toBe(true);
    expect(cached.filter(entry => entry.beingDrawn)).toHaveLength(3);
    expect(pending.beingDrawn || unloaded.beingDrawn).toBe(false);
    expect(item._tileCache.getLoadedTilesFor).toHaveBeenCalledWith(item);
    expect(item._loadTile).not.toHaveBeenCalled();
    const replacement = tile(10);
    item.frameTiles = [replacement];
    expect(item.getTilesToDraw().map((info: any) => info.tile)).toEqual([replacement]);
    // A completed normal view does not scan the entire shared cache again.
    expect(item._tileCache.getLoadedTilesFor).toHaveBeenCalledTimes(1);
    expect(cached.some(entry => entry.beingDrawn)).toBe(false);
    release();
    expect(cached.some(entry => entry.beingDrawn)).toBe(false);
  });

  it('shares a strict budget and removes pins/handlers on image removal and viewer destruction', () => {
    const layers = [image(Array.from({ length: 4 }, () => tile())), image(Array.from({ length: 4 }, () => tile()))];
    const original = layers.map(item => item.getTilesToDraw), owner = viewer(layers);
    installTileContinuity(owner, { maxTiles: 6 });
    for (const item of layers) item.getTilesToDraw();
    for (const item of layers) { item.scale = .25; item.frameTiles = []; }
    expect(layers[0].getTilesToDraw().length + layers[1].getTilesToDraw().length).toBe(6);
    const firstRetained = [...layers[0]._lastDrawn];
    owner.world.raiseEvent('remove-item', { item: layers[0] });
    expect(layers[0].getTilesToDraw).toBe(original[0]);
    expect(firstRetained.every(info => !info.tile.beingDrawn)).toBe(true);
    const secondRetained = [...layers[1]._lastDrawn];
    owner.raiseEvent('before-destroy');
    expect(layers[1].getTilesToDraw).toBe(original[1]);
    expect(secondRetained.every(info => !info.tile.beingDrawn)).toBe(true);
    expect(owner.world.handlers.get('add-item').size).toBe(0);
    expect(owner.world.handlers.get('remove-item').size).toBe(0);
    expect(owner.handlers.get('before-destroy').size).toBe(0);
  });
});
