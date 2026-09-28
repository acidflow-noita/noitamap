declare const OpenSeadragon: any;

/** Request the level nearest the destination zoom first. OSD's default instead
 * prioritizes a coarse overview, producing a blurry-to-sharp sequence on every
 * uncached zoom, including static map images. Existing cached tiles still draw. */
export const PIXEL_MAP_DRAW_OPTIONS = {
  immediateRender: true,
  imageSmoothingEnabled: false,
  blendTime: 0,
  // One request per frame takes ~0.7s to refill an FHD view even when every
  // requested image is already in the terrain cache. Cached copies can enter
  // immediately; generated cold tiles wait in admission before any OSD timeout.
  maxTilesPerFrame: 16,
};

/** Generated terrain has exact, non-overlapping transparent tile footprints.
 * CanvasDrawer's synthetic one-pixel overlap clears pixels from its neighbor;
 * fractional clear/draw rectangles then leave seams even with every tile ready.
 * Round shared physical-pixel edges, not each tile's width independently. The
 * WebGL drawer uses positionedBounds directly and needs no canvas adjustment. */
export function alignTerrainTileEdges(item: any, tile: any): void {
  if (!(item.source?.__instantTerrain || item.source?.__biomeBg) || item.source.tileOverlap
    || item.getDrawer?.()?.getType?.() !== 'canvas'
    || item.getRotation(true) % 360 || item.viewport.getRotation(true) % 360) return;
  const density = (typeof OpenSeadragon !== 'undefined' && OpenSeadragon.pixelDensityRatio)
    || globalThis.devicePixelRatio || 1;
  const bounds = tile.positionedBounds;
  const start = item.viewport.pixelFromPointNoRotate(bounds.getTopLeft(), true);
  const end = item.viewport.pixelFromPointNoRotate(bounds.getBottomRight(), true);
  const left = Math.round(start.x * density), top = Math.round(start.y * density);
  const right = Math.round(end.x * density), bottom = Math.round(end.y * density);
  tile.position.x = left / density;
  tile.position.y = top / density;
  tile.size.x = (right - left) / density;
  tile.size.y = (bottom - top) / density;
}

/** Filter only reductions of the already area-sampled terrain tiles. Enlarging
 * a cached tile must retain sharp pixels while its finer replacement loads.
 * OSD saves/restores this state around each tile in either drawing context. */
export function smoothInstantTile(event: any): void {
  if (!event.tiledImage?.source?.__instantTerrain || !event.context) return;
  const renderedWidth = event.rendered?.canvas?.width;
  const sourceWidth = event.tile.sourceBounds
    ? Math.min(event.tile.sourceBounds.width, renderedWidth ?? Infinity)
    : renderedWidth;
  const density = (typeof OpenSeadragon !== 'undefined' && OpenSeadragon.pixelDensityRatio)
    || globalThis.devicePixelRatio || 1;
  const displayWidth = event.tile.size?.x * density;
  event.context.imageSmoothingEnabled = Number.isFinite(sourceWidth)
    && Number.isFinite(displayWidth) && displayWidth < sourceWidth;
  event.context.imageSmoothingQuality = 'low';
}
