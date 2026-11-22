import { describe, expect, it } from "vitest";
import { completeBossPOIs } from "../src/telescope/boss-pois";
import { hydrateBakedGeneration, serializeGenerationForBake } from "../src/telescope/baked-generation";
import type { POI } from "../src/telescope/telescope-adapter";
import bosses from "../src/data/bosses.json";

function world(pw = 0, size = 70, center = 35) {
  const pixels = new Uint32Array(size * 48);
  [0x1f3b62, 0x1f3b64, 0x9d893d, 0x796620, 0x6db55a].forEach((c, i) => {
    pixels[20 * size + center + i] = (c | 0xff000000) >>> 0;
  });
  return {
    pw, worldSize: size, worldCenter: center, biomeData: { pixels, w: size },
    scenes: [{ name: "cavern", x: pw * size * 512 + 4 * 512, y: 6 * 512 }],
  };
}
const poi = (type: string, extra = {}): POI => ({ type, x: 10, y: 20, ...extra });

describe("boss availability shared by main-thread and PW generation", () => {
  it("uses the five boss types displayed by the production static Nightmare overlay", () => {
    const expected = ["boss_sky", "pyramid_boss", "dragon", "boss_centipede", "islandspirit"];
    expect(bosses.filter(b => b.maps.includes("nightmare-main-branch")).map(b => b.bossType)).toEqual(expected);
    const w = { ...world(0, 64, 32), gameMode: "nightmare" };
    const input = bosses.filter(b => b.bossType !== "dragon").map(b => poi(b.bossType));
    input.push(poi("pit_boss"), poi("entity", { entity: "fish_giga" }), poi("entity", { entity: "boss_pit" }));
    const result = completeBossPOIs(input, w);
    expect(result.map(p => p.type).sort()).toEqual([...expected].sort());
    expect(result.find(p => p.type === "dragon")).toMatchObject({ x: 2347, y: 7444, locationSource: "static-nightmare" });
    expect(completeBossPOIs(result, w)).toEqual(result);
  });

  it("preserves a seed's dragon and loot, uses the material trigger in a moved scene, and never copies the static pin to a parallel world", () => {
    const w = { ...world(0, 64, 32), gameMode: "nightmare" };
    const reference = completeBossPOIs([], w)[0];
    const cave = { name: "dragoncave", x: -2048, y: 9216 };
    const generated = poi("dragon", { x: 38, y: 9201, items: [poi("wand")] });
    expect(completeBossPOIs([reference, generated], w)).toEqual([generated]);
    expect(completeBossPOIs([reference], { ...w, scenes: [cave, cave] })).toEqual([
      expect.objectContaining({ type: "dragon", x: -1752, y: 9521, biome: "dragoncave" }),
    ]);
    const shadows = [poi("entity", { entity: "parallel_tentacles" }), poi("entity", { entity: "parallel_alchemist" })];
    expect(completeBossPOIs([reference, ...shadows], { ...w, pw: 1 })).toEqual(shadows);
  });

  it("repairs a legacy Nightmare bake before search and discards counts from the removed loot", () => {
    const w = world(0, 64, 32);
    const baked = serializeGenerationForBake({ seed: 42, gameMode: "nightmare", ngPlus: 0, isNGP: false, worldSize: 64, worldCenter: 32,
      parallelWorlds: [0], biomeData: w.biomeData, tileLayers: [], poisByPW: { "0,0": [] }, pixelScenesByPW: { "0,0": [] },
    } as any)!;
    const stale = [poi("boss_fish"), poi("boss_pit", { items: [poi("wand")] })];
    baked.poisByPW = { "0,0": stale, "0,1": [poi("entity", { entity: "boss_pit" })] };
    const hydrated = hydrateBakedGeneration([baked]);
    expect(hydrated.poisByPW["0,0"].map(p => p.type)).toEqual(["dragon"]);
    expect(hydrated.poisByPW["0,1"]).toEqual([]);
    expect(hydrated.reportInventory).toBeUndefined();
    expect(baked.poisByPW["0,0"]).toBe(stale);
  });
  it.each([-2, -1, 0, 1, 2])("adds the four room bosses and inhabited Toveri cave in world %i", (pw) => {
    const input = world(pw);
    const bosses = completeBossPOIs([], input);
    expect(bosses.filter((p) => p.type !== "entity").map((p) => p.type)).toEqual([
      "boss_wizard", "boss_ghost", "boss_robot", "boss_meat", "friend",
    ]);
    expect(bosses[0]).toMatchObject({ x: pw * 70 * 512 + 285, y: 3402 });
    expect(bosses[2]).toMatchObject({ name: "Kolmisilmän silmä", nameKey: "animal_boss_robot" });
    expect(bosses[4]).toMatchObject({ x: pw * 70 * 512 + 2304, y: 3328, biome: "friend_1" });
    expect(completeBossPOIs(bosses, input)).toEqual(bosses);
  });
  it("does not invent room bosses for absent biomes or empty/wrong caverns", () => {
    const input = world();
    input.biomeData.pixels.fill(0);
    expect(completeBossPOIs([], input)).toEqual([]);
    const empty = world();
    empty.scenes[0].name = "friendroom";
    expect(completeBossPOIs([], empty).some((p) => p.type === "friend")).toBe(false);
  });
  it("uses actual world dimensions/center rather than a fixed NG offset", () => {
    expect(completeBossPOIs([], world(-1, 72, 36))[0].x).toBe(-72 * 512 + 285);
  });
  it("filters all seven main-only bosses and their entity aliases without replacing shadows", () => {
    const types = ["tiny", "pyramid_boss", "boss_pit", "boss_fish", "boss_sky", "islandspirit", "boss_centipede"];
    const aliases = ["maggot_tiny", "boss_limbs", "boss_pit", "fish_giga", "boss_sky", "boss_spirit", "boss_centipede"];
    const input = types.map((t) => poi(t)).concat(aliases.map((entity) => poi("entity", { entity })));
    const shadows = [poi("entity", { entity: "parallel_alchemist" }), poi("entity", { entity: "parallel_tentacles" })];
    const w = world(1); w.biomeData.pixels.fill(0); w.scenes = [];
    expect(completeBossPOIs([...input, ...shadows], w)).toEqual(shadows);
    expect(completeBossPOIs(input, { ...w, pw: 0 }).map((p) => p.type)).toEqual(types);
  });
  it("preserves native loot, collapses aliases/vertical duplicates, and keeps distinct NG+ dragons", () => {
    const input = [poi("entity", { entity: "boss_alchemist" }), poi("alchemist_boss", { items: [{ spell: "TEST" }] }),
      poi("alchemist_boss"), poi("triangle_boss"), poi("triangle_boss"), poi("dragon"), poi("dragon"), poi("dragon", { x: 500 })];
    const result = completeBossPOIs(input, world(1));
    expect(result.filter((p) => p.type === "alchemist_boss")).toEqual([input[1]]);
    expect(result.filter((p) => p.type === "triangle_boss")).toHaveLength(1);
    expect(result.filter((p) => p.type === "dragon")).toHaveLength(2);
  });
  it("repairs old baked generation metadata without rejecting existing terrain bakes", () => {
    const w = world(1);
    const baked = serializeGenerationForBake({ seed: 42, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
      parallelWorlds: [1], biomeData: w.biomeData, tileLayers: [],
      poisByPW: { "1,0": [], "1,1": [] }, pixelScenesByPW: { "1,0": w.scenes },
    } as any)!;
    expect(baked.version).toBe(1);
    const hydrated = hydrateBakedGeneration([baked]);
    expect(hydrated.poisByPW["1,0"].some((p) => p.type === "boss_wizard")).toBe(true);
    expect(hydrated.poisByPW["1,1"]).toEqual([]);
    expect(baked.poisByPW["1,0"]).toEqual([]);
  });
});
