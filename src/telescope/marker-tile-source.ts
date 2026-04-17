/**
 * marker-tile-source.ts
 *
 * Custom OpenSeadragon TileSource that renders POI markers from a spritesheet
 * onto tile canvases. Uses a Flatbush spatial index to efficiently find which
 * markers fall within each tile's bounds.
 */

import { MarkerData } from "./poi-spatial-index";
import { applySpoilerFree } from "../spoiler-free";

declare const OpenSeadragon: any;

const TILE_SIZE = 512;
let tileSourceCounter = 0;

// Module-level detail visibility flag. When false, detail markers
// (wands, items, potions, creatures) are skipped at tileExists + draw time
// so zoomed-out tiles render far fewer sprites. Flipped by the OSD bridge
// based on current viewport zoom.
let _detailVisible = true;

export function isDetailVisible(): boolean {
  return _detailVisible;
}

/** Set detail visibility. Returns true if the value changed. */
export function setDetailVisible(v: boolean): boolean {
  if (_detailVisible === v) return false;
  _detailVisible = v;
  return true;
}

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

  console.log(
    `[MarkerTileSource] Creating: ${Math.round(bboxWidth)}x${Math.round(bboxHeight)}, ` +
      `${items.length} markers, maxLevel=${maxLevel}, origin=(${Math.round(originX)},${Math.round(originY)})`,
  );

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

  const sourceId = ++tileSourceCounter;
  source.getTileUrl = function (level: number, x: number, y: number) {
    return `marker-tile://${sourceId}/${level}/${x}/${y}`;
  };

  source.hasTransparency = function () {
    return true;
  };

  // Use spatial index to check if markers exist in this tile.
  // Prevents OSD from creating empty transparent canvases.
  source.tileExists = function (level: number, x: number, y: number) {
    const { bx, by, bw, bh } = tileBounds(level, x, y);
    const pad = maxMarkerDim;
    const results = index.search(bx - pad, by - pad, bx + bw + pad, by + bh + pad);
    if (results.length === 0) return false;
    if (_detailVisible) return true;
    // Detail hidden: only report tile as existing if it has at least one non-detail marker.
    for (const idx of results) {
      if (!items[idx].isDetail) return true;
    }
    return false;
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
      console.log(
        `[MarkerTileSource] downloadTileStart: level=${level} (${x},${y}), ` +
          `bounds=(${Math.round(bx)},${Math.round(by)} ${Math.round(bw)}x${Math.round(bh)}), ` +
          `hits=${results.length}`,
      );
      downloadCount++;
      if (downloadCount === 5) console.log(`[MarkerTileSource] (suppressing further logs)`);
    }

    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    if (results.length > 0) {
      const drawScale = TILE_SIZE / bw;
      const skipDetail = !_detailVisible;

      for (const idx of results) {
        const item = items[idx];
        if (!item) continue;
        if (skipDetail && item.isDetail) continue;

        const rawKeysRaw = Array.isArray(item.spriteKey) ? item.spriteKey : [item.spriteKey];
        const rootKey = rawKeysRaw[0];
        const atlasKeyScrubbed = applySpoilerFree(rootKey, atlas);
        const drawKeys = (atlasKeyScrubbed !== rootKey) ? [atlasKeyScrubbed] : rawKeysRaw;

        let isMain = true;
        let rootW = 0;
        let rootH = 0;
        let rootOX = 0;
        let rootOY = 0;

        for (const k of drawKeys) {
          const atlasEntry = atlas[k];
          if (!atlasEntry) continue;

          const srcW = atlasEntry.w;
          const srcH = atlasEntry.h;

          if (isMain) {
            isMain = false;
            // When spoiler-free swaps the sprite, use the replacement sprite's
            // own pixel dimensions (item.w/h are pixel dims from the original atlas entry).
            rootW = atlasKeyScrubbed !== rootKey ? srcW : item.w;
            rootH = atlasKeyScrubbed !== rootKey ? srcH : item.h;
            rootOX = atlasEntry.ox ?? rootW / 2;
            rootOY = atlasEntry.oy ?? rootH / 2;
          }

          const l_ox = atlasEntry.ox ?? srcW / 2;
          const l_oy = atlasEntry.oy ?? srcH / 2;
          const itemLocalX = item.osdX - originX + (l_ox - rootOX);
          const itemLocalY = item.osdY - originY + (l_oy - rootOY);

          const drawX = (itemLocalX - bx - l_ox) * drawScale;
          const drawY = (itemLocalY - by - l_oy) * drawScale;
          const drawW = srcW * drawScale;
          const drawH = srcH * drawScale;

          // Skip markers smaller than 1px
          if (drawW < 1 || drawH < 1) continue;

          ctx.drawImage(
            spritesheet,
            atlasEntry.x, atlasEntry.y, srcW, srcH,
            drawX, drawY, drawW, drawH,
          );
        }
      }
    }

    // IMPORTANT: Defer context.finish to the next microtask. Calling it
    // synchronously inside downloadTileStart confuses OSD's coverage
    // tracking — OSD calls _setCoverage for the tile before _resetCoverage
    // has run for that level in the current render pass, producing the
    // "Setting coverage for a tile before its level's coverage has been
    // reset" warnings and causing DZI background tiles to "pop" to low-res.
    queueMicrotask(() => {
      context.finish(canvas, null, "image");
    });
  };

  source.downloadTileAbort = function (_context: any) {
    // No-op — canvas rendering is synchronous, finish is deferred
  };

  return source;
}
