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
}

function removeSideworld(): void {
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
  visible = false;
}
