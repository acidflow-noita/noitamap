import { isMainPathBiome } from './data_sources/main-path-biomes';
import type { CameraMatrix } from './portals/geometry';

declare const OpenSeadragon: any;
export interface ReportHighlightTarget { worldX: number; worldY: number; pw?: number; biome?: string; id?: string }
interface Cluster { x: number; y: number; count: number; primary: boolean; mainPath: boolean }
/** Group only nearby screen pixels; never invent coordinates or move the camera. */
export function projectReportHighlights(targets: readonly ReportHighlightTarget[], m: CameraMatrix, width: number, height: number): Cluster[] {
  if (![...Object.values(m), width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const cells = new Map<string, Cluster>(), seen = new Set<string>();
  for (const target of targets) {
    if (!Number.isFinite(target.worldX) || !Number.isFinite(target.worldY)) continue;
    const location = `${target.worldX}:${target.worldY}`;
    if (seen.has(location)) continue;
    seen.add(location);
    const x = m.a * target.worldX + m.c * target.worldY + m.e;
    const y = m.b * target.worldX + m.d * target.worldY + m.f;
    if (x < 0 || y < 0 || x > width || y > height) continue;
    const mainPath = isMainPathBiome(target.biome), primary = mainPath && (target.pw ?? 0) === 0;
    const key = `${Math.floor(x / 24)}:${Math.floor(y / 24)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.count++;
      if (primary && !cell.primary) { cell.x = x; cell.y = y; }
      cell.primary ||= primary; cell.mainPath ||= mainPath;
    } else cells.set(key, { x, y, count: 1, primary, mainPath });
  }
  // Draw main-world/main-path locations last, so they remain prominent.
  return [...cells.values()].sort((a, b) => Number(a.primary) - Number(b.primary));
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
  private targets: readonly ReportHighlightTarget[] = [];
  private frame = 0;
  constructor(private viewer: any) {
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;contain:strict;z-index:20;display:none';
    viewer.container.append(this.svg);
    viewer.addHandler('update-viewport', this.schedule);
    viewer.addHandler('resize', this.schedule);
    viewer.addHandler('close', this.clear);
  }
  setTargets(targets: readonly ReportHighlightTarget[]) {
    this.targets = targets.slice();
    if (!this.targets.length) { this.clear(); return; }
    this.schedule();
  }
  private schedule = () => {
    if (this.targets.length && !this.frame) this.frame = requestAnimationFrame(this.draw);
  };
  private draw = () => {
    this.frame = 0;
    if (!this.targets.length) return;
    const viewport = this.viewer.viewport, canvas = this.viewer.canvas;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const p = (x: number, y: number) => viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
    const origin = p(0, 0), x = p(1, 0), y = p(0, 1);
    const matrix = { a: x.x - origin.x, b: x.y - origin.y, c: y.x - origin.x, d: y.y - origin.y, e: origin.x, f: origin.y };
    if (viewport.getFlip?.()) { matrix.a *= -1; matrix.c *= -1; matrix.e = width - matrix.e; }
    const clusters = projectReportHighlights(this.targets, matrix, width, height);
    const nodes = clusters.map(cluster => {
      const group = svgNode('g', { transform: `translate(${cluster.x},${cluster.y})`, 'data-main-path': String(cluster.mainPath), 'data-primary': String(cluster.primary) });
      const radius = cluster.primary ? 12 : cluster.mainPath ? 10 : 8;
      // Plain strokes, not blur/glow filters or another continuously animating loop.
      group.append(svgNode('circle', { r: String(radius), fill: cluster.count > 1 ? '#15202b' : 'none', stroke: '#10151b', 'stroke-width': '5' }),
        svgNode('circle', { r: String(radius), fill: 'none', stroke: cluster.mainPath ? '#8ee7f0' : '#ffffff', 'stroke-width': cluster.primary ? '3' : '2' }));
      if (cluster.count > 1) {
        const label = svgNode('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#ffffff', 'font-size': '10', 'font-family': 'system-ui' });
        label.textContent = String(cluster.count); group.append(label);
      }
      return group;
    });
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.replaceChildren(...nodes); this.svg.style.display = clusters.length ? '' : 'none';
  };
  clear = () => {
    this.targets = []; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0;
    this.svg.replaceChildren(); this.svg.style.display = 'none';
  };
  destroy() {
    this.clear(); this.viewer.removeHandler('update-viewport', this.schedule);
    this.viewer.removeHandler('resize', this.schedule); this.viewer.removeHandler('close', this.clear); this.svg.remove();
  }
}
