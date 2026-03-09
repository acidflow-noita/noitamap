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

  const maxDim = Math.max(bboxWidth, bboxHeight);
  const maxLevel = Math.max(0, Math.ceil(Math.log2(maxDim)));

  // Max marker dimension — expand tile query bounds by this so markers
  // straddling tile edges are still found at every zoom level.
  let maxMarkerDim = 0;
  for (const item of items) {
    if (item.w > maxMarkerDim) maxMarkerDim = item.w;
    if (item.h > maxMarkerDim) maxMarkerDim = item.h;
  }

  console.log(`[MarkerTileSource] Creating: ${Math.round(bboxWidth)}x${Math.round(bboxHeight)}, ` +
    `${items.length} markers, maxLevel=${maxLevel}, origin=(${Math.round(originX)},${Math.round(originY)})`);

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

  source.hasTransparency = function () {
    return true;
  };

  source.tileExists = function (level: number, x: number, y: number) {
    const { bx, by, bw, bh } = tileBounds(level, x, y);
    const pad = maxMarkerDim;
    const results = index.search(bx - pad, by - pad, bx + bw + pad, by + bh + pad);
    return results.length > 0;
  };

  let downloadCount = 0;

  source.downloadTileStart = function (context: any) {
    const tile = context.tile;
    const level = tile.level;
    const x = tile.x;
    const y = tile.y;

    const { bx, by, bw, bh } = tileBounds(level, x, y);
    const pad = maxMarkerDim;
    const results = index.search(bx - pad, by - pad, bx + bw + pad, by + bh + pad);

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
    // Nearest-neighbor for pixel art — no smoothing/antialiasing ever.
    ctx.imageSmoothingEnabled = false;

    if (results.length > 0) {
      const drawScale = TILE_SIZE / bw;

      for (const idx of results) {
        const item = items[idx];
        if (!item) continue;

        const atlasEntry = atlas[item.spriteKey];
        if (!atlasEntry) continue;

        const itemLocalX = item.osdX - originX - item.w / 2;
        const itemLocalY = item.osdY - originY - item.h / 2;

        // Sub-pixel coordinates are fine — canvas drawImage handles them
        // correctly with imageSmoothingEnabled=false. Do NOT round, as
        // rounding causes markers to visibly shift when zoom level changes.
        const drawX = (itemLocalX - bx) * drawScale;
        const drawY = (itemLocalY - by) * drawScale;
        const drawW = item.w * drawScale;
        const drawH = item.h * drawScale;

        // Skip markers too small to render at this zoom level
        if (drawW < 1 || drawH < 1) continue;

        ctx.drawImage(
          spritesheet,
          atlasEntry.x, atlasEntry.y, item.w, item.h,
          drawX, drawY, drawW, drawH,
        );
      }
    }

    // Pass canvas directly — synchronous, preserves transparency.
    // Do NOT use createImageBitmap: it's async (causes race conditions
    // on rapid zoom) and may apply unwanted smoothing to pixel art.
    context.finish(canvas, null, "image");
  };

  source.downloadTileAbort = function (_context: any) {
    // No-op — canvas rendering is synchronous
  };

  return source;
}
