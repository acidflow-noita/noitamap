import { describe, expect, it } from "vitest";
import {
  cameraRect,
  clampCamera,
  intersection,
  moveCamera,
  movementStep,
  planView,
  supportedCamera,
  travelLimits,
  viewSize,
  type ClueSource,
} from "../src/guessr/clue-camera";

const source: ClueSource = {
  views: Object.fromEntries(
    Array.from({ length: 7 }, (_, level) =>
      Array.from({ length: 25 }, (_, i) => [
        `${(i % 5) - 2},${Math.floor(i / 5) - 2},${level}`,
        { ...viewSize(level), image: `${i}-${level}.webp` },
      ]),
    ).flat(),
  ),
};

describe("clue camera continuity", () => {
  it("moves 90% of the view with pixel rounding when there is room to move", () => {
    for (let level = 0; level < 6; level++)
      for (const [east, south] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const limits = travelLimits(source, level);
        const camera = {
            dx: east > 0 ? limits.minX : east < 0 ? limits.maxX : 0,
            dy: south > 0 ? limits.minY : south < 0 ? limits.maxY : 0,
            level,
          },
          before = cameraRect(camera),
          next = moveCamera(source, camera, east, south),
          after = cameraRect(next);
        const overlap = intersection(before, after)!;
        const dimension = east ? before.width : before.height;
        expect(Math.abs(east ? next.dx - camera.dx : next.dy - camera.dy)).toBe(
          movementStep(dimension),
        );
        expect(
          Math.abs((east ? overlap.width : overlap.height) - dimension * 0.1),
        ).toBeLessThanOrEqual(0.5);
        expect(next.dx !== 0 || next.dy !== 0).toBe(true);
        expect(supportedCamera(source, next)).toBe(true);
      }
    expect(moveCamera(source, { dx: 0, dy: 0, level: 0 }, 1, 0).dx).toBe(24);
    expect(moveCamera(source, { dx: 0, dy: 0, level: 0 }, 0, 1).dy).toBe(11);
  });
  it("reverses a move and clips movement at the prepared area boundary", () => {
    const start = { dx: 18, dy: 9, level: 0 };
    expect(moveCamera(source, moveCamera(source, start, 1, 0), -1, 0)).toEqual(
      start,
    );
    expect(moveCamera(source, { dx: 500, dy: -500, level: 6 }, 1, -1)).toEqual({
      dx: 0,
      dy: 0,
      level: 6,
    });
    expect(supportedCamera(source, { dx: 852, dy: 0, level: 0 })).toBe(false);
  });
  it("contains every zoom inside the widest origin image and disables movement at full zoom-out", () => {
    const maximum = cameraRect({ dx: 0, dy: 0, level: 6 });
    for (let level = 0; level <= 6; level++)
      for (const dx of [-5000, 0, 5000])
        for (const dy of [-5000, 0, 5000]) {
          const camera = clampCamera(source, { dx, dy, level }),
            rect = cameraRect(camera);
          expect(intersection(rect, maximum)).toEqual(rect);
          expect(supportedCamera(source, camera)).toBe(true);
        }
    for (const [east, south] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      expect(
        moveCamera(source, { dx: 0, dy: 0, level: 6 }, east, south),
      ).toEqual({ dx: 0, dy: 0, level: 6 });
  });
  it("covers off-grid views fully without snapping the requested camera centre to an image centre", () => {
    for (let level = 0; level <= 6; level++)
      for (const dx of [-512, -431, 6, 173, 512])
        for (const dy of [-512, -191, 3, 109, 512]) {
          const camera = { dx, dy, level },
            target = cameraRect(camera),
            plan = planView(source, target);
          expect(camera).toEqual({ dx, dy, level });
          // Independently sweep every horizontal band formed by source boundaries.
          const cuts = plan.map((f) => intersection(f, target)!);
          const rows = [
            ...new Set([
              target.y,
              target.y + target.height,
              ...cuts.flatMap((c) => [c.y, c.y + c.height]),
            ]),
          ].sort((a, b) => a - b);
          for (let i = 1; i < rows.length; i++) {
            const y = (rows[i - 1] + rows[i]) / 2;
            const intervals = cuts
              .filter((c) => y >= c.y && y < c.y + c.height)
              .sort((a, b) => a.x - b.x);
            let covered = target.x;
            for (const c of intervals) {
              expect(c.x).toBeLessThanOrEqual(covered);
              covered = Math.max(covered, c.x + c.width);
            }
            expect(covered).toBe(target.x + target.width);
          }
        }
  });
});
