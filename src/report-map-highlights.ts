import { isMainPathBiome } from './data_sources/main-path-biomes';
import { readCameraMatrix, reprojectCamera, type CameraMatrix } from './portals/geometry';

declare const OpenSeadragon: any;
export interface ReportHighlightTarget { worldX: number; worldY: number; pw?: number; biome?: string; mainPath?: boolean; id?: string }
export interface ReportPanelBounds { left: number; top: number; right: number; bottom: number }
export interface ReportHighlightOptions {
  /** Browser client coordinates, as returned by the report's getBoundingClientRect(). */
  panelBounds?: ReportPanelBounds;
  /** False when clearing before an explicit navigation or replacing the map. */
  restore?: boolean;
  /** Keep ends temporary previews; overview commits one fit that row updates preserve. */
  camera?: 'fit' | 'keep' | 'overview';
  /** Draw these individual locations above the context, without clustering them. */
  activeTargets?: readonly ReportHighlightTarget[];
  /** De-emphasize the aggregate context while browsing individual locations. */
  dimContext?: boolean;
}
export interface ReportMapView { x: number; y: number; zoom: number }
type CameraView = ReportMapView;
interface Cluster { x: number; y: number; count: number; primary: boolean; mainPath: boolean }
interface WorldPoint { worldX: number; worldY: number; primary: boolean; mainPath: boolean }
interface WorldCluster extends WorldPoint { count: number; members: WorldPoint[] }

function reportPoints(targets: readonly ReportHighlightTarget[]): WorldPoint[] {
  const locations = new Map<string, WorldPoint>();
  for (const target of targets) {
    if (!Number.isFinite(target.worldX) || !Number.isFinite(target.worldY)) continue;
    const location = `${target.worldX}:${target.worldY}`;
    const mainPath = target.mainPath ?? isMainPathBiome(target.biome), primary = mainPath && (target.pw ?? 0) === 0;
    const existing = locations.get(location);
    if (existing) { existing.mainPath ||= mainPath; existing.primary ||= primary; }
    else locations.set(location, { worldX: target.worldX, worldY: target.worldY, mainPath, primary });
  }
  return [...locations.values()];
}
const locationKey = (point: WorldPoint) => `${point.worldX}:${point.worldY}`;
const pointGroups = (points: readonly WorldPoint[]): WorldCluster[] => points.map(point => ({ ...point, count: 1, members: [point] }));

/** Spatial buckets accelerate a real distance check; crossing a bucket edge
 * never splits nearby points. Representatives are actual POIs, not centroids.
 * Coarsening merges existing groups; refinement retains their representatives. */
function groupReportPoints(points: readonly WorldCluster[], distance: number, preferred: ReadonlySet<string> = new Set()): WorldCluster[] {
  const rank = (point: WorldPoint) => point.primary ? 2 : point.mainPath ? 1 : 0;
  const ordered = [...points].sort((a, b) => Number(preferred.has(locationKey(b))) - Number(preferred.has(locationKey(a)))
    || rank(b) - rank(a) || a.worldX - b.worldX || a.worldY - b.worldY);
  if (!(distance > 0) || !Number.isFinite(distance)) return ordered;
  const cells = new Map<string, WorldCluster[]>(), groups: WorldCluster[] = [];
  for (const point of ordered) {
    const x = Math.floor(point.worldX / distance), y = Math.floor(point.worldY / distance);
    let nearest: WorldCluster | undefined, nearestDistance = distance * distance;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const group of cells.get(`${x + dx}:${y + dy}`) ?? []) {
        const squared = (point.worldX - group.worldX) ** 2 + (point.worldY - group.worldY) ** 2;
        if (squared < nearestDistance) { nearest = group; nearestDistance = squared; }
      }
    }
    if (nearest) {
      nearest.count += point.count;
      for (const member of point.members) nearest.members.push(member);
      nearest.primary ||= point.primary; nearest.mainPath ||= point.mainPath;
    } else {
      const group = { ...point, members: [...point.members] }, key = `${x}:${y}`;
      const cell = cells.get(key);
      if (cell) cell.push(group); else cells.set(key, [group]);
      groups.push(group);
    }
  }
  return groups.sort((a, b) => Number(a.primary) - Number(b.primary));
}
function groupReportHighlights(targets: readonly ReportHighlightTarget[], distance: number): WorldCluster[] {
  return groupReportPoints(pointGroups(reportPoints(targets)), distance);
}
function reportClusterDistance(m: CameraMatrix) {
  const scale = Math.hypot(m.a, m.b), distance = 40 / scale;
  return Number.isFinite(distance) && distance > 0 ? distance : 0;
}
function projectGroups(groups: readonly WorldCluster[], m: CameraMatrix, width: number, height: number): Cluster[] {
  if (![...Object.values(m), width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  return groups.flatMap(group => {
    const point = projectReportPoint(group, m, width, height);
    return point ? [{ ...point, count: group.count, primary: group.primary, mainPath: group.mainPath }] : [];
  });
}
function projectReportPoint(point: { worldX: number; worldY: number }, m: CameraMatrix, width: number, height: number) {
  const x = m.a * point.worldX + m.c * point.worldY + m.e, y = m.b * point.worldX + m.d * point.worldY + m.f;
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= width && y <= height ? { x, y } : null;
}
/** Count groups are anchored in world space; clipping never changes membership. */
export function projectReportHighlights(targets: readonly ReportHighlightTarget[], m: CameraMatrix, width: number, height: number, clusterNearby = true): Cluster[] {
  return projectGroups(groupReportHighlights(targets, clusterNearby ? reportClusterDistance(m) : 0), m, width, height);
}

/** Largest unobstructed rectangle, in canvas pixels; handles offset canvases and floating panels. */
export function uncoveredReportMapRect(width: number, height: number, panel?: ReportPanelBounds, canvas?: ReportPanelBounds): ReportPanelBounds | null {
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const full = { left: 0, top: 0, right: width, bottom: height };
  if (!panel) return full;
  if (!Object.values(panel).every(Number.isFinite)) return null;
  const origin = canvas ?? full;
  const sx = width / (origin.right - origin.left), sy = height / (origin.bottom - origin.top);
  if (![sx, sy].every(n => Number.isFinite(n) && n > 0)) return null;
  const left = Math.max(0, Math.min(width, (panel.left - origin.left) * sx));
  const right = Math.max(0, Math.min(width, (panel.right - origin.left) * sx));
  const top = Math.max(0, Math.min(height, (panel.top - origin.top) * sy));
  const bottom = Math.max(0, Math.min(height, (panel.bottom - origin.top) * sy));
  if (right <= left || bottom <= top) return full;
  const candidates = [
    { ...full, right: left }, { ...full, left: right },
    { ...full, bottom: top }, { ...full, top: bottom },
  ];
  const area = (rect: ReportPanelBounds) => (rect.right - rect.left) * (rect.bottom - rect.top);
  return candidates.reduce((largest, rect) => area(rect) > area(largest) ? rect : largest);
}

/** Fit every finite target with marker padding, using the rendered transform (including rotation/flip).
 * A single target retains the user's zoom. Already-visible groups leave the camera untouched. */
export function fitReportHighlights(targets: readonly ReportHighlightTarget[], m: CameraMatrix, view: CameraView, rect: ReportPanelBounds): CameraView | null {
  const padding = 24;
  const width = rect.right - rect.left - 2 * padding, height = rect.bottom - rect.top - 2 * padding;
  const det = m.a * m.d - m.b * m.c;
  if (![...Object.values(m), ...Object.values(view), ...Object.values(rect), det].every(Number.isFinite)
    || rect.right - rect.left < 128 || rect.bottom - rect.top < 128 || view.zoom <= 0 || det === 0) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const target of targets) {
    if (!Number.isFinite(target.worldX) || !Number.isFinite(target.worldY)) continue;
    const x = m.a * target.worldX + m.c * target.worldY + m.e;
    const y = m.b * target.worldX + m.d * target.worldY + m.f;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (left === Infinity || (left >= rect.left + padding && right <= rect.right - padding
    && top >= rect.top + padding && bottom <= rect.bottom - padding)) return null;
  const scale = Math.min(1, width / (right - left || 1), height / (bottom - top || 1));
  // The actual pixel center also accounts for viewport margins and flipped canvases.
  const cx = m.a * view.x + m.c * view.y + m.e, cy = m.b * view.x + m.d * view.y + m.f;
  const dx = (left + right) / 2 - cx + (cx - (rect.left + rect.right) / 2) / scale;
  const dy = (top + bottom) / 2 - cy + (cy - (rect.top + rect.bottom) / 2) / scale;
  const result = { x: view.x + (m.d * dx - m.c * dy) / det,
    y: view.y + (m.a * dy - m.b * dx) / det, zoom: view.zoom * scale };
  return Object.values(result).every(Number.isFinite) && result.zoom > 0 ? result : null;
}

const NS = 'http://www.w3.org/2000/svg';
function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
/** Temporary report preview, independent of persistent map/search filters. */
export class ReportMapHighlights {
  private svg = svgNode('svg', { 'aria-hidden': 'true', class: 'report-map-highlights' });
  private contextLayer = svgNode('g', { class: 'report-highlight-context' });
  private activeLayer = svgNode('g', { class: 'report-highlight-active' });
  private targets: readonly ReportHighlightTarget[] = [];
  private targetKey = '';
  private targetSource: readonly ReportHighlightTarget[] | null = null;
  private points: WorldPoint[] = [];
  private groups: WorldCluster[] = [];
  private groupDistance = 0;
  private groupsDirty = true;
  private contextNodes = new Map<string, { node: SVGGElement; signature: string; transform?: string }>();
  private activeNodes = new Map<string, SVGGElement>();
  private navigation: { id: number; target: ReportHighlightTarget } | null = null;
  private renderedCamera: { matrix: CameraMatrix; width: number; height: number } | null = null;
  private contextCamera: { matrix: CameraMatrix; width: number; height: number } | null = null;
  private visibleContext: Array<{ cluster: WorldCluster; x: number; y: number }> = [];
  private contextProjectionDirty = true;
  private markersDirty = true;
  private frame = 0;
  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredFit = false;
  private returnTimer: ReturnType<typeof setTimeout> | undefined;
  private original: CameraView | null = null;
  private returning: CameraView | null = null;
  private options: ReportHighlightOptions = {};
  private changingCamera = false;
  private animatingCamera = false;
  private committedCamera = false;
  private manualCamera = false;
  private cameraInterrupted = false;
  private resizing = false;
  private resizeVersion = 0;
  private readonly inputEvents = ['canvas-drag', 'canvas-scroll', 'canvas-press', 'canvas-key', 'canvas-pinch'];
  private readonly cameraEvents = ['pan', 'zoom', 'rotate', 'flip'];
  constructor(private viewer: any) {
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;contain:strict;z-index:20;display:none';
    this.contextLayer.style.transition = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity 140ms ease';
    this.contextLayer.style.opacity = '1';
    this.svg.append(this.contextLayer, this.activeLayer);
    viewer.container.append(this.svg);
    viewer.addHandler('update-viewport', this.viewportChanged);
    viewer.addHandler('resize', this.resize);
    viewer.addHandler('close', this.close);
    viewer.addHandler('animation-finish', this.animationFinished);
    viewer.addHandler('report-navigation-start', this.navigationStarted);
    viewer.addHandler('report-navigation-end', this.navigationEnded);
    for (const event of this.inputEvents) viewer.addHandler(event, this.userInteraction);
    for (const event of this.cameraEvents) viewer.addHandler(event, event === 'zoom' ? this.zoomChanged : this.externalCameraChange);
  }
  setTargets(targets: readonly ReportHighlightTarget[], options: ReportHighlightOptions = {}) {
    const previousCamera = this.options.camera;
    const key = targets === this.targetSource ? this.targetKey : targets.map(target => `${target.worldX}:${target.worldY}:${target.pw ?? 0}:${target.mainPath ?? isMainPathBiome(target.biome)}`).sort().join('|');
    const sameGroup = this.targetKey === key;
    const samePreview = targets.length > 0 && sameGroup && (previousCamera ?? 'fit') === 'fit' && (options.camera ?? 'fit') === 'fit'
      && JSON.stringify(this.options.panelBounds) === JSON.stringify(options.panelBounds);
    this.targets = targets;
    this.targetSource = targets;
    this.targetKey = key;
    if (!sameGroup) {
      this.points = reportPoints(targets); this.groupsDirty = true;
      this.contextNodes.clear(); this.activeNodes.clear();
    }
    this.options = options;
    // Featured cards share one overview: changing its selected member must
    // not restart the debounce or interrupt the same temporary camera flight.
    if (samePreview) { this.schedule(); return; }
    this.cancelFit();
    if (!this.targets.length) {
      this.clear(options.camera !== 'keep' && options.camera !== 'overview' && options.restore !== false);
      return;
    }
    if (options.camera === 'keep') {
      // Expanding an aggregate or moving between its rows must never finish a
      // pending preview/return flight or later restore an abandoned origin.
      this.interruptCamera(true, true);
      if (!this.animatingCamera && !this.navigation) this.revealContext();
      this.schedule();
      return;
    }
    if (options.camera === 'overview') {
      this.interruptCamera(true);
      const current = this.view();
      let moving = false;
      if (current) {
        const next = this.fittedView(current);
        this.prepareGroups(next ?? current, current);
        if (next) { moving = true; this.moveCamera(next, undefined, true); }
      }
      if (!moving) this.revealContext();
      this.schedule();
      return;
    }
    // A new category hover after a highlight-only card starts its own preview
    // session. Suppression from the prior keep/overview session must not leak.
    if (previousCamera === 'keep' || previousCamera === 'overview') this.cameraInterrupted = false;
    if (this.returnTimer !== undefined) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    // Re-entering during our return flight continues the same preview session.
    // It must not be mistaken for an unrelated camera animation in fit().
    this.original ??= this.returning;
    this.returning = null;
    this.hideContext(true);
    this.schedule();
    if (!this.cameraInterrupted) this.fitTimer = setTimeout(this.fit, 250);
    else this.revealContext();
  }
  /** History records the view before a temporary hover, even during its return. */
  getReturnView(): ReportMapView | null {
    const view = this.original ?? this.returning ?? this.view();
    return view ? { ...view } : null;
  }
  /** Back is explicit navigation, so it must outlive subsequent marker updates. */
  restoreView(view: ReportMapView) {
    if (![view.x, view.y, view.zoom].every(Number.isFinite) || view.zoom <= 0) return;
    this.interruptCamera(true);
    this.moveCamera(view, undefined, true);
  }
  private cancelFit() {
    if (this.fitTimer !== undefined) clearTimeout(this.fitTimer);
    this.fitTimer = undefined;
    this.deferredFit = false;
  }
  private view(current = true): CameraView | null {
    const viewport = this.viewer.viewport, center = viewport.getCenter?.(current), zoom = viewport.getZoom?.(current);
    return center && [center.x, center.y, zoom].every(Number.isFinite) && zoom > 0 ? { x: center.x, y: center.y, zoom } : null;
  }
  private matrix(): CameraMatrix {
    const viewport = this.viewer.viewport;
    const p = (x: number, y: number) => viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
    return readCameraMatrix(p, this.viewer.canvas.clientWidth, viewport.getFlip?.());
  }
  private fit = () => {
    this.fitTimer = undefined;
    if (!this.targets.length || this.cameraInterrupted || this.options.camera === 'keep') return;
    const current = this.view(), destination = this.view(false);
    if (!current || !destination) { this.revealContext(); return; }
    // Let an existing map flight/spring finish; never take over its camera.
    const moving = Math.abs(current.zoom / destination.zoom - 1) > 1e-6
      || Math.hypot(current.x - destination.x, current.y - destination.y) * current.zoom > 1e-6;
    if (!this.original && moving) {
      // Back/overview owns this flight. A hovered category can wait for it,
      // while unrelated user navigation keeps its existing no-takeover rule.
      this.deferredFit = this.committedCamera;
      if (!this.deferredFit) this.revealContext();
      return;
    }
    // A new group may already fit the rendered view while the previous
    // preview is still flying elsewhere. Stop that flight before evaluating it.
    if (this.original && moving) this.moveCamera(current, true);
    const next = this.fittedView(current);
    this.prepareGroups(next ?? current, current);
    if (!next) { this.revealContext(); return; }
    this.original ??= current;
    this.moveCamera(next);
  };
  private fittedView(current: CameraView) {
    const canvas = this.viewer.canvas;
    const rect = uncoveredReportMapRect(canvas.clientWidth, canvas.clientHeight, this.options.panelBounds, canvas.getBoundingClientRect?.());
    return rect ? fitReportHighlights(this.targets, this.matrix(), current, rect) : null;
  }
  private moveCamera(view: CameraView, immediately = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, committed = false) {
    this.manualCamera = false;
    this.changingCamera = true;
    this.animatingCamera = !immediately;
    this.committedCamera = committed && !immediately;
    if (this.targets.length) this.revealContext();
    try {
      this.viewer.viewport.zoomTo(view.zoom, null, immediately);
      this.viewer.viewport.panTo(new OpenSeadragon.Point(view.x, view.y), immediately);
    } finally { this.changingCamera = false; }
    if (immediately) this.revealContext();
  }
  private animationFinished = () => {
    this.animatingCamera = false; this.committedCamera = false; this.returning = null;
    const fit = this.deferredFit; this.deferredFit = false;
    if (fit) this.fit();
    else if (!this.navigation) this.revealContext();
  };
  private externalCameraChange = () => { if (!this.changingCamera && !this.resizing) this.interruptCamera(false); };
  private zoomChanged = () => {
    if (!this.changingCamera && !this.resizing && !this.navigation) this.manualCamera = true;
    this.externalCameraChange();
  };
  private userInteraction = () => { this.interruptCamera(true); };
  private interruptCamera(freeze: boolean, preserveCommitted = false) {
    this.cancelFit();
    if (this.returnTimer !== undefined) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    this.original = null;
    this.returning = null;
    this.resizing = false;
    this.resizeVersion++;
    this.cameraInterrupted = this.targets.length > 0;
    if (preserveCommitted && this.committedCamera) return;
    if (freeze && this.animatingCamera) {
      const current = this.view();
      if (current) this.moveCamera(current, true);
    }
    this.animatingCamera = false;
    this.committedCamera = false;
    if (!this.navigation) this.revealContext();
  }
  private hideContext(immediate = false) {
    // New categories stay hidden until fitting; Go fades the existing context
    // concurrently with its camera, without adding a navigation delay.
    this.contextLayer.style.transition = immediate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'none' : 'opacity 140ms ease';
    this.contextLayer.style.opacity = '0';
  }
  private revealContext() {
    if (this.navigation) return;
    if (this.contextLayer.style.opacity === '1') return;
    this.contextLayer.style.transition = 'none';
    this.contextLayer.style.opacity = '1';
    this.schedule();
  }
  private navigationStarted = (event: { id: number; target: ReportHighlightTarget }) => {
    if (!event?.target || ![event.id, event.target.worldX, event.target.worldY].every(Number.isFinite)) return;
    this.interruptCamera(true);
    this.manualCamera = false;
    this.navigation = { id: event.id, target: { ...event.target } };
    this.hideContext(); this.schedule();
  };
  private navigationEnded = (event: { id: number }) => {
    if (this.navigation?.id !== event.id) return;
    this.navigation = null; this.schedule();
    if (!this.targets.length) { this.clear(false); return; }
    this.revealContext();
  };
  private viewportChanged = () => {
    if (!this.targets.length && !this.navigation) return;
    // OSD has already drawn this camera. A second RAF would project the old
    // camera immediately before OSD advances, leaving circles one frame behind.
    if (this.frame) cancelAnimationFrame(this.frame);
    this.draw();
  };
  private prepareGroups(next?: CameraView, current = this.view(), matrix = this.matrix()) {
    if (!this.groupsDirty) return;
    const ratio = next && current ? next.zoom / current.zoom : 1;
    this.groupDistance = reportClusterDistance(matrix) / ratio;
    this.groups = groupReportPoints(pointGroups(this.points), this.groupDistance);
    this.contextProjectionDirty = true;
    this.groupsDirty = false;
  }
  private updateManualGroups(matrix: CameraMatrix) {
    if (!this.manualCamera || this.animatingCamera || this.navigation || !this.groups.length) return;
    const distance = reportClusterDistance(matrix);
    // Keep at least 32px between anchors throughout the hysteresis interval.
    if (!(distance > 0) || (distance >= this.groupDistance / 1.25 && distance <= this.groupDistance * 1.25)) return;
    this.groups = distance > this.groupDistance
      ? groupReportPoints(this.groups, distance)
      : groupReportPoints(pointGroups(this.points), distance, new Set(this.groups.map(locationKey)));
    this.groupDistance = distance;
    this.contextProjectionDirty = true;
  }
  private resize = () => {
    this.schedule();
    // Caller-supplied panel bounds can become stale during resize. Return to
    // the original view rather than fitting into a guessed visible rectangle.
    this.cancelFit();
    this.original ??= this.returning;
    this.returning = null;
    if (!this.original) return;
    // OSD raises resize before its own synchronous pan/zoom corrections.
    // Let those complete before restoring, and ignore only those corrections.
    this.resizing = true;
    const version = ++this.resizeVersion;
    void Promise.resolve().then(() => {
      if (version !== this.resizeVersion) return;
      this.resizing = false;
      this.restore();
    });
  };
  private restore = () => {
    if (this.returnTimer !== undefined) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    const original = this.original;
    this.original = null;
    if (original) {
      this.returning = original;
      this.moveCamera(original);
      if (!this.animatingCamera) this.returning = null;
    }
  };
  private close = () => { this.clear(false); };
  private schedule = () => {
    this.markersDirty = true;
    if ((this.targets.length || this.navigation) && !this.frame) this.frame = requestAnimationFrame(this.draw);
  };
  private draw = () => {
    this.frame = 0;
    if (!this.targets.length && !this.navigation) return;
    const canvas = this.viewer.canvas;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const matrix = this.matrix();
    if (![...Object.values(matrix), width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
    const last = this.renderedCamera;
    if (!this.markersDirty && last && last.width === width && last.height === height
      && (Object.keys(matrix) as (keyof CameraMatrix)[]).every(key => matrix[key] === last.matrix[key])) return;
    this.markersDirty = false;
    this.renderedCamera = { matrix, width, height };
    const showContext = this.contextLayer.style.opacity !== '0';
    if (showContext) {
      const camera = this.contextCamera;
      this.prepareGroups(undefined, undefined, matrix);
      this.updateManualGroups(matrix);
      if (this.contextProjectionDirty || !camera || camera.width !== width || camera.height !== height
        || (Object.keys(matrix) as (keyof CameraMatrix)[]).some(key => matrix[key] !== camera.matrix[key])) {
        this.visibleContext = this.groups.flatMap(cluster => {
          const point = projectReportPoint(cluster, matrix, width, height);
          return point ? [{ cluster, ...point }] : [];
        });
        this.contextProjectionDirty = false;
      }
      if (this.contextLayer.hasAttribute('transform')) this.contextLayer.removeAttribute('transform');
      this.contextCamera = { matrix, width, height };
    } else if (this.contextCamera) {
      // During Go's brief opacity fade, move the whole cached layer at once.
      // Fully hidden context does no per-marker projection or DOM work.
      const delta = reprojectCamera(matrix, this.contextCamera.matrix);
      if (delta) this.contextLayer.setAttribute('transform', `matrix(${delta.a},${delta.b},${delta.c},${delta.d},${delta.e},${delta.f})`);
    }
    const selected = this.navigation ? [this.navigation.target] : this.options.activeTargets ?? [];
    const active = groupReportHighlights(selected, 0);
    const activeKeys = new Set(active.map(point => `${point.worldX}:${point.worldY}`));
    const strokeOpacity = this.options.dimContext && active.length ? '0.85' : '1';
    const nodes: SVGGElement[] = [], activeNodes: SVGGElement[] = [];
    for (const point of showContext ? this.visibleContext : []) {
      const { cluster } = point;
      const key = `${cluster.worldX}:${cluster.worldY}`, selectedAnchor = activeKeys.has(key);
      const signature = `${cluster.count}:${cluster.primary}:${cluster.mainPath}:${selectedAnchor}:${strokeOpacity}`;
      let cached = this.contextNodes.get(key);
      if (!cached || cached.signature !== signature) {
        const node = cached?.node ?? svgNode('g', { 'data-layer': 'context', 'data-location': key });
        node.setAttribute('data-main-path', String(cluster.mainPath)); node.setAttribute('data-primary', String(cluster.primary));
        node.replaceChildren();
        const radius = cluster.primary ? 12 : cluster.mainPath ? 10 : 8;
        // A selected anchor has one marker. A grouped count remains visible,
        // but its duplicate context ring is covered by the independent selection.
        if (!selectedAnchor) node.append(
          svgNode('circle', { r: String(radius), fill: cluster.count > 1 ? 'var(--surface-1, #0f172a)' : 'none', stroke: 'var(--surface-1, #0f172a)', 'stroke-width': '5' }),
          svgNode('circle', { r: String(radius), fill: 'none', stroke: 'var(--report-marker-context, #94a3b8)',
            'stroke-width': cluster.primary ? '3' : cluster.mainPath ? '2.5' : '1.5', 'stroke-opacity': strokeOpacity }));
        if (cluster.count > 1) {
          const label = svgNode('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: 'var(--report-marker-context, #94a3b8)', 'font-size': '10', 'font-family': 'system-ui' });
          label.textContent = String(cluster.count); node.append(label);
        }
        cached = { node, signature, transform: cached?.transform }; this.contextNodes.set(key, cached);
      }
      const transform = `translate(${point.x},${point.y})`;
      if (cached.transform !== transform) { cached.node.setAttribute('transform', transform); cached.transform = transform; }
      nodes.push(cached.node);
    }
    for (const target of active) {
      const point = projectReportPoint(target, matrix, width, height);
      if (!point) continue;
      const key = `${target.worldX}:${target.worldY}`;
      let node = this.activeNodes.get(key);
      if (!node) {
        node = svgNode('g', { 'data-layer': 'active', 'data-location': key });
        node.append(svgNode('circle', { r: '12', fill: 'none', stroke: 'var(--surface-1, #0f172a)', 'stroke-width': '5' }),
          svgNode('circle', { r: '12', fill: 'none', stroke: 'var(--report-marker-selected, #6ee7b7)', 'stroke-width': '3' }));
        this.activeNodes.set(key, node);
      }
      const transform = `translate(${point.x},${point.y})`;
      if (node.getAttribute('transform') !== transform) node.setAttribute('transform', transform);
      activeNodes.push(node);
    }
    if (!last || last.width !== width || last.height !== height) this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (showContext) this.syncNodes(this.contextLayer, nodes);
    this.syncNodes(this.activeLayer, activeNodes);
    this.svg.style.display = this.contextLayer.childElementCount || activeNodes.length ? '' : 'none';
  };
  private syncNodes(layer: SVGGElement, nodes: SVGGElement[]) {
    // Pan updates only transforms; preserve DOM identity and layer fades.
    let cursor = layer.firstElementChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else layer.insertBefore(node, cursor);
    }
    while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  }
  clear = (restore = true) => {
    this.cancelFit();
    if (this.returnTimer !== undefined) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    if (!restore) this.interruptCamera(true);
    this.targets = []; this.targetSource = null; this.targetKey = ''; this.points = []; this.groups = []; this.groupsDirty = true;
    // Leaving a hover must not take ownership of an explicit Go flight. Its
    // independent selected marker lasts until navigation-end; explicit clears
    // (report close, map replacement) still remove every report marker.
    if (!restore) this.navigation = null;
    this.renderedCamera = null; this.contextCamera = null; this.contextLayer.removeAttribute('transform');
    this.visibleContext = [];
    if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0;
    this.contextNodes.clear(); this.contextLayer.replaceChildren();
    if (this.navigation) this.schedule();
    else { this.activeNodes.clear(); this.activeLayer.replaceChildren(); this.svg.style.display = 'none'; }
    this.cameraInterrupted = false;
    // Crossing between neighboring rows keeps the original view, without a
    // return flight between each pointerleave/pointerenter pair.
    if (restore && this.original) this.returnTimer = setTimeout(this.restore, 120);
  };
  destroy() {
    this.clear(false); this.viewer.removeHandler('update-viewport', this.viewportChanged);
    this.viewer.removeHandler('resize', this.resize); this.viewer.removeHandler('close', this.close);
    this.viewer.removeHandler('animation-finish', this.animationFinished);
    this.viewer.removeHandler('report-navigation-start', this.navigationStarted);
    this.viewer.removeHandler('report-navigation-end', this.navigationEnded);
    for (const event of this.inputEvents) this.viewer.removeHandler(event, this.userInteraction);
    for (const event of this.cameraEvents) this.viewer.removeHandler(event, event === 'zoom' ? this.zoomChanged : this.externalCameraChange);
    this.svg.remove();
  }
}
