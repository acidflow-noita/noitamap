import { clipTerrainPixels, type TerrainPixelRect } from './terrain-pixel-clip';

/** Partition presented frames by physical pixel centers, including rotation.
 * Complementary antialiased clips do not compose to an opaque pixel. Each
 * screen pixel must belong to exactly one terrain frame instead. */
export function clipTerrainPresentation(context: CanvasRenderingContext2D, rectangles: TerrainPixelRect[]): void {
  const m = context.getTransform();
  if (m.b === 0 && m.c === 0) { clipTerrainPixels(context, rectangles); return; }
  context.resetTransform();
  context.beginPath();
  for (const r of rectangles) {
    const corners = [[r.x, r.y], [r.x + r.width, r.y],
      [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]]
      .map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
    const first = Math.max(0, Math.ceil(Math.min(...corners.map(p => p.y)) - .5));
    const end = Math.min(context.canvas.height, Math.ceil(Math.max(...corners.map(p => p.y)) - .5));
    let run: { left: number; right: number; y: number; height: number } | undefined;
    const flush = () => { if (run) context.rect(run.left, run.y, run.right - run.left, run.height); };
    for (let y = first; y < end; y++) {
      const line = y + .5, intersections: number[] = [];
      for (let edge = 0; edge < 4; edge++) {
        const a = corners[edge], b = corners[(edge + 1) % 4];
        if (line < Math.min(a.y, b.y) || line >= Math.max(a.y, b.y)) continue;
        intersections.push(a.x + (line - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      if (intersections.length < 2) continue;
      const left = Math.max(0, Math.ceil(Math.min(...intersections) - .5));
      const right = Math.min(context.canvas.width, Math.ceil(Math.max(...intersections) - .5));
      if (right <= left) continue;
      if (run && run.left === left && run.right === right && run.y + run.height === y) run.height++;
      else { flush(); run = { left, right, y, height: 1 }; }
    }
    flush();
  }
  context.clip();
  context.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}
