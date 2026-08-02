/**
 * sideworld.ts
 *
 * Show/hide the QLC sideworld as an overlay on top of the main QLC map.
 *
 * The sideworld is a separate world in the engine (world_definitions.xml
 * declares it with its own biome map and init script), reached in-game from the
 * TeleWasher machine at Main (2950,-8100). Its own scene, TeleWasherInvert,
 * sits at Sideworld (-712,-5) — coordinates that OVERLAP Main's, which is why
 * it cannot be baked into the same raster and is published as its own pyramid.
 *
 * Rather than a separate map entry, it is layered at its true world
 * coordinates: the same place, flipped. The main map stays loaded underneath,
 * so toggling never re-opens the viewer or disturbs the base layer.
 */

import { getTileData, type MapName } from './data_sources/tile_data';

declare const OpenSeadragon: any;

export const QLC_MAP_NAME = 'ups-main';
export const SIDEWORLD_SOURCE_KEY = 'qlc-sideworld';

/** Marks our tiled image so cleanup passes elsewhere can recognise it. */
const SIDEWORLD_FLAG = '__qlcSideworld';

let viewer: any = null;
let visible = false;
/** Guards against double-adds while addTiledImage's async open is in flight. */
let pending = false;
/** The border overlay element, tracked so it can be removed with the tiles. */
let borderEl: HTMLElement | null = null;

export function initSideworld(osdViewer: any): void {
  viewer = osdViewer;
}

export function isSideworldVisible(): boolean {
  return visible;
}

/** The sideworld only exists for the QLC map; every other map hides the button. */
export function mapHasSideworld(mapName: MapName | string | undefined): boolean {
  if (mapName !== QLC_MAP_NAME) return false;
  try {
    return getTileData(SIDEWORLD_SOURCE_KEY as MapName).length > 0;
  } catch {
    return false;
  }
}

function findItem(): any | null {
  if (!viewer) return null;
  const world = viewer.world;
  for (let i = 0; i < world.getItemCount(); i++) {
    const item = world.getItemAt(i);
    if (item && (item as any)[SIDEWORLD_FLAG]) return item;
  }
  return null;
}

/**
 * Add the sideworld pyramid at its own TopLeft. The descriptor is bundled in
 * tilesources.json, so this parses the same JSON the viewer uses for every
 * other source instead of refetching it.
 */
async function addSideworld(): Promise<void> {
  if (!viewer) return;
  const data = getTileData(SIDEWORLD_SOURCE_KEY as MapName)[0];
  if (!data) return;

  const image = JSON.parse(data.dziContent).Image;
  const x = Number(image.TopLeft?.X ?? 0);
  const y = Number(image.TopLeft?.Y ?? 0);
  const width = Number(image.Size.Width);

  await new Promise<void>((resolve, reject) => {
    viewer.addTiledImage({
      tileSource: data.url,
      // World pixels are 1:1 with image pixels for QLC bakes, so the image's
      // own width in world units places it at true scale beside the main map.
      x,
      y,
      width,
      // Above the base map, below POI overlays.
      index: 1,
      success: (event: any) => {
        const item = event.item;
        item[SIDEWORLD_FLAG] = true;
        resolve();
      },
      error: (event: any) => reject(event?.message ?? new Error('sideworld tile source failed to load')),
    });
  });

  addBorder(x, y, width, Number(image.Size.Height));
}

/**
 * Frame the sideworld with a border so it reads as a distinct region rather
 * than part of the base map.
 *
 * An OSD overlay <div> rather than anything drawn into the canvas: OSD
 * composites every tiled image into one canvas, so there is no per-image
 * element to style, and a canvas-drawn border would have to be re-rendered on
 * every pan/zoom. An overlay is positioned in viewport coordinates and tracks
 * pan/zoom for free, in both the HTML and WebGL drawers.
 *
 * The rect comes from the descriptor's own TopLeft/Size, so it always matches
 * whatever the last bake actually produced instead of hardcoded bounds.
 */
function addBorder(x: number, y: number, width: number, height: number): void {
  if (!viewer) return;
  const el = document.createElement('div');
  el.className = 'qlc-sideworld-border';
  // pointer-events: none so the frame never eats clicks meant for the map.
  el.style.cssText = 'pointer-events: none;';
  viewer.addOverlay({
    element: el,
    location: new OpenSeadragon.Rect(x, y, width, height),
  });
  borderEl = el;
}

function removeBorder(): void {
  if (borderEl && viewer) {
    try {
      viewer.removeOverlay(borderEl);
    } catch {
      // Already gone (e.g. a map switch cleared every overlay); nothing to do.
    }
    borderEl.remove();
  }
  borderEl = null;
}

function removeSideworld(): void {
  removeBorder();
  const item = findItem();
  if (item && viewer) viewer.world.removeItem(item);
}

/**
 * Toggle the overlay. Returns the resulting visibility so the caller can keep
 * a checkbox in sync with what actually happened rather than what was asked
 * for — a failed tile-source load leaves the button unchecked.
 */
export async function toggleSideworld(next?: boolean): Promise<boolean> {
  if (!viewer || pending) return visible;
  const target = next === undefined ? !visible : next;
  if (target === visible) return visible;

  pending = true;
  try {
    if (target) {
      await addSideworld();
      visible = true;
    } else {
      removeSideworld();
      visible = false;
    }
  } catch (error) {
    console.error('[sideworld] toggle failed:', error);
    removeSideworld();
    visible = false;
  } finally {
    pending = false;
  }
  return visible;
}

/**
 * Drop the overlay when leaving the QLC map. Switching maps re-opens the
 * viewer, which destroys every tiled image, so this only has to reset the flag
 * that tracks whether it is showing.
 */
export function resetSideworld(): void {
  // setMap re-opens the viewer, which drops tiled images AND overlays, so the
  // element is already detached — just clear the handle so a later toggle does
  // not try to remove a stale node.
  borderEl = null;
  visible = false;
}
