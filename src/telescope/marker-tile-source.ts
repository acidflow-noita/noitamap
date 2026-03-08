/**
 * marker-tile-source.ts
 *
 * Custom OpenSeadragon TileSource that renders POI markers from a spritesheet
 * onto tile canvases. Uses a Flatbush spatial index to efficiently find which
 * markers fall within each tile's bounds.
 */

import { MarkerData } from "./poi-spatial-index";

declare const OpenSeadragon: any;

const TILE_SIZE = 512;

export function createMarkerTileSource(markerData: MarkerData): any {
  const { index, spritesheet, atlas, items, originX, originY, bboxWidth, bboxHeight } = markerData;

  // Compute maxLevel from actual image dimensions.
  // OSD formula: smallest N where 2^(N+1) >= max(width, height)
  const maxDim = Math.max(bboxWidth, bboxHeight);
  const maxLevel = Math.max(0, Math.ceil(Math.log2(maxDim)));

  console.log(`[MarkerTileSource] Creating: ${Math.round(bboxWidth)}x${Math.round(bboxHeight)}, ` +
    `${items.length} markers, maxLevel=${maxLevel}, origin=(${Math.round(originX)},${Math.round(originY)})`);

  // Helper: compute tile bounds in full-resolution image space
  function tileBounds(level: number, x: number, y: number) {
    const scale = Math.pow(2, maxLevel - level);
    const bx = x * TILE_SIZE * scale;
    const by = y * TILE_SIZE * scale;
    const bw = TILE_SIZE * scale;
    const bh = TILE_SIZE * scale;
    return { bx, by, bw, bh };
  }

  const source = new OpenSeadragon.TileSource({
    height: bboxHeight,
    width: bboxWidth,
    tileSize: TILE_SIZE,
    minLevel: 0,
    maxLevel: maxLevel,
  });

  source.getTileUrl = function (level: number, x: number, y: number) {
    return `marker-tile://${level}/${x}/${y}`;
  };

  // Marker tiles are transparent (sprites on clear background).
  // Without this, OSD fills an opaque background behind every tile.
  source.hasTransparency = function () {
    return true;
  };

  source.tileExists = function (level: number, x: number, y: number) {
    const { bx, by, bw, bh } = tileBounds(level, x, y);
    const results = index.search(bx, by, bx + bw, by + bh);
    return results.length > 0;
  };

  let downloadCount = 0;

  source.downloadTileStart = function (context: any) {
    // ImageJob stores tile coords on context.tile, NOT on context directly
    const tile = context.tile;
    const level = tile.level;
    const x = tile.x;
    const y = tile.y;

    const { bx, by, bw, bh } = tileBounds(level, x, y);

    const results = index.search(bx, by, bx + bw, by + bh);

    if (downloadCount < 5) {
      console.log(`[MarkerTileSource] downloadTileStart: level=${level} (${x},${y}), ` +
        `bounds=(${Math.round(bx)},${Math.round(by)} ${Math.round(bw)}x${Math.round(bh)}), ` +
        `hits=${results.length}`);
      downloadCount++;
      if (downloadCount === 5) console.log(`[MarkerTileSource] (suppressing further logs)`);
    }

    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    if (results.length > 0) {
      // Scale from full-res image coordinates to tile pixel coordinates
      const drawScale = TILE_SIZE / bw;

      for (const idx of results) {
        const item = items[idx];
        if (!item) continue;

        const atlasEntry = atlas[item.spriteKey];
        if (!atlasEntry) continue;

        // Item position in full-res space (local to bbox origin)
        const itemLocalX = item.osdX - originX - item.w / 2;
        const itemLocalY = item.osdY - originY - item.h / 2;

        // Map to tile pixel coordinates (no rounding — let canvas handle sub-pixel)
        const drawX = (itemLocalX - bx) * drawScale;
        const drawY = (itemLocalY - by) * drawScale;
        const drawW = item.w * drawScale;
        const drawH = item.h * drawScale;

        // item.w/h are first-frame dimensions (from FIRST_FRAME_SIZE in poi-spatial-index).
        // Use them as the source rect to extract only the first frame from the atlas.
        ctx.drawImage(
          spritesheet,
          atlasEntry.x, atlasEntry.y, item.w, item.h,
          drawX, drawY, drawW, drawH,
        );
      }
    }

    // Pass canvas synchronously — async createImageBitmap causes artifacts
    // during rapid zoom when aborted tiles still call finish().
    context.finish(canvas, null, "image");
  };

  source.downloadTileAbort = function (_context: any) {
    // No-op — canvas rendering is synchronous
  };

  return source;
}
