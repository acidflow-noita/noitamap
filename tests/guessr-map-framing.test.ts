import { describe, expect, it } from "vitest";
import { frameMap, frameMarkers } from "../src/guessr/map-framing";

describe("starting map framing", () => {
  const bounds = { x: -17920, y: -31744, width: 36352, height: 73728 };
  it.each([
    [1000, 600],
    [340, 550],
    [1600, 400],
    [300, 1000],
  ])(
    "fills a %i×%i panel without showing outside the captured map",
    (width, height) => {
      const frame = frameMap(bounds, width, height);
      expect(frame.width / frame.height).toBeCloseTo(width / height);
      expect(frame.x).toBeGreaterThanOrEqual(bounds.x);
      expect(frame.y).toBeGreaterThanOrEqual(bounds.y);
      expect(frame.x + frame.width).toBeLessThanOrEqual(
        bounds.x + bounds.width,
      );
      expect(frame.y + frame.height).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
      expect(frame.x + frame.width / 2).toBeCloseTo(bounds.x + bounds.width / 2);
      expect(frame.y + frame.height / 2).toBeCloseTo(bounds.y + bounds.height / 2);
      expect(
        frame.width === bounds.width || frame.height === bounds.height,
      ).toBe(true);
    },
  );
  it("stays finite until the panel has been measured", () => {
    expect(frameMap(bounds, 0, 0)).toEqual(bounds);
  });
});

describe("revealed result framing", () => {
  it.each([
    [1000, 600],
    [340, 550],
    [1600, 400],
  ])(
    "fits distant markers with visible padding in a %i×%i panel",
    (width, height) => {
      const points = [
        { x: -15000, y: -28000 },
        { x: 17000, y: 41000 },
      ];
      const frame = frameMarkers(points, width, height);
      expect(frame.width / frame.height).toBeCloseTo(width / height);
      for (const p of points) {
        const x = (p.x - frame.x) / frame.width,
          y = (p.y - frame.y) / frame.height;
        expect(x).toBeGreaterThan(0.1);
        expect(x).toBeLessThan(0.9);
        expect(y).toBeGreaterThan(0.1);
        expect(y).toBeLessThan(0.9);
      }
    },
  );
  it("keeps terrain context for a perfect guess or a skipped round", () => {
    const point = { x: 3000, y: 8200 };
    const one = frameMarkers([point], 900, 600),
      two = frameMarkers([point, point], 900, 600);
    expect(two).toEqual(one);
    expect(one.height).toBe(1024);
    expect(one.width).toBe(1536);
    expect(one.x + one.width / 2).toBe(point.x);
    expect(one.y + one.height / 2).toBe(point.y);
  });
  it("allows margin outside the captured world so edge markers are not clipped", () => {
    const frame = frameMarkers(
      [
        { x: -17920, y: -31744 },
        { x: -17910, y: -31740 },
      ],
      800,
      600,
    );
    expect(frame.x).toBeLessThan(-17920);
    expect(frame.y).toBeLessThan(-31744);
    expect(frame.x + frame.width).toBeGreaterThan(-17910);
    expect(frame.y + frame.height).toBeGreaterThan(-31740);
  });
  it("provides finite initial framing before the panel is measured", () => {
    expect(frameMarkers([{ x: 0, y: 0 }], 0, 0)).toEqual({
      x: -512,
      y: -512,
      width: 1024,
      height: 1024,
    });
  });
});
