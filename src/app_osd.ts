import { fetchMapVersions, getTileData, MapName } from './data_sources/tile_data';
import { createOverlays } from './data_sources/overlays';

import type { TileSourceOptions } from 'openseadragon';
import { CHUNK_SIZE } from './constants';

const { Point, TileSource, Viewer } = OpenSeadragon;

export type ZoomPos = {
  x: number;
  y: number;
  zoom: number;
};

type DziTileSource = OpenSeadragon.DziTileSource & { Image: DziImage };
type DziImage = {
  Format: string;
  Overlap: string;
  Size: { Width: string; Height: string };
  TileSize: string;
  TopLeft: { X: string; Y: string };
};

export class AppOSD extends Viewer {
  private mapName: MapName | null = null;
  private listeners: ((isLoading: boolean) => void)[] = [];

  constructor(mountTo: HTMLElement) {
    super({
      element: mountTo,
      maxZoomPixelRatio: 70,
      // animationTime: 1.2, // Uncomment if needed
      showNavigator: false,
      showNavigationControl: false,
      imageSmoothingEnabled: false,
      drawer: 'canvas',
      // Provide OSD with initial set of tiles
      subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
      smoothTileEdgesMinZoom: 1,
      minScrollDeltaTime: 10,
      springStiffness: 50,
      preserveViewport: true,
      gestureSettingsMouse: {
        clickToZoom: false,
      },
      opacity: 1,
    });

    this.world.addHandler('remove-item', event => {
      const item = event.item;

      item.removeAllHandlers('fully-loaded-change');

      // recalculate loading when the list of items we're tracking
      this.notifyLoadingStatus();
    });

    // Align OSD coordinate system with the Noita world coordinate system
    this.world.addHandler('add-item', event => {
      const item = event.item;

      item.addHandler('fully-loaded-change', () => this.notifyLoadingStatus());

      const image = (item.source as DziTileSource).Image;
      item.setPosition(new OpenSeadragon.Point(Number(image.TopLeft.X), Number(image.TopLeft.Y)), true);
      item.setWidth(Number(image.Size.Width), true);

      // recalculate loading when the list of items we're tracking
      this.notifyLoadingStatus();
    });
  }

  private static getTileSources(mapName: MapName): string[] {
    return getTileData(mapName).map(tileData => tileData.url);
  }

  // return a list of TiledImages currently present in the world
  private getAllItems(): OpenSeadragon.TiledImage[] {
    const items = [];

    for (let i = 0; i < this.world.getItemCount(); i++) {
      items.push(this.world.getItemAt(i));
    }

    return items;
  }

  // notify listeners: all listeners are called with `true` if one or more items
  // in the world is currently waiting for data to be loaded. ()
  private notifyLoadingStatus() {
    const isFullyLoaded = this.getAllItems().reduce(
      // prettier-ignore
      (isReady, item) => ( 
        (item as any).getDrawArea() !== null // if the item has a draw area, it is expected to load...
          ? (isReady && item.getFullyLoaded()) // so check if it is loaded yet
          : isReady // otherwise skip this item
      ),
      // we're ready by default, unless one or more items
      // say they are both visible and not ready
      true
    );
    const isLoading = !isFullyLoaded;

    this.listeners.forEach(fn => fn(isLoading));
  }

  onLoading(cb: (isLoading: boolean) => void) {
    this.listeners.push(cb);
  }

  private onOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isOpen()) return resolve();

      this.addHandler('open-failed', reject);

      this.addOnceHandler('open', event => {
        this.removeHandler('open-failed', reject);
        resolve();
      });
    });
  }

  getCombinedItemsRect(): OpenSeadragon.Rect {
    if (this.world.getItemCount() === 0) return this.world.getHomeBounds();

    const dims = { x: Infinity, y: Infinity, width: 0, height: 0 };
    for (let i = 0; i < this.world.getItemCount(); i++) {
      const item = this.world.getItemAt(i).getBoundsNoRotate();

      // we're laying multiple tilesources out left-to-right, though I'm not
      // clear on what decides this! we want the minimum x,y and the maximum
      // height, but the _combined_ width
      dims.x = Math.min(dims.x, item.x);
      dims.y = Math.min(dims.y, item.y);
      dims.width += item.width;
      dims.height = Math.max(dims.height, item.height);
    }

    return new OpenSeadragon.Rect(dims.x, dims.y, dims.width, dims.height);
  }

  getZoomPos(): ZoomPos {
    const viewport = this.viewport;
    const viewportCenter = viewport.getCenter();
    const viewportZoom = viewport.getZoom();

    return {
      x: viewportCenter.x,
      y: viewportCenter.y,
      zoom: viewportZoom,
    };
  }

  setZoomPos(pos: ZoomPos): void {
    const viewport = this.viewport;

    const { x, y, zoom } = pos;

    viewport.panTo(new Point(x, y), true);
    viewport.zoomTo(zoom, undefined, true);
  }

  private cacheBustHandler?: OpenSeadragon.EventHandler<OpenSeadragon.AddItemWorldEvent>;
  private async bindCacheBustHandler(): Promise<void> {
    if (this.mapName === null) throw new Error('this.mapName should not be null');

    // if we have a previous cache bust handler, it's tied to the old map name -- remove it
    if (this.cacheBustHandler) this.world.removeHandler('add-item', this.cacheBustHandler);

    const versions = await fetchMapVersions(this.mapName);

    this.cacheBustHandler = event => {
      const source = event.item.source as any as { queryParams: string; tilesUrl: string };
      const version = versions[new URL(source.tilesUrl).origin];

      // we're mutating the input, which may break in the future -- but it works for now
      // a better answer is to subclass TileSource and override getTileUrl (or supply a
      // custom getTileUrl function), but in version 5.0.0 that doesn't work as expected
      source.queryParams = `?v=${version}`;
    };
    this.world.addHandler('add-item', this.cacheBustHandler!);
  }

  /**
   * In-place update of the currently-displayed map. Retains pan and zoom location
   */
  async setMap(mapName: MapName, pos?: ZoomPos): Promise<void> {
    if (mapName === this.mapName) return;

    this.mapName = mapName;

    await this.bindCacheBustHandler(); // must call _after_ we update this.mapName

    const tileSources = AppOSD.getTileSources(mapName);

    // Clear the map...
    this.world.removeAll();

    // ... add the new tiles ...
    this.open(tileSources);

    // remove all overlays from the viewer
    this.clearOverlays();

    // add overlays for the new map
    const overlays = createOverlays(mapName);
    for (const overlay of overlays) {
      this.addOverlay(overlay);
    }

    // wait for "open" event
    await this.onOpen();

    const fullSize = this.getCombinedItemsRect();
    const viewerSize = this.viewport.getBounds();

    // we have three cases when loading a new map:
    // 1) we've gone from a big map to a smaller map, and there is empty space
    //    around it. in this case, we zoom in to fit the new map into the viewport
    // 2) we explicitly have a position and zoom specified. in this case, we pan
    //    and zoom to the specified position
    // 3) (probably doesn't happen, but could)
    //    we don't have an explicit position yet, and the new map is _bigger_ than
    //    the viewport. in this case, zoom back out
    if (viewerSize.height > fullSize.height) {
      this.viewport.fitBounds(fullSize, true);
    } else if (pos) {
      // set position to requested position, if present
      this.setZoomPos(pos);
    } else {
      // or fit into the viewport if not present
      this.viewport.fitBounds(fullSize, true);
    }
  }

  panToTarget(x: number, y: number) {
    const viewport = this.viewport;

    const here = this.viewport.getCenter();
    const there = new OpenSeadragon.Point(x, y);
    const boundingRect = new OpenSeadragon.Rect(
      Math.min(here.x, there.x),
      Math.min(here.y, there.y),
      Math.min(CHUNK_SIZE, Math.abs(here.x - there.x)),
      Math.min(CHUNK_SIZE, Math.abs(here.y - there.y))
    );

    const destRect = new OpenSeadragon.Rect(x - CHUNK_SIZE / 2, y - CHUNK_SIZE / 2, CHUNK_SIZE, CHUNK_SIZE);

    // Math.pow(2, 1000 / -100)
    // 0.0009765625
    if (viewport.getZoom() < 0.0009765625) {
      // we're already zoomed out enough, just go straight to the destination
      this.withSlowAnimation(() => viewport.fitBounds(destRect));
      return;
    }

    // we're zoomed in to some extent, zoom out first
    this.withSlowAnimation(() => viewport.fitBounds(boundingRect));

    // problem: if the destination is already on screen, we rubber band out and in again
    clearTimeout(this.panTimer);
    this.panTimer = setTimeout(() => {
      this.panTimer = undefined;
      this.withSlowAnimation(() => viewport.fitBounds(destRect));
    }, 1000);
  }
  private panTimer: NodeJS.Timeout | undefined = undefined;

  private withSlowAnimation(cb: Function) {
    const viewport = this.viewport as OpenSeadragon.Viewport & {
      centerSpringX: any;
      centerSpringY: any;
      zoomSpring: any;
    };

    const oldValues = {
      centerSpringXAnimationTime: viewport.centerSpringX.animationTime,
      centerSpringYAnimationTime: viewport.centerSpringY.animationTime,
      zoomSpringAnimationTime: viewport.zoomSpring.animationTime,
    };

    viewport.centerSpringX.animationTime = 10;
    viewport.centerSpringY.animationTime = 10;
    viewport.zoomSpring.animationTime = 20;

    cb();

    viewport.centerSpringX.animationTime = oldValues.centerSpringXAnimationTime;
    viewport.centerSpringY.animationTime = oldValues.centerSpringYAnimationTime;
    viewport.zoomSpring.animationTime = oldValues.zoomSpringAnimationTime;
  }
}
