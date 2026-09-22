import { fetchMapVersions, getTileData, MapName } from './data_sources/tile_data';
import { createOverlays } from './data_sources/overlays';
import { isLightMode } from './light-mode';
import { isSimplisticBackground } from './simplistic-background';

import { CHUNK_SIZE } from './constants';

declare const OpenSeadragon: any;

// Flat per-PW background used by the "Use simplistic map background" perf
// toggle. Lives in public/assets/. One image px == one 512px chunk, so it is
// displayed at CHUNK_SIZE (512x) its natural size.
const BG_PERF_URL = './assets/bg_perf_mode.png';

export type ZoomPos = {
  x: number;
  y: number;
  zoom: number;
};

type PanCurve = { x1: number; y1: number; x2: number; y2: number; cxW: number; cyW: number };

/** One world-space curve for both the camera route and its visible arrow. */
function createPanCurve(x1: number, y1: number, x2: number, y2: number): PanCurve {
  const dx = x2 - x1, dy = y2 - y1;
  const bend = dx < 0 ? -0.18 : 0.18;
  return { x1, y1, x2, y2, cxW: (x1 + x2) / 2 + dy * bend, cyW: (y1 + y2) / 2 - dx * bend };
}

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
      crossOriginPolicy: 'Anonymous',
      drawer: (() => {
        if (!useWebGL) {
          console.log('[OSD] Drawer: canvas (user preference)');
          return 'canvas';
        }
        try {
          if (
            OpenSeadragon.WebGLDrawer &&
            typeof OpenSeadragon.WebGLDrawer.isSupported === 'function' &&
            OpenSeadragon.WebGLDrawer.isSupported()
          ) {
            console.log('[OSD] Drawer: webgl');
            return 'webgl';
          }
        } catch (e) {
          console.warn('WebGL check failed', e);
        }
        console.log('[OSD] Drawer: canvas (webgl not supported)');
        return 'canvas';
      })(),
      imageSmoothingEnabled: false,
      debugMode: false,
      // Canvas drawer: round transparent tiles to whole pixels once the
      // viewport is at rest so overlap seams don't show. The baked daily
      // overlay additionally rounds on every frame (baked-dzi-loader); the
      // other transparent layers (markers, scenes) are sparse enough that a
      // partial-coverage tile edge is invisible mid-animation.
      subPixelRoundingForTransparency: useWebGL
        ? OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS
        : OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ONLY_AT_REST,
      minScrollDeltaTime: 10,
      springStiffness: 50,
      preserveViewport: true,
      gestureSettingsMouse: {
        clickToZoom: false,
      },
      opacity: 1,
    });

    this.addHandler('canvas-key', (event: any) => {
      // Case-insensitive so Shift+R (key "R") is caught too — OSD binds r/R to
      // rotate the viewport, which we disallow entirely (Shift+R is the drawing
      // tool's filled-rectangle hotkey and must not also spin the map).
      if (['q', 'w', 'e', 'r', 'a', 's', 'd', 'f'].includes(event.originalEvent.key.toLowerCase())) {
        event.preventDefaultAction = true;
      }
    });

    this.world.addHandler('remove-item', (event: any) => {
      const item = event.item;
      item.removeAllHandlers('fully-loaded-change');
      this.failedItems.delete(item);
      this.notifyLoadingStatus();
    });

    this.addHandler('tile-load-failed', (event: any) => {
      const item = event.tiledImage;
      if (item) {
        this.failedItems.add(item);
        this.notifyLoadingStatus();
      }
    });

    this.world.addHandler('add-item', (event: any) => {
      const item = event.item;
      item.addHandler('fully-loaded-change', () => this.notifyLoadingStatus());
      if ('Image' in item.source) {
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
    return this.viewer.canvas || this.viewer.element.querySelector('.openseadragon-canvas');
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
    let sources = getTileData(mapName).map(tileData => tileData.url);
    // Light mode on the dynamic map: skip left/right PW backgrounds, keep only middle.
    if (mapName === 'dynamic-main-branch' && isLightMode()) {
      sources = sources.filter(url => !/-left\.|-right\./.test(url));
    }
    return sources;
  }

  // Cached natural size of the simplistic-background PNG, loaded once.
  private static _bgNatural: { w: number; h: number } | null = null;
  private static async loadBgNatural(): Promise<{ w: number; h: number }> {
    if (this._bgNatural) return this._bgNatural;
    const img = new Image();
    img.src = BG_PERF_URL;
    await img.decode();
    this._bgNatural = { w: img.naturalWidth, h: img.naturalHeight };
    return this._bgNatural;
  }

  /** Build flat-image tile sources for the simplistic background: one
   *  `bg_perf_mode.png` per PW, anchored at each PW's real top-left (read from
   *  the bundled dziContent — no network) and displayed at CHUNK_SIZE per px.
   *  Setting `width` alone preserves aspect ratio, so 1px -> 512px on both
   *  axes per the user's spec. */
  private static async getSimplisticSources(mapName: MapName): Promise<any[]> {
    const { w } = await this.loadBgNatural();
    const displayW = w * CHUNK_SIZE;
    let data = getTileData(mapName);
    // Match getTileSources light-mode parity: drop left/right PW backgrounds.
    if (mapName === 'dynamic-main-branch' && isLightMode()) {
      data = data.filter(d => !/-left\.|-right\./.test(d.url));
    }
    return data.map(d => {
      const dz = JSON.parse(d.dziContent).Image;
      return {
        // `__simplisticBase` marks this as a persistent base layer so the
        // telescope bridge's overlay-cleanup predicates don't treat it as a
        // stale dynamic tile and purge it after generation renders.
        tileSource: { type: 'image', url: BG_PERF_URL, buildPyramid: false, __simplisticBase: true },
        x: Number(dz.TopLeft.X),
        y: Number(dz.TopLeft.Y),
        width: displayW,
      };
    });
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
    this.listeners.forEach(fn => fn(isLoading));
  }

  onLoading(cb: (isLoading: boolean) => void) {
    this.listeners.push(cb);
  }

  private onOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isOpen()) return resolve();
      this.addHandler('open-failed', reject);
      this.addOnceHandler('open', _event => {
        this.removeHandler('open-failed', reject);
        resolve();
      });
    });
  }

  getCombinedItemsRect(): any {
    if (this.world.getItemCount() === 0) return this.world.getHomeBounds();
    // True union of the DZI items' rects. Dynamic maps stack baked/composite
    // layers ON TOP of the static base DZIs, so summing widths (the old code)
    // produced a rect several times wider than the world and goto/home gained
    // huge dead space to the right. Non-DZI sources (marker/POI overlay tile
    // sources, which can overhang the world rect) are excluded.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let found = false;
    for (let i = 0; i < this.world.getItemCount(); i++) {
      const tiledImage = this.world.getItemAt(i);
      if (!('Image' in tiledImage.source)) continue;
      const item = tiledImage.getBoundsNoRotate();
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
      found = true;
    }
    if (!found) return this.world.getHomeBounds();
    return new OpenSeadragon.Rect(minX, minY, maxX - minX, maxY - minY);
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
    if (this.mapName === null) throw new Error('this.mapName should not be null');
    if (this.cacheBustHandler) this.world.removeHandler('add-item', this.cacheBustHandler);
    const versions = await fetchMapVersions(this.mapName);
    this.cacheBustHandler = (event: any) => {
      const source = event.item.source as any;
      // Baked daily DZIs carry their own per-bake cache-bust (set in
      // addBakedDZIsToOSD from the manifest). Don't clobber it.
      if (source.__bakedDzi || source.__bakedBust) return;
      if (typeof source.tilesUrl === 'string') {
        try {
          const version = versions[new URL(source.tilesUrl).origin];
          // Only bust origins we have a real version for. Unknown origins
          // (e.g. the daily workers) would otherwise get a constant
          // "?v=undefined" that never changes across bakes -> stale tiles.
          if (version !== undefined) source.queryParams = `?v=${version}`;
        } catch (e) {}
      }
    };
    this.world.addHandler('add-item', this.cacheBustHandler!);
  }

  async setMap(mapName: MapName, pos?: ZoomPos): Promise<void> {
    if (mapName === this.mapName) return;
    this.mapName = mapName;
    await this.bindCacheBustHandler();
    this.world.removeAll();
    let sources: any = AppOSD.getTileSources(mapName);
    // Simplistic background only applies to the dynamic map (its PNG is sized
    // to that map's per-PW geometry, and the toggle is only offered there).
    if (isSimplisticBackground() && mapName === 'dynamic-main-branch') {
      // The flat-PNG background is an optional perf asset. If it can't be
      // loaded/decoded, fall back to the normal tile sources instead of
      // letting the rejection bubble up and abort the whole app init.
      try {
        sources = await AppOSD.getSimplisticSources(mapName);
      } catch (e) {
        console.warn('[AppOSD] Simplistic background unavailable, using normal tiles:', e);
      }
    }
    this.open(sources);
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

  /** Fly to a POI with a single camera clock. False means interrupted. */
  panToTarget(x: number, y: number, opts?: { offsetXPx?: number }): Promise<boolean> {
    this.cancelActivePan();
    this.removePanTrail();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(false);
    const viewport = this.viewport;
    // Read the rendered position, not the target of an unfinished OSD spring.
    const here = viewport.getCenter(true);
    const startZoom = viewport.getZoom(true);
    const canvas = this.viewer.canvas as HTMLElement;
    const width = canvas?.clientWidth || 1200;
    const height = canvas?.clientHeight || 800;
    const offset = Math.max(0, Math.min(opts?.offsetXPx ?? 0, (width - 1) / 2));
    const visibleWidth = width - offset * 2;
    const endZoom = Math.min(visibleWidth, height) / (CHUNK_SIZE * width);
    const startVisibleX = here.x - offset / (width * startZoom);
    const distance = Math.hypot(startVisibleX - x, here.y - y);
    const curve = createPanCurve(startVisibleX, here.y, x, y);
    const startLog = Math.log(startZoom), endLog = Math.log(endZoom);
    const midpointX = (curve.x1 + 2 * curve.cxW + curve.x2) / 4;
    const midpointY = (curve.y1 + 2 * curve.cyW + curve.y2) / 4;
    // At the overview, fit the entire arrow around the camera's actual curved
    // route midpoint, including the part of the canvas covered by a sidebar.
    const spanX = Math.max(CHUNK_SIZE, 2.3 * Math.max(
      Math.abs(curve.x1 - midpointX), Math.abs(curve.cxW - midpointX), Math.abs(curve.x2 - midpointX)));
    const spanY = Math.max(CHUNK_SIZE, 2.3 * Math.max(
      Math.abs(curve.y1 - midpointY), Math.abs(curve.cyW - midpointY), Math.abs(curve.y2 - midpointY)));
    const overviewZoom = Math.min(startZoom, endZoom, visibleWidth / (width * spanX), height / (width * spanY));
    const overviewLog = Math.log(overviewZoom);
    const hasOverview = distance > CHUNK_SIZE / 2;
    const duration = Math.min(1800, 650 + 180 * Math.log2(1 + distance / CHUNK_SIZE));
    const ease = (t: number) => t * t * (3 - 2 * t);
    const apply = (t: number) => {
      const u = ease(t);
      // Preserve the cinematic zoom-out / travel / zoom-in. Separate monotonic
      // legs meet with zero zoom velocity: no additive pulse and no extra
      // in/out reversals while the camera keeps moving along the arrow.
      const logZoom = !hasOverview ? startLog + (endLog - startLog) * u
        : t <= .5 ? startLog + (overviewLog - startLog) * ease(t * 2)
        : overviewLog + (endLog - overviewLog) * ease(t * 2 - 1);
      const zoom = t === 1 ? endZoom : Math.exp(logZoom);
      viewport.zoomTo(zoom, null, true);
      const v = 1 - u;
      // Follow the arrow, with the visible (sidebar-free) center on the curve.
      viewport.panTo(new OpenSeadragon.Point(
        v * v * curve.x1 + 2 * v * u * curve.cxW + u * u * curve.x2 + offset / (width * zoom),
        v * v * curve.y1 + 2 * v * u * curve.cyW + u * u * curve.y2,
      ), true);
    };
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply(1);
      return Promise.resolve(true);
    }
    if (hasOverview) this.addPanTrail(curve);
    return new Promise<boolean>(resolve => {
      const start = performance.now();
      const events = ['canvas-drag', 'canvas-scroll', 'canvas-press', 'canvas-key', 'close'];
      const cleanup = () => {
        for (const event of events) this.viewer.removeHandler(event, interrupt);
        this.activePanCancel = null;
      };
      const interrupt = () => { this.cancelActivePan(); this.removePanTrail(); };
      this.activePanCancel = () => { cleanup(); resolve(false); };
      const tick = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / duration));
        apply(t);
        if (t < 1) this.activePanRaf = requestAnimationFrame(tick);
        else {
          this.activePanRaf = 0;
          cleanup();
          this.addPulseMarker(x, y);
          this.panTimer = setTimeout(() => { this.removePanTrail(); this.panTimer = undefined; }, 400);
          resolve(true);
        }
      };
      for (const event of events) this.viewer.addHandler(event, interrupt);
      this.activePanRaf = requestAnimationFrame(tick);
    });
  }

  private panTimer: any = undefined;
  private activePanRaf: number = 0;
  private activePanCancel: (() => void) | null = null;

  /** Stop any active fly-to animation immediately. Called by the next pan
   *  before it kicks off so we don't have two rAF loops fighting over the
   *  viewport. */
  private cancelActivePan(): void {
    if (this.activePanCancel) {
      this.activePanCancel();
      this.activePanCancel = null;
    }
    if (this.activePanRaf) {
      cancelAnimationFrame(this.activePanRaf);
      this.activePanRaf = 0;
    }
    if (this.panTimer) {
      clearTimeout(this.panTimer);
      this.panTimer = undefined;
    }
  }

  /** Add an SVG trail line overlay connecting origin to destination */
  private addPanTrail(curve: PanCurve) {
    this.removePanTrail();
    const container = this.viewer.container as HTMLElement;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'pan-trail-svg');
    svg.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 9999; overflow: hidden; contain: strict;
    `;

    // Unique IDs per-instance — if two trails ever co-exist (shouldn't, but be
    // safe) their <defs> won't collide.
    const uid = `pt-${Math.random().toString(36).slice(2, 8)}`;
    const gradId = `${uid}-grad`;
    const arrowId = `${uid}-arrow`;
    const trailColor = 'oklch(72% 0.18 152)';
    const trailColorBright = 'oklch(82% 0.21 152)';

    // No SVG filters: long offscreen paths otherwise allocate huge blur surfaces.
    // The gradient runs along the line in user-space coords so the trail
    // fades up from a faint tail to a bright arrowhead. Endpoints get updated
    // every frame in updatePanTrailPositions(). Opacities are bumped so the
    // tail is still clearly readable instead of fading into the map.
    svg.innerHTML = `
      <defs>
        <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stop-color="${trailColor}" stop-opacity="0.55"/>
          <stop offset="60%"  stop-color="${trailColor}" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="${trailColorBright}" stop-opacity="1"/>
        </linearGradient>
        <marker id="${arrowId}" viewBox="0 0 12 12" refX="10" refY="6"
                markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M 0 0 L 12 6 L 0 12 L 3 6 Z"
                fill="${trailColorBright}"
                stroke="${trailColorBright}" stroke-linejoin="round" stroke-width="1"/>
        </marker>
      </defs>
    `;

    // Project the shared world-space route into the current viewport.
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'pan-trail-line');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', `url(#${gradId})`);
    path.setAttribute('stroke-width', '4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('marker-end', `url(#${arrowId})`);
    svg.appendChild(path);

    // Destination: a small filled dot plus a thin outer ring for a "target"
    // motif. Subtler than the old fat green blob.
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'pan-trail-ring');
    ring.setAttribute('r', '10');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', trailColorBright);
    ring.setAttribute('stroke-width', '1.5');
    ring.setAttribute('stroke-opacity', '0.7');
    svg.appendChild(ring);

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'pan-trail-dot');
    dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', trailColorBright);
    svg.appendChild(dot);

    // Pick up the gradient element so we can update its endpoints per frame.
    const gradient = svg.querySelector(`#${gradId}`) as SVGLinearGradientElement;

    container.appendChild(svg);

    // The camera evaluates this exact same, fixed world-space curve.
    this.panTrailData = { svg, path, dot, ring, gradient, ...curve };
    this.updatePanTrailPositions();

    // Listen to viewport changes to update line positions
    this.panTrailViewportHandler = () => this.updatePanTrailPositions();
    this.viewer.addHandler('update-viewport', this.panTrailViewportHandler);
  }

  private panTrailData: {
    svg: SVGSVGElement;
    path: SVGPathElement;
    dot: SVGCircleElement;
    ring: SVGCircleElement;
    gradient: SVGLinearGradientElement;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cxW: number;
    cyW: number;
  } | null = null;
  private panTrailViewportHandler: (() => void) | null = null;

  private updatePanTrailPositions() {
    if (!this.panTrailData) return;
    const { path, dot, ring, gradient, x1, y1, x2, y2, cxW, cyW } = this.panTrailData;
    const viewport = this.viewport;
    const p1 = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x1, y1));
    const p2 = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x2, y2));
    // World control point → pixel control point. Because the viewport
    // transform is uniform-scale + translate, this preserves the arc's
    // shape: the curve looks identical relative to the line at every zoom
    // level. No more "warping" or direction flips during the cinematic.
    const cp = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(cxW, cyW));

    path.setAttribute('d', `M ${p1.x} ${p1.y} Q ${cp.x} ${cp.y} ${p2.x} ${p2.y}`);

    // Gradient runs along the straight start→end vector. Userspace coords so
    // the fade tracks the trail no matter how big the canvas is.
    gradient.setAttribute('x1', String(p1.x));
    gradient.setAttribute('y1', String(p1.y));
    gradient.setAttribute('x2', String(p2.x));
    gradient.setAttribute('y2', String(p2.y));

    dot.setAttribute('cx', String(p2.x));
    dot.setAttribute('cy', String(p2.y));
    ring.setAttribute('cx', String(p2.x));
    ring.setAttribute('cy', String(p2.y));
  }

  private removePanTrail() {
    if (this.panTrailViewportHandler) {
      this.viewer.removeHandler('update-viewport', this.panTrailViewportHandler);
      this.panTrailViewportHandler = null;
    }
    if (this.panTrailData) {
      this.panTrailData.svg.remove();
      this.panTrailData = null;
    }
  }

  /** Add a pulsing circle at the destination that fades out */
  private addPulseMarker(x: number, y: number) {
    // Remove any existing pulse
    const old = this.viewer.container.querySelector('.pan-pulse-marker');
    if (old) old.remove();

    const el = document.createElement('div');
    el.className = 'pan-pulse-marker';
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
