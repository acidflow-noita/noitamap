/** Private, exact starting-view eligibility. No decoding or image generation
 * at round time: the export already recorded the native nonblack pixels. */
import type { AreaDefinition } from "./area-rules.ts";
import { cameraRect, intersection } from "./clue-camera.ts";
import type { PrivateImageSet } from "./image-game-server.ts";
import type { Bounds, Point } from "./rules.ts";

export type ImageContent =
  | "empty"
  | "full"
  | { rectangles: string }
  | [number, number, number, number][];

function* contentRectangles(content: Exclude<ImageContent, string>) {
  if (Array.isArray(content)) yield* content;
  else {
    const bytes = Uint8Array.from(atob(content.rectangles), (char) =>
      char.charCodeAt(0),
    );
    if (bytes.length % 8)
      throw new Error("Invalid native image content index.");
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length; i += 8)
      yield [
        view.getUint16(i, true),
        view.getUint16(i + 2, true),
        view.getUint16(i + 4, true),
        view.getUint16(i + 6, true),
      ];
  }
}

/** Disjoint horizontal strips of a rectangle union, so overlapping views do
 * not make starts near tile seams or many terrain pixels more likely. */
function union(rectangles: Bounds[]): Bounds[] {
  const events = rectangles
    .flatMap((r, id) => [
      { y: r.y, id, start: true },
      { y: r.y + r.height, id, start: false },
    ])
    .sort((a, b) => a.y - b.y);
  const active = new Map<number, Bounds>();
  const result: Bounds[] = [];
  let i = 0;
  while (i < events.length) {
    const y = events[i].y;
    while (i < events.length && events[i].y === y) {
      const event = events[i++];
      if (event.start) active.set(event.id, rectangles[event.id]);
      else active.delete(event.id);
    }
    if (i === events.length || !active.size) continue;
    const height = events[i].y - y;
    let left: number | undefined,
      right = -Infinity;
    for (const r of [...active.values()].sort((a, b) => a.x - b.x)) {
      if (left !== undefined && r.x > right) {
        result.push({ x: left, y, width: right - left, height });
        left = r.x;
      } else if (left === undefined) left = r.x;
      right = Math.max(right, r.x + r.width);
    }
    if (left !== undefined)
      result.push({ x: left, y, width: right - left, height });
  }
  return result;
}

export interface StartSampler {
  readonly pixels: number;
  /** Private build input for the compact Worker sampler; never public clue data. */
  readonly rectangles: readonly Bounds[];
  contains(point: Point): boolean;
  sample(random: () => number): Point;
}

/** Keep the answer in its semantic area, but allow the visible terrain pixel
 * anywhere in the initial view, including across a biome or image boundary. */
export function prepareAreaStarts(
  index: PrivateImageSet,
  area: AreaDefinition,
): StartSampler {
  if (!area.runs?.length || !Number.isInteger(area.originY))
    throw new Error(`Area ${area.id}: missing starting-location mask.`);
  const c = index.capture;
  const initial = cameraRect({ dx: 0, dy: 0, level: 0 });
  const widest = cameraRect({ dx: 0, dy: 0, level: 6 });
  const allowed = {
    x: c.originX - widest.x,
    y: c.originY - widest.y,
    width: c.width - widest.width + 1,
    height: c.height - widest.height + 1,
  };
  const strips: Bounds[] = [];
  if (allowed.width > 0 && allowed.height > 0)
    for (const [row, start, end] of area.runs) {
      const mask = intersection(
        {
          x: -17920 + start * 512,
          y: area.originY! + row * 512,
          width: (end - start) * 512,
          height: 512,
        },
        allowed,
      );
      if (!mask) continue;
      const rectangles: Bounds[] = [];
      // Only inspect tiles that can contribute a pixel to these starting views.
      const firstX = Math.floor((mask.x + initial.x - c.originX) / c.tileSize);
      const firstY = Math.floor((mask.y + initial.y - c.originY) / c.tileSize);
      const lastX = Math.floor(
        (mask.x + mask.width - 1 + initial.x + initial.width - 1 - c.originX) /
          c.tileSize,
      );
      const lastY = Math.floor(
        (mask.y +
          mask.height -
          1 +
          initial.y +
          initial.height -
          1 -
          c.originY) /
          c.tileSize,
      );
      for (let y = firstY; y <= lastY; y++)
        for (let x = firstX; x <= lastX; x++) {
          const id = index.levels[c.maxLevel].images[`${x},${y}`];
          const image = index.images[id];
          if (!image?.content)
            throw new Error(
              "Native image content index is missing. Run the whole-map image export.",
            );
          if (image.content === "empty") continue;
          const core = {
            x: c.originX + x * c.tileSize,
            y: c.originY + y * c.tileSize,
            width: Math.min(c.tileSize, c.width - x * c.tileSize),
            height: Math.min(c.tileSize, c.height - y * c.tileSize),
          };
          const offsetX = core.x - (x ? c.overlap : 0);
          const offsetY = core.y - (y ? c.overlap : 0);
          const content: Bounds[] =
            image.content === "full"
              ? [core]
              : Array.from(
                  contentRectangles(image.content),
                  ([rx, ry, width, height]) => ({
                    x: offsetX + rx,
                    y: offsetY + ry,
                    width,
                    height,
                  }),
                );
          for (const rectangle of content) {
            const pixels = intersection(rectangle, core);
            if (!pixels) continue;
            // All integer centres whose initial window contains at least one of
            // these pixels. The +1 is essential for the half-open pixel edges.
            const eligible = intersection(mask, {
              x: pixels.x - initial.x - initial.width + 1,
              y: pixels.y - initial.y - initial.height + 1,
              width: pixels.width + initial.width - 1,
              height: pixels.height + initial.height - 1,
            });
            if (eligible) rectangles.push(eligible);
          }
        }
      strips.push(...union(rectangles));
    }
  const cumulative: number[] = [];
  let pixels = 0;
  for (const r of strips) {
    pixels += r.width * r.height;
    cumulative.push(pixels);
  }
  return {
    pixels,
    rectangles: strips,
    contains: (p) =>
      strips.some(
        (r) =>
          p.x >= r.x &&
          p.x < r.x + r.width &&
          p.y >= r.y &&
          p.y < r.y + r.height,
      ),
    sample(random) {
      if (!pixels)
        throw new Error(`Area ${area.id}: no starting views contain terrain.`);
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1)
        throw new Error("Random source must return a finite number in [0, 1)");
      let low = 0,
        high = strips.length - 1;
      const position = Math.min(pixels - 1, Math.floor(value * pixels));
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (cumulative[middle] <= position) low = middle + 1;
        else high = middle;
      }
      const r = strips[low],
        offset = position - (cumulative[low - 1] ?? 0);
      return {
        x: r.x + (offset % r.width),
        y: r.y + Math.floor(offset / r.width),
      };
    },
  };
}
