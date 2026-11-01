import { describe, expect, it } from "vitest";
import {
  compactImageContent,
  imageContent,
} from "../build_scripts/guessr/image-content.mjs";
import { prepareAreaStarts } from "../src/guessr/starting-view";
import { cameraRect } from "../src/guessr/clue-camera";
import type { PrivateImageSet } from "../src/guessr/image-game-server";
import type { AreaDefinition } from "../src/guessr/area-rules";

function fixture(points: [number, number][] = []) {
  const images: PrivateImageSet["images"] = {},
    grid: Record<string, string> = {};
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) {
      const id = (y * 4 + x + 1).toString(16).padStart(32, "0");
      const left = x * 512 - (x ? 2 : 0),
        top = y * 512 - (y ? 2 : 0);
      const width = 512 + (x ? 2 : 0) + (x < 3 ? 2 : 0),
        height = 514;
      const content = points
        .filter(
          ([px, py]) =>
            px >= left && px < left + width && py >= top && py < top + height,
        )
        .map(([px, py]): [number, number, number, number] => [
          px - left,
          py - top,
          1,
          1,
        ]);
      grid[`${x},${y}`] = id;
      images[id] = {
        width,
        height,
        content: content.length ? compactImageContent(content) : "empty",
      };
    }
  const index: PrivateImageSet = {
    schemaVersion: 1,
    version: "test",
    levels: { 11: { images: grid } },
    images,
    capture: {
      sha256: "test",
      originX: -17920,
      originY: -1024,
      width: 2048,
      height: 1024,
      tileSize: 512,
      overlap: 2,
      maxLevel: 11,
    },
  };
  const area: AreaDefinition = {
    id: "test-area",
    label: "Test area",
    originY: -1024,
    runs: [
      [0, 0, 4],
      [1, 0, 4],
    ],
    cells: 8,
    bounds: { x: -17920, y: -1024, width: 2048, height: 1024 },
  };
  return { index, area };
}

describe("nonblank starting views", () => {
  it("records visible nonblack pixels exactly, including dark pixels and transparent colour", () => {
    const width = 31,
      height = 17;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = (x * y + x) % 3 === 0 ? 1 : 0;
        data[i + 3] = x % 5 === 0 ? 0 : 255;
      }
    const content = imageContent(data, width, height);
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content))
      throw new Error("Expected a partial content mask");
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const covered = content.some(
          ([left, top, w, h]: number[]) =>
            x >= left && x < left + w && y >= top && y < top + h,
        );
        const i = (y * width + x) * 4;
        expect(covered).toBe(data[i] > 0 && data[i + 3] > 0);
      }
    expect(
      imageContent(Uint8Array.from([255, 255, 255, 0, 0, 0, 0, 255]), 2, 1),
    ).toBe("empty");
    expect(imageContent(Uint8Array.from([0, 1, 0, 255]), 1, 1)).toBe("full");
  });

  it.each([
    { native: [[1024, 512]] as [number, number][] },
    {
      native: [
        [1023, 511],
        [1024, 512],
        [1044, 515],
        [1044, 515],
      ] as [number, number][],
    },
  ])(
    "matches the actual 27×12 crop at every eligible position without seam weighting: $native",
    ({ native }) => {
      const { index, area } = fixture(native),
        starts = prepareAreaStarts(index, area);
      const expected = new Set<string>();
      for (let y = 384; y <= 640; y++)
        for (let x = 864; x <= 1184; x++) {
          const view = cameraRect({ dx: x, dy: y, level: 0 });
          const visible = native.some(
            ([px, py]) =>
              px >= view.x &&
              px < view.x + view.width &&
              py >= view.y &&
              py < view.y + view.height,
          );
          const point = { x: x - 17920, y: y - 1024 };
          if (visible) expected.add(`${point.x},${point.y}`);
          expect(starts.contains(point)).toBe(visible);
        }
      const actual = new Set<string>();
      for (let i = 0; i < starts.pixels; i++) {
        const p = starts.sample(() => (i + 0.5) / starts.pixels);
        actual.add(`${p.x},${p.y}`);
      }
      expect(starts.pixels).toBe(expected.size);
      expect(actual).toEqual(expected);
    },
  );

  it("keeps centres in the area while accepting a terrain pixel across its edge", () => {
    const { index, area } = fixture([[1023, 512]]);
    area.runs = [[1, 2, 3]];
    const starts = prepareAreaStarts(index, area);
    expect(starts.pixels).toBeGreaterThan(0);
    for (let i = 0; i < starts.pixels; i++) {
      const p = starts.sample(() => (i + 0.5) / starts.pixels);
      expect(p.x).toBeGreaterThanOrEqual(-17920 + 1024);
      expect(p.y).toBeGreaterThanOrEqual(-512);
    }
    expect(starts.contains({ x: -17920 + 1023, y: -512 })).toBe(false);
  });

  it("never permits black views or missing content metadata", () => {
    const { index, area } = fixture();
    const starts = prepareAreaStarts(index, area);
    expect(starts.pixels).toBe(0);
    expect(starts.contains({ x: -16900, y: -512 })).toBe(false);
    expect(() => starts.sample(Math.random)).toThrow("no starting views");
    delete index.images[index.levels[11].images["1,0"]].content;
    expect(() => prepareAreaStarts(index, area)).toThrow(
      "content index is missing",
    );
  });

  it("retains every safe starting position for solid terrain, including maximum-view edges", () => {
    const { index, area } = fixture();
    for (const image of Object.values(index.images)) image.content = "full";
    const starts = prepareAreaStarts(index, area);
    expect(starts.pixels).toBe((2048 - 1728 + 1) * (1024 - 768 + 1));
    expect(starts.sample(() => 0)).toEqual({ x: -17920 + 864, y: -1024 + 384 });
    expect(starts.sample(() => 1 - Number.EPSILON)).toEqual({
      x: -17920 + 1184,
      y: -1024 + 640,
    });
  });
});
