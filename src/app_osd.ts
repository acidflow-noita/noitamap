import { fetchMapVersions, getTileData, MapName } from "./data_sources/tile_data";
import { createOverlays } from "./data_sources/overlays";
import { isLightMode } from "./light-mode";

import { CHUNK_SIZE } from "./constants";

declare const OpenSeadragon: any;

export type ZoomPos = {
  x: number;
  y: number;
  zoom: number;
};

type DziTileSource = any;

export class AppOSD {
  public viewer: any; // OpenSeadragon.Viewer
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
        if (!useWebGL) {
          console.log("[OSD] Drawer: canvas (user preference)");
          return "canvas";
        }
        try {
          if (
            OpenSeadragon.WebGLDrawer &&
            typeof OpenSeadragon.WebGLDrawer.isSupported === "function" &&
            OpenSeadragon.WebGLDrawer.isSupported()
          ) {
            console.log("[OSD] Drawer: webgl");
            return "webgl";
          }
        } catch (e) {
          console.warn("WebGL check failed", e);
        }
        console.log("[OSD] Drawer: canvas (webgl not supported)");
        return "canvas";
      })(),
      imageSmoothingEnabled: false,
      debugMode: false,
      subPixelRoundingForTransparency: useWebGL
        ? OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS
        : OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.NEVER,
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
  get viewport() {
    return this.viewer.viewport;
  }
  get world() {
    return this.viewer.world;
  }
  get element() {
    return this.viewer.element;
  }
  get canvas() {
    return this.viewer.canvas || this.viewer.element.querySelector(".openseadragon-canvas");
  }
  get innerTracker() {
    return this.viewer.innerTracker;
  }

  setMouseNavEnabled(enabled: boolean) {
    this.viewer.setMouseNavEnabled(enabled);
  }
  isMouseNavEnabled() {
    return this.viewer.isMouseNavEnabled();
  }

  addHandler(name: string, handler: (event: any) => void) {
    this.viewer.addHandler(name, handler);
  }
  removeHandler(name: string, handler: (event: any) => void) {
    this.viewer.removeHandler(name, handler);
  }
  addOnceHandler(name: string, handler: (event: any) => void) {
    this.viewer.addOnceHandler(name, handler);
  }

  addTiledImage(options: any) {
    this.viewer.addTiledImage(options);
  }
  addOverlay(options: any) {
    this.viewer.addOverlay(options);
  }
  clearOverlays() {
    this.viewer.clearOverlays();
  }
  removeOverlay(el: HTMLElement) {
    this.viewer.removeOverlay(el);
  }

  open(sources: any) {
    this.viewer.open(sources);
  }
  isOpen() {
    return this.viewer.isOpen();
  }

  private static getTileSources(mapName: MapName): string[] {
    let sources = getTileData(mapName).map((tileData) => tileData.url);
    // Light mode on the dynamic map: skip left/right PW backgrounds, keep only middle.
    if (mapName === "dynamic-main-branch" && isLightMode()) {
      sources = sources.filter((url) => !/-left\.|-right\./.test(url));
    }
    return sources;
  }

  private getAllItems(): any[] {
    const items = [];
    for (let i = 0; i < this.world.getItemCount(); i++) {
      items.push(this.world.getItemAt(i));
    }
    return items;
  }

  private notifyLoadingStatus() {
    const isFullyLoaded = this.getAllItems().reduce((isReady, item) => {
      if (this.failedItems.has(item)) return isReady;
      return (item as any).getDrawArea() !== null ? isReady && item.getFullyLoaded() : isReady;
    }, true);
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
    if (pos) {
      this.setZoomPos({
        x: pos.x,
        y: pos.y,
        // Prevent zooming out further than the full map bounds
        zoom: Math.max(pos.zoom, autoPos.zoom),
      });
    }
  }

  /**
   * Cinematic pan to a target point: zooms out so origin + destination are
   * both visible, holds, zooms back in. Draws a SVG arrow trail and a pulse
   * marker on the destination.
   *
   * @param x   actual world-X of the POI (arrow points here, pulse appears here)
   * @param y   actual world-Y of the POI
   * @param opts.offsetXPx  pixel offset to shift the *viewport center* by, so
   *                        the POI lands left/right of dead-center when a
   *                        sidebar covers part of the canvas. The trail and
   *                        pulse stay anchored to (x, y).
   */
  panToTarget(x: number, y: number, opts?: { offsetXPx?: number }): Promise<void> {
    const viewport = this.viewport;
    const here = viewport.getCenter();

    // Cancel any in-progress pan (animation-finish handler + queued timers).
    if (this.panTimer) clearTimeout(this.panTimer);
    if (this.activeAnimFinish) {
      this.viewer.removeHandler("animation-finish", this.activeAnimFinish);
      this.activeAnimFinish = null;
    }
    this.removePanTrail();

    // ─── Sidebar-aware fitBounds helper ───────────────────────────────────
    //
    // `offsetXPx` is half the sidebar width — i.e. the canvas pixel shift we
    // want to apply so that the POI lands at the centre of the *visible*
    // canvas (canvas minus sidebar), not the centre of the full canvas.
    //
    // We can't just shift the rect by a constant world-units value: fitBounds
    // picks a zoom such that *either* the rect's width or its height fully
    // fits the canvas, whichever is the binding constraint. If the rect is
    // taller than canvas-aspect, height wins and horizontal shift has to be
    // scaled differently than if width wins.
    //
    // Solution: instead of letting fitBounds choose the zoom, build a rect
    // whose aspect ratio matches the canvas, centred so that the *content*
    // (the POI plus any other point we want visible) sits inside the visible
    // (non-sidebar) portion. fitBounds with a canvas-aspect rect always
    // produces an exact 1:1 fit, so the geometry is predictable.
    const offsetXPx = opts?.offsetXPx ?? 0;
    const canvasEl = this.viewer.canvas as HTMLElement;
    const canvasPxW = canvasEl?.clientWidth || 1200;
    const canvasPxH = canvasEl?.clientHeight || 800;
    const visiblePxW = Math.max(1, canvasPxW - offsetXPx * 2); // offsetXPx == sidebarPx/2
    const canvasAspect = canvasPxW / canvasPxH;

    /**
     * Build a fitBounds rect that:
     *   - Forces the canvas aspect ratio (so fitBounds is an exact fit, not
     *     letter-boxed).
     *   - Sizes the rect so the requested `contentW x contentH` content area
     *     (centred at contentCx, contentCy) lands fully inside the *visible*
     *     portion of the canvas.
     *   - Shifts the rect centre to the right of the content centre by the
     *     world-units equivalent of `offsetXPx` so the content lines up with
     *     the visible-canvas centre, not the full-canvas centre.
     */
    const buildSidebarRect = (
      contentCx: number,
      contentCy: number,
      contentW: number,
      contentH: number,
    ) => {
      // Zoom that fits the content in the visible region (sidebar excluded
      // horizontally). Choose the more-constrained dimension.
      const zoomForW = visiblePxW / contentW;
      const zoomForH = canvasPxH / contentH;
      const zoom = Math.min(zoomForW, zoomForH);
      // At that zoom, the canvas spans `canvasPxW / zoom` world units.
      const rectW = canvasPxW / zoom;
      const rectH = canvasPxH / zoom;
      // Bias the rect centre right so the content centre lines up with the
      // visible-canvas centre. In world units: (sidebarPx / 2) / zoom.
      const shift = offsetXPx > 0 ? offsetXPx / zoom : 0;
      // Sanity: enforce canvas aspect (should already match by construction).
      const _ = canvasAspect; // keep ref so the value is used.
      void _;
      return new OpenSeadragon.Rect(
        contentCx + shift - rectW / 2,
        contentCy - rectH / 2,
        rectW,
        rectH,
      );
    };

    // ─── Short-distance shortcut: snap to a single chunk view ─────────────
    const destContentW = CHUNK_SIZE;
    const destContentH = CHUNK_SIZE;
    const dist = Math.sqrt((here.x - x) ** 2 + (here.y - y) ** 2);
    if (dist < CHUNK_SIZE * 0.5) {
      const destRect = buildSidebarRect(x, y, destContentW, destContentH);
      this.withSlowAnimation(() => viewport.fitBounds(destRect));
      this.addPulseMarker(x, y);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      // ─── Phase 1: Zoom out to show origin + POI, with sidebar margin ────
      const padding = 1.3;
      const midX = (here.x + x) / 2;
      const midY = (here.y + y) / 2;
      const spanW = Math.max(Math.abs(here.x - x) * padding, CHUNK_SIZE * 2);
      const spanH = Math.max(Math.abs(here.y - y) * padding, CHUNK_SIZE * 2);
      const overviewRect = buildSidebarRect(midX, midY, spanW, spanH);

      this.addPanTrail(here.x, here.y, x, y);
      this.withSlowAnimation(() => viewport.fitBounds(overviewRect));

      // ─── Phase 2: After phase 1 settles, zoom into the destination ──────
      const destRect = buildSidebarRect(x, y, destContentW, destContentH);

      const onAnimFinish = () => {
        this.viewer.removeHandler("animation-finish", onAnimFinish);
        this.activeAnimFinish = null;
        this.panTimer = setTimeout(() => {
          this.panTimer = undefined;
          this.withSlowAnimation(() => viewport.fitBounds(destRect));
          this.panTimer = setTimeout(() => {
            this.removePanTrail();
            this.addPulseMarker(x, y);
            resolve();
          }, 800);
        }, 1000);
      };
      this.activeAnimFinish = onAnimFinish;
      this.viewer.addHandler("animation-finish", onAnimFinish);
    });
  }
  private panTimer: any = undefined;
  private activeAnimFinish: (() => void) | null = null;

  /** Add an SVG trail line overlay connecting origin to destination */
  private addPanTrail(x1: number, y1: number, x2: number, y2: number) {
    this.removePanTrail();
    const container = this.viewer.container as HTMLElement;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pan-trail-svg");
    svg.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 9999; overflow: visible;
    `;

    // Defs for the marching ants effect
    svg.innerHTML = `
      <defs>
        <marker id="pan-trail-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 2 1 L 8 5 L 2 9" fill="none" stroke="oklch(62.7% 0.194 149.214)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        </marker>
      </defs>
    `;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "pan-trail-line");
    line.setAttribute("stroke", "oklch(62.7% 0.194 149.214)");
    line.setAttribute("stroke-width", "8");
    line.setAttribute("stroke-dasharray", "10,8");
    line.setAttribute("stroke-opacity", "0.8");
    line.setAttribute("marker-end", "url(#pan-trail-arrow)");
    svg.appendChild(line);

    // Destination dot
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "pan-trail-dot");
    dot.setAttribute("r", "6");
    dot.setAttribute("fill", "oklch(62.7% 0.194 149.214)");
    dot.setAttribute("fill-opacity", "0.9");
    svg.appendChild(dot);

    container.appendChild(svg);

    // Store trail data for position updates
    this.panTrailData = { svg, line, dot, x1, y1, x2, y2 };
    this.updatePanTrailPositions();

    // Start marching ants animation
    this.panTrailAnimFrame = requestAnimationFrame(this.animatePanTrail);

    // Listen to viewport changes to update line positions
    this.panTrailViewportHandler = () => this.updatePanTrailPositions();
    this.viewer.addHandler("animation", this.panTrailViewportHandler);
    this.viewer.addHandler("animation-finish", this.panTrailViewportHandler);
  }

  private panTrailData: {
    svg: SVGSVGElement;
    line: SVGLineElement;
    dot: SVGCircleElement;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null = null;
  private panTrailAnimFrame: number = 0;
  private panTrailDashOffset: number = 0;
  private panTrailViewportHandler: (() => void) | null = null;

  private animatePanTrail = () => {
    if (!this.panTrailData) return;
    this.panTrailDashOffset -= 0.5;
    this.panTrailData.line.setAttribute("stroke-dashoffset", String(this.panTrailDashOffset));
    this.panTrailAnimFrame = requestAnimationFrame(this.animatePanTrail);
  };

  private updatePanTrailPositions() {
    if (!this.panTrailData) return;
    const { line, dot, x1, y1, x2, y2 } = this.panTrailData;
    const viewport = this.viewport;
    const p1 = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x1, y1));
    const p2 = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x2, y2));
    line.setAttribute("x1", String(p1.x));
    line.setAttribute("y1", String(p1.y));
    line.setAttribute("x2", String(p2.x));
    line.setAttribute("y2", String(p2.y));
    dot.setAttribute("cx", String(p2.x));
    dot.setAttribute("cy", String(p2.y));
  }

  private removePanTrail() {
    if (this.panTrailAnimFrame) {
      cancelAnimationFrame(this.panTrailAnimFrame);
      this.panTrailAnimFrame = 0;
    }
    if (this.panTrailViewportHandler) {
      this.viewer.removeHandler("animation", this.panTrailViewportHandler);
      this.viewer.removeHandler("animation-finish", this.panTrailViewportHandler);
      this.panTrailViewportHandler = null;
    }
    if (this.panTrailData) {
      this.panTrailData.svg.remove();
      this.panTrailData = null;
    }
    this.panTrailDashOffset = 0;
  }

  /** Add a pulsing circle at the destination that fades out */
  private addPulseMarker(x: number, y: number) {
    // Remove any existing pulse
    const old = this.viewer.container.querySelector(".pan-pulse-marker");
    if (old) old.remove();

    const el = document.createElement("div");
    el.className = "pan-pulse-marker";
    el.style.cssText = `
      position: absolute; width: 20px; height: 20px;
      border: 2px solid oklch(62.7% 0.194 149.214); border-radius: 50%;
      pointer-events: none; z-index: 9998;
      animation: pan-pulse 1.5s ease-out forwards;
      transform: translate(-50%, -50%);
    `;

    // Position via OSD overlay system
    this.viewer.addOverlay({
      element: el,
      location: new OpenSeadragon.Point(x, y),
      placement: OpenSeadragon.Placement.CENTER,
    });

    // Auto-remove after animation
    setTimeout(() => {
      try {
        this.viewer.removeOverlay(el);
      } catch (_) {}
      el.remove();
    }, 1500);
  }

  private withSlowAnimation(cb: Function) {
    const viewport = this.viewport;
    const oldValues = {
      centerSpringXAnimationTime: viewport.centerSpringX.animationTime,
      centerSpringYAnimationTime: viewport.centerSpringY.animationTime,
      zoomSpringAnimationTime: viewport.zoomSpring.animationTime,
    };
    viewport.centerSpringX.animationTime = 3.75;
    viewport.centerSpringY.animationTime = 3.75;
    viewport.zoomSpring.animationTime = 1.75;
    cb();
    viewport.centerSpringX.animationTime = oldValues.centerSpringXAnimationTime;
    viewport.centerSpringY.animationTime = oldValues.centerSpringYAnimationTime;
    viewport.zoomSpring.animationTime = oldValues.zoomSpringAnimationTime;
  }
}
