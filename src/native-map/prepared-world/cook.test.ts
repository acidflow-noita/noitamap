import { describe, expect, it, vi } from "vitest";
import type {
  CompleteWorldSource,
  CompleteWorldStats,
} from "../complete-world";
import { SharedPixelStore } from "../cooked-pixels";
import { cookTerrainSceneLayer, UnpreparedWorldError } from "./cook";

function source(): CompleteWorldSource {
  const regions = [-1, 0, 1].flatMap((vertical) =>
    [-1, 0, 1].map((horizontal) => ({
      horizontal,
      vertical: vertical as -1 | 0 | 1,
      x: horizontal * 8,
      y: vertical * 8,
      width: 8,
      height: 8,
      columns: 1,
      rows: 1,
    })),
  );
  const stats = { pages: 0 } as CompleteWorldStats;
  return {
    revision: "test-assets",
    seed: 1103,
    generationStateDigest: null,
    pageSize: 8,
    regions,
    scope: "terrain-scenes-layer",
    stats,
    *pageAddresses() {
      for (const r of regions)
        yield {
          horizontal: r.horizontal,
          vertical: r.vertical,
          column: 0,
          row: 0,
        };
    },
    renderPage: vi.fn(async (a) => {
      const r = regions.find(
        (r) => r.horizontal === a.horizontal && r.vertical === a.vertical,
      )!;
      const pixels = new Uint8ClampedArray(8 * 8 * 4);
      for (let i = 0; i < pixels.length; i += 4)
        pixels.set([r.horizontal + 1, r.vertical + 1, 47, 255], i);
      return {
        horizontal: r.horizontal,
        vertical: r.vertical,
        x: r.x,
        y: r.y,
        width: 8,
        height: 8,
        pixels,
        sceneCount: 0,
        staticMaskCount: 0,
      };
    }),
    async renderRect() {
      throw new Error("Rect rendering is not used by the all-page owner");
    },
    async *pages() {
      throw new Error("Selection must precede reference rasterization");
    },
    dispose() {},
  };
}

describe("all-page native cook admission", () => {
  it("rejects incomplete prepared coverage before doing any scalar bake work", async () => {
    const world = source();
    await expect(
      cookTerrainSceneLayer(world, { maxReferencePixels: 0 }),
    ).rejects.toMatchObject({
      name: "UnpreparedWorldError",
      missingPages: 9,
      requiredPixels: 576,
      budgetPixels: 0,
    });
    expect(world.renderPage).not.toHaveBeenCalled();
  });

  it("closes every region and global mip using only prepared final image alternatives", async () => {
    const world = source(),
      store = new SharedPixelStore({ pageSize: 8 });
    const ids = world.regions.map((r) =>
      store.solidBlock([r.horizontal + 1, r.vertical + 1, 47, 255]),
    );
    ids.forEach((id) => store.commitPage(id));
    const phases: string[] = [];
    const cooked = await cookTerrainSceneLayer(world, {
      baseline: store.freezePreparation(),
      preparedRevision: world.revision,
      maxReferencePixels: 0,
      preparedPages: [...world.pageAddresses()].map((address) => ({
        address,
        root: ids[(address.vertical + 1) * 3 + address.horizontal + 1],
      })),
      onProgress: (p) => phases.push(p.phase),
    });
    expect(cooked).toMatchObject({
      kind: "cooked-terrain-scenes-layer",
      seed: 1103,
      preparedPages: 9,
      referencePixels: 0,
    });
    expect(cooked.map.pageCount).toBe(9);
    expect(cooked.map.ready).toBe(true);
    expect(cooked.map.store.stats().ownedPages).toBe(0);
    expect(world.renderPage).not.toHaveBeenCalled();
    expect(phases).toEqual(["composition", "mips", "complete"]);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++)
        expect([...cooked.map.readRect(0, x * 8, y * 8, 1, 1)]).toEqual([
          x,
          y,
          47,
          255,
        ]);
    expect(cooked.map.readRect(cooked.map.maxLevel, 0, 0, 1, 1).length).toBe(4);
  });

  it("allows explicitly budgeted reference work and labels the resulting layer", async () => {
    const world = source();
    const result = await cookTerrainSceneLayer(world, {
      maxReferencePixels: 576,
    });
    expect(result.referencePages).toBe(9);
    expect(result.referencePixels).toBe(576);
    expect(world.renderPage).toHaveBeenCalledTimes(9);
    expect(result.map.width).toBe(24);
    expect(result.kind).toBe("cooked-terrain-scenes-layer");
  });

  it("separates captured-state final pages from seed-only and different-state pages", async () => {
    const world = { ...source(), generationStateDigest: "a".repeat(64) }, store = new SharedPixelStore({ pageSize: 8 });
    const root = store.solidBlock([1, 2, 3, 255]); store.commitPage(root);
    const options = { baseline: store.freezePreparation(), preparedRevision: world.revision, maxReferencePixels: 0,
      preparedPages: [...world.pageAddresses()].map(address => ({ address, root })) };
    await expect(cookTerrainSceneLayer(world, options)).rejects.toThrow(/cave-state identities/);
    await expect(cookTerrainSceneLayer(world, { ...options, preparedGenerationStateDigest: "b".repeat(64) })).rejects.toThrow(/cave-state identities/);
    const cooked = await cookTerrainSceneLayer(world, { ...options, preparedGenerationStateDigest: world.generationStateDigest });
    expect(cooked.generationStateDigest).toBe(world.generationStateDigest);
    expect(cooked.map.ready).toBe(true);
    expect(world.renderPage).not.toHaveBeenCalled();
  });

  it("does not expose a partial map on cancellation, incomplete addresses or mismatched revisions", async () => {
    const world = source(),
      controller = new AbortController();
    await expect(
      cookTerrainSceneLayer(world, {
        maxReferencePixels: 576,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(world.renderPage).not.toHaveBeenCalled();
    await expect(
      cookTerrainSceneLayer(
        {
          ...world,
          *pageAddresses() {
            yield { horizontal: 0, vertical: 0, column: 0, row: 0 };
          },
        },
        { maxReferencePixels: 576 },
      ),
    ).rejects.toThrow(/omitted/);
    await expect(
      cookTerrainSceneLayer(world, {
        maxReferencePixels: 0,
        preparedRevision: "other",
        preparedPages: [],
      }),
    ).rejects.toThrow(/revisions/);
    await expect(
      cookTerrainSceneLayer(
        { ...world, regions: [world.regions[0]] },
        { maxReferencePixels: 576 },
      ),
    ).rejects.toThrow(/nine regions/);
    expect(new UnpreparedWorldError(9, 576, 0).message).toContain(
      "Prepared world is incomplete",
    );
  });
});
