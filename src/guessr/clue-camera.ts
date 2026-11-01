/** Geometry for a continuous camera over the prepared, native-pixel images. */
export interface ClueImage {
  image: string;
  width: number;
  height: number;
}
export interface ClueSource {
  views?: Record<string, ClueImage>;
  /** Reusable images positioned relative to the hidden starting point. */
  frames?: PreparedFrame[];
}
export interface Camera {
  dx: number;
  dy: number;
  level: number;
}
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PreparedFrame extends ViewRect {
  image: string;
}
export const viewSize = (level: number) => ({
  width: 27 * 2 ** level,
  height: 12 * 2 ** level,
});
export const movementStep = (pixels: number) =>
  Math.min(pixels - 1, Math.max(1, Math.round(pixels * 0.9)));
export function cameraRect(camera: Camera): ViewRect {
  const size = viewSize(camera.level);
  return {
    x: Math.floor(camera.dx - size.width / 2),
    y: Math.floor(camera.dy - size.height / 2),
    ...size,
  };
}
export function preparedFrames(
  source: ClueSource,
  step = 256,
): PreparedFrame[] {
  if (source.frames) return source.frames.map((frame) => ({ ...frame }));
  return Object.entries(source.views ?? {}).map(([key, frame]) => {
    const [dx, dy] = key.split(",").map(Number);
    return {
      ...frame,
      x: Math.floor(dx * step - frame.width / 2),
      y: Math.floor(dy * step - frame.height / 2),
    };
  });
}
/** The fully zoomed-out image is the fixed exploration boundary. */
export function travelLimits(source: ClueSource, level: number) {
  const maximum = source.views?.["0,0,6"] ?? viewSize(6);
  const current = cameraRect({ dx: 0, dy: 0, level });
  const x = Math.floor(-maximum.width / 2),
    y = Math.floor(-maximum.height / 2);
  return {
    minX: x - current.x,
    maxX: x + maximum.width - current.x - current.width,
    minY: y - current.y,
    maxY: y + maximum.height - current.y - current.height,
  };
}
export function clampCamera(source: ClueSource, camera: Camera): Camera {
  const bounds = travelLimits(source, camera.level);
  return {
    level: camera.level,
    dx: Math.max(bounds.minX, Math.min(bounds.maxX, camera.dx)),
    dy: Math.max(bounds.minY, Math.min(bounds.maxY, camera.dy)),
  };
}
export function supportedCamera(source: ClueSource, camera: Camera): boolean {
  if (
    ![camera.dx, camera.dy, camera.level].every(Number.isInteger) ||
    camera.level < 0 ||
    camera.level > 6
  )
    return false;
  const bounds = travelLimits(source, camera.level);
  return (
    camera.dx >= bounds.minX &&
    camera.dx <= bounds.maxX &&
    camera.dy >= bounds.minY &&
    camera.dy <= bounds.maxY
  );
}
export function moveCamera(
  source: ClueSource,
  camera: Camera,
  east: number,
  south: number,
): Camera {
  const size = viewSize(camera.level);
  return clampCamera(source, {
    level: camera.level,
    dx: camera.dx + east * movementStep(size.width),
    dy: camera.dy + south * movementStep(size.height),
  });
}
export function intersection(a: ViewRect, b: ViewRect): ViewRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}
export function unionRect(a: ViewRect, b: ViewRect): ViewRect {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
function subtract(a: ViewRect, b: ViewRect): ViewRect[] {
  const cut = intersection(a, b);
  if (!cut) return [a];
  return [
    { x: a.x, y: a.y, width: a.width, height: cut.y - a.y },
    {
      x: a.x,
      y: cut.y + cut.height,
      width: a.width,
      height: a.y + a.height - cut.y - cut.height,
    },
    { x: a.x, y: cut.y, width: cut.x - a.x, height: cut.height },
    {
      x: cut.x + cut.width,
      y: cut.y,
      width: a.x + a.width - cut.x - cut.width,
      height: cut.height,
    },
  ].filter((r) => r.width > 0 && r.height > 0);
}
/** Prefer the smallest covering image. At image edges combine overlapping
 * prepared images, preserving the requested centre instead of snapping it. */
export function planView(
  source: ClueSource,
  rect: ViewRect,
  step = 256,
): PreparedFrame[] {
  const frames = preparedFrames(source, step).sort(
    (a, b) => a.width * a.height - b.width * b.height,
  );
  const one = frames.find(
    (f) =>
      f.x <= rect.x &&
      f.y <= rect.y &&
      f.x + f.width >= rect.x + rect.width &&
      f.y + f.height >= rect.y + rect.height,
  );
  if (one) return [one];
  let remaining = [rect];
  const selected: PreparedFrame[] = [];
  while (remaining.length) {
    let best: PreparedFrame | undefined,
      bestArea = 0;
    for (const frame of frames) {
      const area = remaining.reduce((sum, r) => {
        const cut = intersection(r, frame);
        return sum + (cut ? cut.width * cut.height : 0);
      }, 0);
      if (area > bestArea) {
        best = frame;
        bestArea = area;
      }
    }
    if (!best) throw new Error("This view is outside the prepared images.");
    selected.push(best);
    remaining = remaining.flatMap((r) => subtract(r, best!));
  }
  return selected;
}
