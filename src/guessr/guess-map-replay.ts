import type { Bounds } from './rules.ts';

export const mapActions = ['map-view', 'map-pan', 'map-zoom-in', 'map-zoom-out', 'map-home', 'map-center'] as const;
export type MapReplayAction = typeof mapActions[number];
/** Normalized center and logarithmic visible world width/height. Both axes survive a change of screen aspect. */
export interface MapPose { x: number; y: number; w: number; h: number }
export interface MapFrame { at: number; action: MapReplayAction; map: MapPose }
export interface MapPacket { base: number; data: string; partial?: true }
export const MAP_RECORD_CHARS = 20; // Fifteen bytes per camera, including its private timestamp.
export const MAP_PACKET_LIMIT = 192; // 3840 characters, leaving room for the clue batch in an 8 KiB socket frame.
const axis = 0xffffff;
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n)));
const span = (size: number) => clamp(32768 + 2048 * Math.log2(size), 65535);

export function mapPose(view: Bounds, world: Bounds): MapPose {
  return { x:clamp(axis * (view.x + view.width / 2 - world.x) / world.width, axis),
    y:clamp(axis * (view.y + view.height / 2 - world.y) / world.height, axis),
    w:span(view.width / world.width), h:span(view.height / world.height) };
}
export function mapView(pose: MapPose, world: Bounds): Bounds {
  const width = world.width * 2 ** ((pose.w - 32768) / 2048);
  const height = world.height * 2 ** ((pose.h - 32768) / 2048);
  return { x: world.x + world.width * pose.x / axis - width / 2,
    y: world.y + world.height * pose.y / axis - height / 2, width, height };
}
export function encodeMapFrames(frames: MapFrame[], base: number): string {
  const bytes = new Uint8Array(frames.length * 15), view = new DataView(bytes.buffer);
  frames.forEach(({at, action, map: {x, y, w, h}}, i) => {
    const p = i * 15;
    view.setUint32(p, at - base);
    bytes[p + 4] = x >> 16; view.setUint16(p + 5, x);
    bytes[p + 7] = y >> 16; view.setUint16(p + 8, y);
    view.setUint16(p + 10, w); view.setUint16(p + 12, h); bytes[p + 14] = mapActions.indexOf(action);
  });
  return btoa(String.fromCharCode(...bytes));
}
export function decodeMapFrames(data: string, base: number, limit: number): MapFrame[] {
  if (typeof data !== 'string' || data.length % MAP_RECORD_CHARS || data.length > limit * MAP_RECORD_CHARS ||
    !Number.isSafeInteger(base) || base < 0 || base > Number.MAX_SAFE_INTEGER - 0xffffffff ||
    !/^[A-Za-z0-9+/]*$/.test(data)) throw Error('Invalid map recording');
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer), frames: MapFrame[] = [];
  for (let p = 0; p < bytes.length; p += 15) {
    const at = base + view.getUint32(p), action = mapActions[bytes[p + 14]];
    if (!action || (frames.length && at <= frames[frames.length - 1].at)) throw Error('Invalid map recording');
    frames.push({at, action, map:{x:(bytes[p + 4] << 16) | view.getUint16(p + 5),
      y:(bytes[p + 7] << 16) | view.getUint16(p + 8), w:view.getUint16(p + 10), h:view.getUint16(p + 12)}});
  }
  return frames;
}
