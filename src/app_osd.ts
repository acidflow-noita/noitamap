import { fetchMapVersions, getTileData, MapName } from "./data_sources/tile_data";
import { createOverlays } from "./data_sources/overlays";

import { CHUNK_SIZE } from "./constants";

declare const OpenSeadragon: any;

export type ZoomPos = {
  x: number;
  y: number;
  zoom: number;
};

type DziTileSource = any;

export class AppOSD {
  private viewer: any; // OpenSeadragon.Viewer
  private mapName: MapName | null = null;
  private listeners: ((isLoading: boolean) => void)[] = [];

  private failedItems: Set<any> = new Set();

  constructor(mountTo: HTMLElement, useWebGL: boolean) {
    this.viewer = new OpenSeadragon.Viewer({
      element: mountTo,
      maxZoomPixelRatio: 70,
      showNavigator: false,
      showNavigationControl: false,
      crossOriginPolicy: "Anonymous",
      drawer: (() => {
        if (!useWebGL) return "canvas";
        try {
          if (
            OpenSeadragon.WebGLDrawer &&
            typeof OpenSeadragon.WebGLDrawer.isSupported === "function" &&
            OpenSeadragon.WebGLDrawer.isSupported()
          ) {
            return "webgl";
          }
        } catch (e) {
          console.warn("WebGL check failed", e);
        }
        return "canvas";
      })(),
      imageSmoothingEnabled: false,
      debugMode: false,
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

    this.addHandler("canvas-key", (event: any) => {
      if (["q", "w", "e", "r", "a", "s", "d", "f"].includes(event.originalEvent.key)) {
        event.preventDefaultAction = true;
      }
    });

    this.world.addHandler("remove-item", (event: any) => {
      const item = event.item;
      item.removeAllHandlers("fully-loaded-change");
      this.failedItems.delete(item);
      this.notifyLoadingStatus();
    });

    this.addHandler("tile-load-failed", (event: any) => {
      const item = event.tiledImage;
      if (item) {
        this.failedItems.add(item);
        this.notifyLoadingStatus();
      }
    });

    this.world.addHandler("add-item", (event: any) => {
      const item = event.item;
      item.addHandler("fully-loaded-change", () => this.notifyLoadingStatus());
      if ("Image" in item.source) {
        const image = (item.source as DziTileSource).Image;
        if (image && image.TopLeft) {
          item.setPosition(new OpenSeadragon.Point(Number(image.TopLeft.X), Number(image.TopLeft.Y)), true);
          item.setWidth(Number(image.Size.Width), true);
        }
      }
      this.notifyLoadingStatus();
    });
  }

  // Proxy common OSD properties and methods
  get viewport() { return this.viewer.viewport; }
  get world() { return this.viewer.world; }
  get element() { return this.viewer.element; }

  addHandler(name: string, handler: (event: any) => void) { this.viewer.addHandler(name, handler); }
  removeHandler(name: string, handler: (event: any) => void) { this.viewer.removeHandler(name, handler); }
  addOnceHandler(name: string, handler: (event: any) => void) { this.viewer.addOnceHandler(name, handler); }
  
  addTiledImage(options: any) { this.viewer.addTiledImage(options); }
  addOverlay(options: any) { this.viewer.addOverlay(options); }
  clearOverlays() { this.viewer.clearOverlays(); }
  removeOverlay(el: HTMLElement) { this.viewer.removeOverlay(el); }
  
  open(sources: any) { this.viewer.open(sources); }
  isOpen() { return this.viewer.isOpen(); }

  private static getTileSources(mapName: MapName): string[] {
    return getTileData(mapName).map((tileData) => tileData.url);
  }

  private getAllItems(): any[] {
    const items = [];
    for (let i = 0; i < this.world.getItemCount(); i++) {
      items.push(this.world.getItemAt(i));
    }
    return items;
  }

  private notifyLoadingStatus() {
    const isFullyLoaded = this.getAllItems().reduce(
      (isReady, item) => {
        if (this.failedItems.has(item)) return isReady;
        return (item as any).getDrawArea() !== null
          ? (isReady && item.getFullyLoaded())
          : isReady;
      },
      true,
    );
    const isLoading = !isFullyLoaded;
    this.listeners.forEach((fn) => fn(isLoading));
  }

  onLoading(cb: (isLoading: boolean) => void) {
    this.listeners.push(cb);
  }

  private onOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isOpen()) return resolve();
      this.addHandler("open-failed", reject);
      this.addOnceHandler("open", (_event) => {
        this.removeHandler("open-failed", reject);
        resolve();
      });
    });
  }

  getCombinedItemsRect(): any {
    if (this.world.getItemCount() === 0) return this.world.getHomeBounds();
    const dims = { x: Infinity, y: Infinity, width: 0, height: 0 };
    let found = false;
    for (let i = 0; i < this.world.getItemCount(); i++) {
      const tiledImage = this.world.getItemAt(i);
      if (!("Image" in tiledImage.source)) continue;
      const item = tiledImage.getBoundsNoRotate();
      dims.x = Math.min(dims.x, item.x);
      dims.y = Math.min(dims.y, item.y);
      dims.width += item.width;
      dims.height = Math.max(dims.height, item.height);
      found = true;
    }
    if (!found) return this.world.getHomeBounds();
    return new OpenSeadragon.Rect(dims.x, dims.y, dims.width, dims.height);
  }

  getZoomPos(): ZoomPos {
    const viewport = this.viewport;
    const viewportCenter = viewport.getCenter();
    const viewportZoom = viewport.getZoom();
    return { x: viewportCenter.x, y: viewportCenter.y, zoom: viewportZoom };
  }

  setZoomPos(pos: ZoomPos): void {
    const { x, y, zoom } = pos;
    this.viewport.panTo(new OpenSeadragon.Point(x, y), true);
    this.viewport.zoomTo(zoom, undefined, true);
  }

  private cacheBustHandler?: any;
  private async bindCacheBustHandler(): Promise<void> {
    if (this.mapName === null) throw new Error("this.mapName should not be null");
    if (this.cacheBustHandler) this.world.removeHandler("add-item", this.cacheBustHandler);
    const versions = await fetchMapVersions(this.mapName);
    this.cacheBustHandler = (event: any) => {
      const source = event.item.source as any;
      if (typeof source.tilesUrl === "string") {
        try {
          const version = versions[new URL(source.tilesUrl).origin];
          source.queryParams = `?v=${version}`;
        } catch (e) {}
      }
    };
    this.world.addHandler("add-item", this.cacheBustHandler!);
  }

  async setMap(mapName: MapName, pos?: ZoomPos): Promise<void> {
    if (mapName === this.mapName) return;
    this.mapName = mapName;
    await this.bindCacheBustHandler();
    const tileSources = AppOSD.getTileSources(mapName);
    this.world.removeAll();
    this.open(tileSources);
    this.clearOverlays();
    const overlays = createOverlays(mapName);
    for (const overlay of overlays) {
      this.addOverlay(overlay);
    }
    await this.onOpen();
    const fullSize = this.getCombinedItemsRect();
    this.viewport.fitBounds(fullSize, true);
    const autoPos = this.getZoomPos();
    if (pos && pos.zoom > autoPos.zoom) {
      this.setZoomPos(pos);
    }
  }

  panToTarget(x: number, y: number) {
    const viewport = this.viewport;
    const here = viewport.getCenter();
    const there = new OpenSeadragon.Point(x, y);
    const boundingRect = new OpenSeadragon.Rect(
      Math.min(here.x, there.x),
      Math.min(here.y, there.y),
      Math.max(CHUNK_SIZE, Math.abs(here.x - there.x)),
      Math.max(CHUNK_SIZE, Math.abs(here.y - there.y)),
    );
    const destRect = new OpenSeadragon.Rect(x - CHUNK_SIZE / 2, y - CHUNK_SIZE / 2, CHUNK_SIZE, CHUNK_SIZE);
    if (viewport.getZoom() < 0.0009765625) {
      this.withSlowAnimation(() => viewport.fitBounds(destRect));
      return;
    }
    this.withSlowAnimation(() => viewport.fitBounds(boundingRect));
    clearTimeout(this.panTimer);
    this.panTimer = setTimeout(() => {
      this.panTimer = undefined;
      this.withSlowAnimation(() => viewport.fitBounds(destRect));
    }, 1000);
  }
  private panTimer: any = undefined;

  private withSlowAnimation(cb: Function) {
    const viewport = this.viewport;
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
