/**
 * marker-tile-source.ts
 *
 * Custom OpenSeadragon TileSource that renders POI markers from a spritesheet
 * onto tile canvases. Uses a Flatbush spatial index to efficiently find which
 * markers fall within each tile's bounds.
 */

import type { MarkerData } from "./poi-spatial-index";

declare const OpenSeadragon: any;

/**
 * Create a MarkerTileSource instance.
 */
export function createMarkerTileSource(
  markerData: MarkerData,
  opts: {
    /** Full width of the OSD coordinate space (pixels). */
    width: number;
    /** Full height of the OSD coordinate space (pixels). */
    height: number;
    /** Maximum zoom level (read from biome layers). */
    maxLevel: number;
    /** Minimum level at which markers are visible. */
    minLevel?: number;
    /** Tile size (default 256). */
    tileSize?: number;
  },
): any {
  const tileSize = opts.tileSize ?? 256;
  const minLevel = opts.minLevel ?? Math.max(0, opts.maxLevel - 8);

  const source = new OpenSeadragon.TileSource({
    width: opts.width,
    height: opts.height,
    tileSize,
    minLevel,
    maxLevel: opts.maxLevel,
    tileOverlap: 0,
    ready: true,
  });

  // Override supports — this source is not auto-detected from URLs
  source.supports = function () {
    return false;
  };

  source.configure = function () {
    return {};
  };

  // MUST return a string to avoid OSD crashes, but we intercept the download.
  source.getTileUrl = function () {
    return "marker://tile";
  };

  source.hasTransparency = function () {
    return true;
  };

  source.tileExists = function (level: number, x: number, y: number): boolean {
    if (level < minLevel) return false;

    const scale = source.getLevelScale(level);
    const tileW = tileSize / scale;
    const tileH = tileSize / scale;
    const left = x * tileW;
    const top = y * tileH;

    const results = markerData.index.search(left, top, left + tileW, top + tileH);
    return results.length > 0;
  };

  const emptyCanvas = document.createElement("canvas");
  emptyCanvas.width = 1;
  emptyCanvas.height = 1;

  /**
   * Internal render logic.
   */
  const renderTile = (level: number, tileX: number, tileY: number): HTMLCanvasElement => {
    const scale = source.getLevelScale(level);
    const tileW = tileSize / scale;
    const tileH = tileSize / scale;
    const left = tileX * tileW;
    const top = tileY * tileH;

    const results = markerData.index.search(left, top, left + tileW, top + tileH);
    if (results.length === 0) return emptyCanvas;

    const canvas = document.createElement("canvas");
    canvas.width = tileSize;
    canvas.height = tileSize;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    const { spritesheet, atlas, items, originX, originY } = markerData;

    for (const idx of results) {
      const item = items[idx];
      if (!item) continue;

      const atlasEntry = atlas[item.spriteKey];
      if (!atlasEntry) continue;

      const localX = item.osdX - originX;
      const localY = item.osdY - originY;
      
      const drawX = (localX - item.w / 2 - left) * scale;
      const drawY = (localY - item.h / 2 - top) * scale;
      const drawW = item.w * scale;
      const drawH = item.h * scale;

      if (drawW < 0.5 || drawH < 0.5) continue;

      ctx.drawImage(
        spritesheet,
        atlasEntry.x,
        atlasEntry.y,
        atlasEntry.w,
        atlasEntry.h,
        drawX,
        drawY,
        drawW,
        drawH,
      );
    }

    return canvas;
  };

  // OSD 6.0 uses getTileData if present
  source.getTileData = function (level: number, x: number, y: number) {
    return renderTile(level, x, y);
  };

  // ALSO override downloadTileStart to prevent OSD from attempting a fetch
  // and to satisfy older or stricter OSD internal logic that might bypass getTileData.
  source.downloadTileStart = function (job: any): void {
    const data = renderTile(job.tile.level, job.tile.x, job.tile.y);
    // Directly finish the job with the canvas data.
    // 'image' type tells OSD this is a displayable element.
    job.finish(data, null, "image");
  };

  source.downloadTileAbort = function (_job: any): void {
    // Synchronous
  };

  return source;
}
