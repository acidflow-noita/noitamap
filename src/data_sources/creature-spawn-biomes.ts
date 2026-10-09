import spawnNames from '../data/spawn-biome-names.json';
import { biomeBoundaries } from '../drawing/biome-boundaries';
import { cameraPixelDelta, readCameraMatrix, type CameraMatrix } from '../portals/geometry';
import { uncoveredReportMapRect, type ReportMapView, type ReportPanelBounds } from '../report-map-highlights';
import { biomePathBounds, type BiomePathBounds } from './biome-path-bounds';

declare const OpenSeadragon: any;

export interface CreatureSpawnBiomes {
  supported: boolean;
  /** Exact boundary filenames, including every matching polygon's biome. */
  matched: string[];
  /** Original wiki names, retained so the card can translate and expose omissions. */
  missing: string[];
  bounds: BiomePathBounds | null;
}

const supportedMaps = new Set(['regular-main-branch', 'regular-beta', 'dynamic-main-branch']);
const canonical = (name: string) => name.replace(/^biome_/, '');
const normalized = (name: string) => name.replace(/&#0*39;|&apos;|’/g, "'").replace(/&amp;/g, '&').trim().toLowerCase();
const names = new Map(Object.entries(spawnNames).map(([name, id]) => [normalized(name), id]));
// Display-name translation IDs occasionally cover multiple distinct places.
// Match their authored geometry explicitly rather than lighting the wrong region.
const specific: Record<string, string[]> = {
  'lava lake': ['lavalake'],
  'the work (sky)': ['the_sky'],
  'the work (hell)': ['the_end'],
  'giant tree': ['mountain_tree'],
  'the tower': [...Array.from({ length: 10 }, (_, index) => `solid_wall_tower_${index + 1}`)],
  'tower': [...Array.from({ length: 10 }, (_, index) => `solid_wall_tower_${index + 1}`)],
};
const geometry = biomeBoundaries.map(boundary => ({ ...boundary, bounds: biomePathBounds(boundary.path) }));

/** Resolve against the SAME geometry the existing biome overlay actually draws.
 * Its paths are authored for NG0; never pretend they describe an NG+ layout. */
export function resolveCreatureSpawnBiomes(raw: string, mapName: string, ngPlus = 0): CreatureSpawnBiomes {
  const requested = raw.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .split(',').map(name => name.trim()).filter(Boolean);
  const supported = supportedMaps.has(mapName) && ngPlus === 0;
  const matched = new Set<string>(), missing: string[] = [];
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const name of new Set(requested)) {
    const key = normalized(name), exact = specific[key], id = names.get(key);
    const regions = supported ? geometry.filter(boundary => boundary.maps.includes(mapName) && boundary.bounds
      && (exact ? exact.includes(boundary.text) : id && canonical(boundary.biomeName ?? '') === canonical(id))) : [];
    if (!regions.length) { missing.push(name); continue; }
    for (const boundary of regions) {
      const bounds = boundary.bounds!;
      matched.add(boundary.text);
      left = Math.min(left, bounds.x); top = Math.min(top, bounds.y);
      right = Math.max(right, bounds.x + bounds.width); bottom = Math.max(bottom, bounds.y + bounds.height);
    }
  }
  return { supported, matched: [...matched], missing,
    bounds: matched.size ? { x: left, y: top, width: right - left, height: bottom - top } : null };
}

function overlayRoot() { return document.getElementById('osContainer'); }

/** Change classes only: the existing colors/paths remain intact for clearing. */
export function focusCreatureSpawnBiomes(result: CreatureSpawnBiomes, root: HTMLElement | null = overlayRoot()): boolean {
  if (!root || !result.supported || !result.bounds || !result.matched.length) return false;
  const selected = new Set(result.matched);
  const paths = [...root.querySelectorAll<HTMLElement>('.biome-overlay-path')];
  if (!paths.some(path => selected.has(path.dataset.biomeName ?? ''))) return false;
  root.classList.add('biome-spawn-focus');
  for (const path of paths) {
    const match = selected.has(path.dataset.biomeName ?? '');
    path.classList.toggle('biome-spawn-match', match);
    path.classList.toggle('biome-spawn-muted', !match);
  }
  return true;
}

export function clearCreatureSpawnBiomeFocus(root: HTMLElement | null = overlayRoot()): void {
  root?.classList.remove('biome-spawn-focus');
  root?.querySelectorAll('.biome-spawn-match, .biome-spawn-muted').forEach(path => {
    path.classList.remove('biome-spawn-match', 'biome-spawn-muted');
  });
}

/** Unlike a temporary report hover, an explicit spawn link fits its regions
 * both in and out. The existing rendered transform handles rotation and flip. */
export function fitCreatureSpawnBiomeBounds(bounds: BiomePathBounds, matrix: CameraMatrix,
  view: ReportMapView, rect: ReportPanelBounds, minZoom = 0, maxZoom = Infinity): ReportMapView | null {
  if (![...Object.values(bounds), ...Object.values(matrix), ...Object.values(view), ...Object.values(rect)].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || view.zoom <= 0) return null;
  const width = rect.right - rect.left - 48, height = rect.bottom - rect.top - 48;
  if (width <= 0 || height <= 0) return null;
  const projectedWidth = Math.abs(matrix.a) * bounds.width + Math.abs(matrix.c) * bounds.height;
  const projectedHeight = Math.abs(matrix.b) * bounds.width + Math.abs(matrix.d) * bounds.height;
  const zoom = Math.max(minZoom, Math.min(maxZoom, view.zoom * Math.min(width / projectedWidth, height / projectedHeight)));
  const scale = zoom / view.zoom;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const center = { x: matrix.a * view.x + matrix.c * view.y + matrix.e,
    y: matrix.b * view.x + matrix.d * view.y + matrix.f };
  const offset = cameraPixelDelta(matrix,
    (center.x - (rect.left + rect.right) / 2) / scale,
    (center.y - (rect.top + rect.bottom) / 2) / scale);
  return offset ? { x: bounds.x + bounds.width / 2 + offset.x, y: bounds.y + bounds.height / 2 + offset.y, zoom } : null;
}

/** Call after closing the originating card, so a restored report is excluded. */
export function frameCreatureSpawnBiomes(viewer: any, bounds: BiomePathBounds): boolean {
  const { canvas, viewport } = viewer;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const panel = document.querySelector<HTMLElement>('#seed-report-v3.open, #seed-report-sidebar.open');
  const panelBounds = panel && !panel.hidden && getComputedStyle(panel).display !== 'none' ? panel.getBoundingClientRect() : undefined;
  const rect = uncoveredReportMapRect(width, height, panelBounds, canvas.getBoundingClientRect());
  const center = viewport.getCenter(true), zoom = viewport.getZoom(true);
  if (!rect || !center) return false;
  const matrix = readCameraMatrix((x, y) => viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true), width, viewport.getFlip?.());
  const fit = fitCreatureSpawnBiomeBounds(bounds, matrix, { x: center.x, y: center.y, zoom }, rect,
    viewport.getMinZoom?.() ?? 0, viewport.getMaxZoom?.() ?? Infinity);
  if (!fit) return false;
  const immediately = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  viewport.zoomTo(fit.zoom, null, immediately);
  viewport.panTo(new OpenSeadragon.Point(fit.x, fit.y), immediately);
  return true;
}
