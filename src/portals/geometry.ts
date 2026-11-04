import type { PortalPlacement } from './placements';
export interface CameraMatrix { a:number;b:number;c:number;d:number;e:number;f:number }
/** Read OSD's rendered world-to-canvas transform. OSD's point conversion
 * includes rotation but leaves the drawer's horizontal flip to the caller. */
export function readCameraMatrix(project: (x: number, y: number) => { x: number; y: number }, width: number, flipped = false): CameraMatrix {
  const origin = project(0, 0), x = project(1, 0), y = project(0, 1);
  const matrix = { a: x.x - origin.x, b: x.y - origin.y, c: y.x - origin.x, d: y.y - origin.y, e: origin.x, f: origin.y };
  if (flipped) { matrix.a *= -1; matrix.c *= -1; matrix.e = width - matrix.e; }
  return matrix;
}
/** Convert a screen translation to world units using that same transform. */
export function cameraPixelDelta(matrix: CameraMatrix, dx: number, dy: number): { x: number; y: number } | null {
  const { a, b, c, d } = matrix, det = a * d - b * c;
  if (![a, b, c, d, dx, dy, det].every(Number.isFinite) || Math.abs(det) < 1e-30) return null;
  const result = { x: (d * dx - c * dy) / det, y: (a * dy - b * dx) / det };
  return Object.values(result).every(Number.isFinite) ? result : null;
}
export const MAX_CANVAS_PIXELS=2_000_000;
export const MAX_ACTIVE_PORTALS=192;
export const MAX_GPU_BYTES=256*1024*1024;
export const PORTAL_CORE_SIZE = 160;
export const PORTAL_ENTER_PIXELS = 18;
export const PORTAL_EXIT_PIXELS = 12;
// Match the map URL scale selected for the cutoff. Larger z means farther out.
export const PORTAL_STOP_LOG_ZOOM = 1334;
export const PORTAL_RESUME_LOG_ZOOM = 1294;
/** Hysteresis belongs to the presenter: a paused bitmap and GPU simulation can
 * be retained without asking the worker to erase/recreate its particle pools. */
export function portalZoomActive(matrix: CameraMatrix, active: boolean,
  enter = PORTAL_ENTER_PIXELS, exit = PORTAL_EXIT_PIXELS, mapZoom?: number): boolean {
  const pixels = PORTAL_CORE_SIZE * Math.hypot(matrix.a, matrix.b);
  if (!Number.isFinite(pixels) || pixels <= 0 || pixels < (active ? exit : enter)) return false;
  if (mapZoom === undefined || enter === 0 && exit === 0) return true;
  if (!Number.isFinite(mapZoom) || mapZoom <= 0) return false;
  // Use the same rounding as the URL, so a displayed z=1334 is already paused.
  const logZoom = Math.round(-100 * Math.log2(mapZoom));
  return active ? logZoom < PORTAL_STOP_LOG_ZOOM : logZoom <= PORTAL_RESUME_LOG_ZOOM;
}
export function canvasResolution(width:number,height:number,dpr:number):number {
  return Math.min(2,Math.max(1,dpr||1),Math.sqrt(MAX_CANVAS_PIXELS/Math.max(1,width*height)));
}
export function visiblePortals(portals:PortalPlacement[],m:CameraMatrix,width:number,height:number,minPixels=0):PortalPlacement[]{
  if(![m.a,m.b,m.c,m.d,m.e,m.f,width,height].every(Number.isFinite)||width<=0||height<=0)return [];
  const scale=Math.hypot(m.a,m.b),rx=(Math.abs(m.a)*480+Math.abs(m.c)*320)/2,ry=(Math.abs(m.b)*480+Math.abs(m.d)*320)/2;
  return portals.filter(p=>{
    // Geometry is also used independently of animation. The presenter owns the
    // default zoom gate and retained-frame transition.
    if(PORTAL_CORE_SIZE*scale<minPixels)return false;
    const x=m.a*p.x+m.c*p.y+m.e,y=m.b*p.x+m.d*p.y+m.f;
    return x+rx>=0&&y+ry>=0&&x-rx<=width&&y-ry<=height;
  });
}

/** Reproject the last completed frame immediately, independently of simulation.
 * current * inverse(rendered) maps rendered CSS pixels to current CSS pixels. */
export function reprojectCamera(current: CameraMatrix, rendered: CameraMatrix): CameraMatrix | null {
  const det = rendered.a * rendered.d - rendered.b * rendered.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const a = (current.a * rendered.d - current.c * rendered.b) / det;
  const b = (current.b * rendered.d - current.d * rendered.b) / det;
  const c = (current.c * rendered.a - current.a * rendered.c) / det;
  const d = (current.d * rendered.a - current.b * rendered.c) / det;
  const result = { a, b, c, d, e: current.e - a * rendered.e - c * rendered.f,
    f: current.f - b * rendered.e - d * rendered.f };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

/** Crop the completed bitmap to the union of visible render windows. A lone
 * portal must not transfer a mostly-black full-viewport bitmap every frame.
 * Bounds use the exact 480x320 upstream window, not a guessed particle radius. */
export function portalFrameBounds(portals: PortalPlacement[], m: CameraMatrix, width: number, height: number) {
  if (!portals.length) return { x: 0, y: 0, width: 1, height: 1 };
  const rx = (Math.abs(m.a) * 480 + Math.abs(m.c) * 320) / 2;
  const ry = (Math.abs(m.b) * 480 + Math.abs(m.d) * 320) / 2;
  let left = width, top = height, right = 0, bottom = 0;
  for (const portal of portals) {
    const x = m.a * portal.x + m.c * portal.y + m.e;
    const y = m.b * portal.x + m.d * portal.y + m.f;
    left = Math.min(left, x - rx); top = Math.min(top, y - ry);
    right = Math.max(right, x + rx); bottom = Math.max(bottom, y + ry);
  }
  left = Math.max(0, Math.floor(left)); top = Math.max(0, Math.floor(top));
  right = Math.min(width, Math.ceil(right)); bottom = Math.min(height, Math.ceil(bottom));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
