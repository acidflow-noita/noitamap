import { describe, expect, it, vi } from "vitest";
import { createReportInventorySnapshot, readReportInventorySnapshot, reportInventoryCount, sliceReportInventorySnapshot } from "../src/report-inventory";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import { hydrateBakedGeneration, serializeGenerationForBake } from "../src/telescope/baked-generation";
import type { GenerationResult } from "../src/telescope/telescope-adapter";
import { cacheGeneration, getCachedGeneration } from "../src/telescope/tile-cache";

const fixture = (): GenerationResult => ({
  seed: 42, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
  parallelWorlds: [-1, 0, 1], biomeData: { pixels: new Uint32Array(70 * 48) },
  tileLayers: [], pixelScenesByPW: {}, eyes: undefined,
  poisByPW: {
    "0,0": [
      { type: "wand", id: "wand", x: 10, y: 20, cards: ["ALPHA", "ALPHA", "LIGHT_BULLET"], always_casts: ["NOLLA"] },
      { type: "spell", item: "ALPHA", parentType: "wand", parentId: "wand", x: 10, y: 20 },
      { type: "alchemist_boss", id: "boss", x: 40, y: 50, items: [
        { type: "wand", cards: ["ALPHA"], always_casts: ["NOLLA"] },
        { type: "item", item: "spell", spell: "MANA_REDUCE", count: 2 },
      ] },
      { type: "entity", entity: "data/entities/animals/thundermage.xml", x: 100, y: 200 },
      { type: "entity", entity: "thundermage_big", x: 100, y: 300, count: 2 },
    ],
    "-1,0": [
      { type: "chest", id: "chest", x: -30000, y: 1000, count: 2, items: [
        { type: "spell", item: "ALPHA", count: 3 },
        { type: "item", item: "potion", material: "ambrosia", amount: 2 },
        { type: "item", item: "potion", material: "water" },
      ] },
      { type: "spell", item: "ALPHA", ignore: true, x: -30000, y: 1500 },
    ],
    "-1,1": [{ type: "spell", item: "ALPHA", x: -30000, y: 25000 }],
    "1,0": [],
  },
});

describe("selected-seed inventory snapshots", () => {
  it("counts all spell IDs and material IDs, quantities and reward ownership without duplicate previews or decks", () => {
    const result = fixture(), snapshot = createReportInventorySnapshot(42, getAllPOIsFlat(result), result.parallelWorlds);
    expect(snapshot.worlds[0].spells).toEqual({ ALPHA: [2, 1], LIGHT_BULLET: [1, 0], NOLLA: [1, 1], MANA_REDUCE: [0, 2] });
    expect(snapshot.worlds[-1].spells.ALPHA).toEqual([7, 0]);
    expect(snapshot.worlds[-1].materials).toEqual({ ambrosia: [4, 0], water: [2, 0] });
    expect(snapshot.worlds[0].ukkos).toEqual({ thundermage: [1, 0], thundermage_big: [2, 0] });
    expect(reportInventoryCount(snapshot, [-1, 0, 1], "spells", ["ALPHA"])).toBe(10);
    expect(reportInventoryCount(snapshot, [1], "materials", ["ambrosia"])).toBe(0);
    expect(reportInventoryCount(snapshot, [2], "materials", ["ambrosia"])).toBeNull();
    expect(reportInventoryCount(snapshot, [0], "ukkos")).toBe(3);
  });

  it("keeps expanded children and nested children mutually exclusive, and supports further parallel worlds", () => {
    const snapshot = createReportInventorySnapshot(0, [
      { type: "shop", id: "shop", pw: 2, items: [{ type: "spell", item: "NOLLA" }] },
      { type: "spell", item: "NOLLA", parentId: "shop", parentType: "shop", pw: 2 },
      { type: "chest", pw: -2, previewItems: [{ type: "spell", item: "ALPHA" }], items: [{ type: "spell", item: "ALPHA" }] },
      { type: "wand", pw: -2, cards: [{ id: "NOLLA" }], always_casts: [{ id: "LIGHT_BULLET" }] },
    ]);
    expect(reportInventoryCount(snapshot, [2], "spells")).toBe(1);
    expect(reportInventoryCount(snapshot, [-2], "spells")).toBe(3);
    expect(readReportInventorySnapshot(snapshot, 0, [-2, 2])).toBe(snapshot);
  });

  it("rejects wrong seeds, incomplete worlds and invalid counts rather than presenting zero", () => {
    const snapshot = createReportInventorySnapshot(42, [{ type: "spell", item: "NOLLA", pw: 0 }]);
    expect(readReportInventorySnapshot(snapshot, 43)).toBeNull();
    expect(readReportInventorySnapshot(snapshot, 42, [-1, 0, 1])).toBeNull();
    expect(readReportInventorySnapshot({ ...snapshot, version: 1 }, 42)).toBeNull();
    expect(readReportInventorySnapshot({ ...snapshot, version: 2 }, 42)).toBeNull();
    expect(readReportInventorySnapshot({ ...snapshot, version: 4 }, 42)).toBeNull();
    for (const counts of [[-1, 0], [1, NaN], [1, "2"], [1], [1, 0, 0]]) {
      const broken = structuredClone(snapshot) as any;
      broken.worlds[0].spells.NOLLA = counts;
      expect(readReportInventorySnapshot(broken, 42)).toBeNull();
    }
  });

  it("ships only each world's inventory and merges baked slices without recounting or copying locations", () => {
    const result = fixture(), baked = serializeGenerationForBake(result)!;
    const slices = result.parallelWorlds.map(pw => ({
      ...baked, parallelWorlds: [pw],
      reportInventory: sliceReportInventorySnapshot(baked.reportInventory!, [pw]),
      poisByPW: Object.fromEntries(Object.entries(baked.poisByPW).filter(([key]) => Number(key.split(",")[0]) === pw)),
    }));
    for (const [index, slice] of slices.entries())
      expect(Object.keys(slice.reportInventory.worlds)).toEqual([String(result.parallelWorlds[index])]);
    const hydrated = hydrateBakedGeneration(slices);
    expect(hydrated.reportInventory).toEqual(baked.reportInventory);
    expect(hydrated.reportInventory).toEqual(createReportInventorySnapshot(42, getAllPOIsFlat(hydrated), result.parallelWorlds));
    const { reportInventory: _removed, ...legacy } = slices[0];
    expect(hydrateBakedGeneration([legacy, ...slices.slice(1)]).reportInventory).toBeUndefined();
  });

  it.each([1, 2])("discards V%s baked counts while preserving POIs for the current instrument-shop recount", version => {
    const result = fixture();
    result.poisByPW["0,0"].push({ type: "shop", id: "fixed-kantele", biome: "mountain_tree", x: -1628, y: -736,
      items: ["KANTELE_A", "KANTELE_D", "KANTELE_DIS", "KANTELE_E", "KANTELE_G"].flatMap(spell =>
        [0, 1].map(() => ({ type: "item", item: "spell", spell }))) });
    // The same note found elsewhere remains a seed-dependent find.
    result.poisByPW["0,0"].push({ type: "item", item: "spell", spell: "KANTELE_A", x: 500, y: 500 });
    const baked = serializeGenerationForBake(result)!;
    const legacy = structuredClone(baked);
    (legacy.reportInventory as any).version = version;
    legacy.reportInventory!.worlds[0].spells.KANTELE_A = [999, 0];
    const hydrated = hydrateBakedGeneration([legacy]);
    expect(hydrated.reportInventory).toBeUndefined();
    const pois = getAllPOIsFlat(hydrated);
    expect(pois.some(poi => poi.id === "fixed-kantele")).toBe(true);
    const recounted = createReportInventorySnapshot(42, pois, result.parallelWorlds);
    expect(recounted).toEqual(baked.reportInventory);
    expect(recounted.version).toBe(3);
    expect(recounted.worlds[0].spells.KANTELE_A).toEqual([1, 0]);
    expect(recounted.worlds[0].spells.KANTELE_D).toBeUndefined();
  });

  it("counts the boss-normalized inventory actually exposed after hydration, without changing raw input", () => {
    const result = fixture();
    // Mestarien mestari remains on the map; its fixed rewards are not seed finds.
    result.biomeData.pixels[20 * 70 + 35] = 0xff1f3b62;
    // Kolmisilmän koipi is main-only, even if an older PW source emitted loot.
    result.poisByPW["-1,0"].push({ type: "pyramid_boss", x: -30000, y: 100,
      items: [{ type: "spell", item: "ALPHA", count: 20 }] });
    const before = structuredClone(result), baked = serializeGenerationForBake(result)!;
    const hydrated = hydrateBakedGeneration([baked]);
    expect(baked.reportInventory).toEqual(createReportInventorySnapshot(42, getAllPOIsFlat(hydrated), result.parallelWorlds));
    expect(baked.reportInventory!.worlds[-1].spells.ALPHA).toEqual([7, 0]);
    expect(baked.reportInventory!.worlds[-1].spells.DUPLICATE).toBeUndefined();
    expect(getAllPOIsFlat(hydrated).some(poi => poi.spell === "DUPLICATE")).toBe(true);
    expect(result).toEqual(before);
  });

  it("preserves daily snapshots through the generation cache and discards invalid saved or loaded snapshots", async () => {
    const entries = new Map<string, any>();
    const request = (result: unknown) => {
      const req: any = { result };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const db = { close: vi.fn(), transaction: () => {
      const tx: any = { objectStore: () => ({
        put: (entry: any) => { entries.set(entry.cacheKey, structuredClone(entry)); queueMicrotask(() => tx.oncomplete?.()); },
        get: (key: string) => request(structuredClone(entries.get(key))),
      }) };
      return tx;
    } };
    vi.stubGlobal("indexedDB", { open: () => request(db) });
    try {
      const result = hydrateBakedGeneration([serializeGenerationForBake(fixture())!]);
      result.bakedMimicSpritesVersionByPW = { '-1': 1, '0': 0, '1': 1 };
      await cacheGeneration("42-all", 42, result);
      expect((await getCachedGeneration("42-all"))?.reportInventory).toEqual(result.reportInventory);
      expect((await getCachedGeneration("42-all"))?.bakedMimicSpritesVersionByPW).toEqual(result.bakedMimicSpritesVersionByPW);
      const entry = [...entries.values()][0];
      const original = structuredClone(entry.reportInventory);
      for (const change of [
        (value: any) => { value.version = 1; },
        (value: any) => { value.version = 2; },
        (value: any) => { value.seed = 99; },
        (value: any) => { delete value.worlds[-1]; },
        (value: any) => { value.worlds[0].spells.ALPHA = [-1, 0]; },
      ]) {
        entry.reportInventory = structuredClone(original);
        change(entry.reportInventory);
        const loaded = await getCachedGeneration("42-all");
        expect(loaded?.reportInventory).toBeUndefined();
        expect(loaded?.poisByPW).toEqual(result.poisByPW);
      }
      await cacheGeneration("42-all", 42, { ...result, reportInventory: { ...original, seed: 99 } });
      expect([...entries.values()][0].reportInventory).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
