import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createReportInventorySnapshot, readReportInventorySnapshot, reportFindInventory, reportInventoryCount } from "../src/report-inventory";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import { hydrateBakedGeneration, serializeGenerationForBake } from "../src/telescope/baked-generation";
import { createBakedWorldMetadata, REPORT_INVENTORY_VERSION } from "../build_scripts/baked-world-metadata.mjs";
import type { GenerationResult } from "../src/telescope/telescope-adapter";

const seededWand = { type: "wand", id: "random-wand", x: 100, y: 200, cards: ["CHAINSAW"], always_casts: ["ADD_TRIGGER"] };
/** Execute only the real producer's data-only push expression; no generator,
 * DOM, scene renderer or copied note-deck fixture is needed for this contract. */
function instrumentShop(library: string, biome: string, pw = 0): any {
  const source = readFileSync(new URL(`../lib/${library}/js/static_spawns.js`, import.meta.url), "utf8");
  const start = source.indexOf(`newPois.push({type: 'shop', biome: '${biome}'`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("]});", start);
  expect(end).toBeGreaterThan(start);
  const newPois: any[] = [];
  runInNewContext(source.slice(start, end + 4), { newPois, pwOffsetX: pw * 70 * 512 });
  return newPois[0];
}
const generation = (): GenerationResult => ({
  seed: 42, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
  parallelWorlds: [-1, 0, 1], biomeData: { pixels: new Uint32Array(70 * 48) },
  tileLayers: [], eyes: undefined, pixelScenesByPW: { "-1,0": [], "0,0": [], "1,0": [] },
  poisByPW: {
    "-1,0": [], "1,0": [],
    "0,0": [
      { type: "wand", id: "saha", x: 10, y: 20, sprite: "custom/chainsaw", always_casts: ["CHAINSAW"] },
      { type: "spell", id: "saha-alias", item: "CHAINSAW", parentId: "saha", parentType: "wand", x: 10, y: 20 },
      { type: "boss_wizard", id: "mom", x: 50, y: 60, items: [{ type: "item", item: "spell", spell: "ADD_TRIGGER" }] },
      { type: "boss_fish", id: "levi", x: 70, y: 80, items: [{ type: "item", item: "great_chest" }] },
      { type: "boss_pit", id: "pit", x: 100, y: 200, items: [seededWand, { type: "item", item: "spell", spell: "WORM_RAIN" }] },
      { type: "great_chest", id: "random-chest", x: 300, y: 400, items: [{ type: "item", item: "spell", spell: "ADD_TRIGGER", count: 2 }] },
    ],
  },
});

describe("seed-dependent report finds", () => {
  it.each(["noita-telescope-vm", "noita-telescope"])("excludes %s's fixed instrument-note owners and descendants in raw, flat and ID-less inventories", library => {
    for (const shape of ["nested", "flat", "id-less"] as const) {
      const result = generation();
      for (const pw of result.parallelWorlds) {
        const owners = [instrumentShop(library, "ocarina", pw)];
        if (pw === 0) owners.push(instrumentShop(library, "mountain_tree"));
        if (shape !== "id-less") for (const owner of owners) owner.id = `${owner.biome}-${pw}`;
        result.poisByPW[`${pw},0`] = [
          ...owners,
          // Identical note IDs elsewhere, and seeded loot in these same biomes,
          // remain report finds. A biome-wide or note-ID filter would lose them.
          { type: "item", item: "spell", spell: "KANTELE_A", biome: "mountain_tree", x: 10, y: 20 },
          { type: "item", item: "spell", spell: "OCARINA_A", biome: "ocarina", x: 10, y: 30 },
          { type: "item", item: "egg_purple", biome: "mountain_tree", x: -1047, y: -477 },
          { type: "shop", id: `random-shop-${pw}`, biome: "mountain_tree", x: 100, y: 200,
            items: [{ type: "item", item: "spell", spell: "KANTELE_A", x: 100, y: 200 }] },
          { ...seededWand, id: `seeded-${pw}`, biome: "ocarina" },
        ];
      }
      const before = structuredClone(result);
      const records = shape === "nested"
        ? Object.entries(result.poisByPW).flatMap(([key, records]) => records.map(poi => ({ ...poi, pw: Number(key.split(",")[0]) })))
        : getAllPOIsFlat(result).reverse(); // Exclusion must not depend on parent-first order.
      const finds = reportFindInventory(records);
      expect(finds.filter(poi => poi.type === "shop")).toHaveLength(3);
      expect(finds.filter(poi => poi.item === "egg_purple")).toHaveLength(3);
      expect(finds.filter(poi => poi.type === "wand")).toHaveLength(3);
      const counts = createReportInventorySnapshot(42, records, result.parallelWorlds);
      for (const pw of result.parallelWorlds) {
        expect(reportInventoryCount(counts, [pw], "spells", ["KANTELE_A"])).toBe(2);
        expect(reportInventoryCount(counts, [pw], "spells", ["OCARINA_A"])).toBe(1);
        expect(reportInventoryCount(counts, [pw], "spells", ["KANTELE_D", "OCARINA_F"])).toBe(0);
      }
      expect(result).toEqual(before); // Map/search and card previews keep every original item.
    }
  });

  it("excludes fixed instrument notes from new bake snapshots and recounts legacy v2 metadata without rebuilding terrain", () => {
    const result = generation();
    result.poisByPW["0,0"].push(instrumentShop("noita-telescope-vm", "mountain_tree"));
    result.poisByPW["1,0"].push(instrumentShop("noita-telescope-vm", "ocarina", 1));
    const baked = serializeGenerationForBake(result)!;
    expect(baked.reportInventory!.version).toBe(3);
    expect(reportInventoryCount(baked.reportInventory!, [0, 1], "spells", ["KANTELE_A", "OCARINA_A"])).toBe(0);
    const legacy = structuredClone(baked) as any;
    legacy.reportInventory.version = 2;
    legacy.reportInventory.worlds[0].spells.KANTELE_A = [2, 0];
    legacy.reportInventory.worlds[1].spells.OCARINA_A = [2, 0];
    const restored = hydrateBakedGeneration([legacy]);
    expect(restored.reportInventory).toBeUndefined();
    expect(restored.poisByPW["0,0"].some(poi => poi.type === "shop" && poi.biome === "mountain_tree")).toBe(true);
    expect(createReportInventorySnapshot(42, getAllPOIsFlat(restored), result.parallelWorlds)).toEqual(baked.reportInventory);
  });

  it("excludes only audited special wand identities, including their separately emitted descendants", () => {
    const sprites = ["custom/chainsaw", "custom/good_01", "custom/good_02", "custom/good_03", "custom/experimental_wand_1",
      "custom/experimental_wand_2", "custom/actual_wand_honest", "custom/kantele", "custom/flute"];
    const fixed = sprites.map(sprite => ({ ...seededWand, id: sprite, sprite }));
    const kept = { ...seededWand, id: "custom-random", sprite: "custom/some_random_wand", fixed: true };
    const records = [
      { type: "spell", id: "grandchild", item: "CHAINSAW", parentId: "child" },
      { type: "wand", id: "child", parentId: "custom/good_03", cards: ["CHAINSAW"] },
      ...fixed, kept,
    ];
    expect(reportFindInventory(records)).toEqual([kept]);
    expect(reportInventoryCount(createReportInventorySnapshot(42, records), [0], "spells", ["CHAINSAW"])).toBe(1);
  });

  it("filters guaranteed boss identities without rejecting their seeded rolls or matching world loot", () => {
    const boss = (type: string, items: any[]) => ({ type, id: type, x: 0, y: 0, items });
    const spell = (id: string) => ({ type: "item", item: "spell", spell: id });
    const flat = getAllPOIsFlat({ poisByPW: { "0,0": [
      boss("boss_wizard", [spell("ADD_TRIGGER"), spell("RESET"), { type: "item", item: "wandstone" }]),
      boss("boss_fish", [{ type: "item", item: "great_chest" }, { type: "item", item: "full_heal" }]),
      boss("boss_pit", [seededWand, spell("WORM_RAIN"), spell("METEOR_RAIN"), { type: "item", item: "full_heal" }]),
      boss("dragon", [{ type: "item", item: "heart" }, spell("ORBIT_LARPA"), { ...seededWand, id: "dragon-wand" }]),
      boss("alchemist_boss", [spell("ALPHA")]), boss("pyramid_boss", [spell("NOLLA")]),
      boss("triangle_boss", [spell("ADD_TRIGGER")]),
      { ...spell("ADD_TRIGGER"), id: "world-spell", x: 0, y: 0 },
      { type: "great_chest", id: "world-chest", x: 0, y: 0 },
    ] } });
    const before = structuredClone(flat), finds = reportFindInventory(flat);
    expect(finds.filter(poi => poi.parentType === "boss_wizard" || poi.parentType === "boss_fish")).toEqual([]);
    expect(finds.filter(poi => poi.parentType === "boss_pit").map(poi => poi.id)).toEqual(["random-wand"]);
    expect(finds.filter(poi => poi.parentType === "dragon").map(poi => poi.type)).toEqual(["item", "wand"]);
    expect(finds.some(poi => poi.spell === "ALPHA")).toBe(true);
    expect(finds.some(poi => poi.spell === "NOLLA")).toBe(true);
    expect(finds.filter(poi => poi.spell === "ADD_TRIGGER")).toHaveLength(2);
    expect(finds.find(poi => poi.id === "world-chest")).toBeDefined();
    expect(flat).toEqual(before);
  });

  it("filters nested owners without changing source objects or excluding random loot at fixed locations", () => {
    const records = [{ type: "chest", id: "chest", fixed: true, items: [
      { ...seededWand, sprite: "custom/good_03" }, seededWand,
      { type: "item", item: "spell", spell: "ADD_TRIGGER" },
    ] }];
    const before = structuredClone(records), finds = reportFindInventory(records);
    expect(finds[0].items).toEqual([seededWand, records[0].items[2]]);
    expect(reportInventoryCount(createReportInventorySnapshot(42, records), [0], "spells", ["CHAINSAW"])).toBe(1);
    expect(records).toEqual(before);
  });

  it("excludes both fixed Crystal Key chest variants and their owned spells, retaining rolled or loose matches", () => {
    const records = [
      { type: "chest", id: "coral", chestVariant: "coral", items: [{ type: "item", item: "spell", spell: "DIVIDE_2" }] },
      { type: "chest", id: "dark", nameKey: "item_chest_dark", previewItems: [{ type: "item", item: "spell", spell: "ALL_NUKES" }] },
      { type: "item", item: "spell", spell: "ALL_NUKES", parentId: "dark", parentType: "chest" },
      { type: "item", item: "spell", spell: "ALL_NUKES", id: "loose" },
      { type: "chest", id: "random", items: [{ type: "item", item: "spell", spell: "DIVIDE_2" }] },
    ];
    const before = structuredClone(records);
    expect(reportFindInventory(records)).toEqual(records.slice(3));
    const snapshot = createReportInventorySnapshot(42, records);
    expect(reportInventoryCount(snapshot, [0], "spells", ["ALL_NUKES"])).toBe(1);
    expect(reportInventoryCount(snapshot, [0], "spells", ["DIVIDE_2"])).toBe(1);
    expect(records).toEqual(before);
  });

  it("ships the same eligible counts daily and live; legacy snapshots fall back to preserved POIs", () => {
    const result = generation(), raw = getAllPOIsFlat(result);
    const live = createReportInventorySnapshot(42, raw, result.parallelWorlds);
    const baked = serializeGenerationForBake(result)!;
    expect(baked.reportInventory).toEqual(live);
    expect(live.version).toBe(REPORT_INVENTORY_VERSION);
    expect(reportInventoryCount(live, [0], "spells", ["CHAINSAW"])).toBe(1);
    expect(reportInventoryCount(live, [0], "spells", ["ADD_TRIGGER"])).toBe(3);
    const slices = ["left", "middle", "right"].map(world => createBakedWorldMetadata(baked, world, 42));
    expect(hydrateBakedGeneration(slices).reportInventory).toEqual(live);
    const legacy = structuredClone(slices);
    for (const slice of legacy) slice.reportInventory.version = 1;
    legacy[1].reportInventory.worlds[0].spells.CHAINSAW = [999, 999];
    expect(readReportInventorySnapshot(legacy[1].reportInventory, 42, [0])).toBeNull();
    expect(() => createBakedWorldMetadata({ ...baked, reportInventory: legacy[1].reportInventory }, "middle", 42)).toThrow(/inventory/);
    const hydrated = hydrateBakedGeneration(legacy);
    expect(hydrated.reportInventory).toBeUndefined();
    const restored = getAllPOIsFlat(hydrated);
    expect(restored.some(poi => poi.id === "saha")).toBe(true);
    expect(restored.some(poi => poi.parentType === "boss_wizard" && poi.spell === "ADD_TRIGGER")).toBe(true);
    expect(createReportInventorySnapshot(42, restored, result.parallelWorlds)).toEqual(live);
  });
});
