import type { PortalPlacement } from './placements';
export interface CameraMatrix { a:number;b:number;c:number;d:number;e:number;f:number }
export const MAX_CANVAS_PIXELS=2_000_000;
export const MAX_ACTIVE_PORTALS=192;
export const MAX_GPU_BYTES=256*1024*1024;
export function canvasResolution(width:number,height:number,dpr:number):number {
  return Math.min(2,Math.max(1,dpr||1),Math.sqrt(MAX_CANVAS_PIXELS/Math.max(1,width*height)));
}
export function visiblePortals(portals:PortalPlacement[],m:CameraMatrix,width:number,height:number,minPixels=0):PortalPlacement[]{
  if(![m.a,m.b,m.c,m.d,m.e,m.f,width,height].every(Number.isFinite)||width<=0||height<=0)return [];
  const scale=Math.hypot(m.a,m.b),rx=(Math.abs(m.a)*480+Math.abs(m.c)*320)/2,ry=(Math.abs(m.b)*480+Math.abs(m.d)*320)/2;
  return portals.filter(p=>{
    // Same visibility policy for every effect; no default zoom activation gate.
    if(160*scale<minPixels)return false;
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
