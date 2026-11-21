import type { PixelScene, POI } from "../src/telescope/telescope-adapter";
import { describe, expect, it } from "vitest";
import { templeCrystals, reconcileTempleCrystals } from "../src/telescope/temple-crystals";
import { hydrateBakedGeneration } from "../src/telescope/baked-generation";

const room = (key: string, x: number, y: number, variantKey?: string): PixelScene =>
  ({ key, name: key.split("/").at(-1)!, x, y, width: 512, height: 282, variantKey } as PixelScene);
const point = (item: string, x: number, y: number): POI => ({ type: "item", item, x, y, biome: "temple_altar" });

describe("Holy Mountain crystal placement", () => {
  it.each([
    { mode: "normal", seed: 499625176, width: 70, rows: [1280, 2816, 4864, 6400, 8448, 10496], phantom: [-33560, -34010] },
    { mode: "nightmare", seed: 786433191, width: 64, rows: [1280, 3840, 6400, 10496], phantom: [-30488, -30938] },
  ])("repairs the reported west-world records for $mode seed $seed", ({ mode, seed, width, rows, phantom }) => {
    const shift = -width * 512;
    const scenes = rows.flatMap(y => [room("temple/altar", shift - 512, y), room("temple/altar_left", shift - 1024, y)]);
    // Both published west files contained this fixed main-world splice three times.
    scenes.push(...Array(3).fill(room("general/boss_arena", 1536, 12288)));
    const actual = templeCrystals(scenes, -1);
    expect(actual.filter(p => p.item === "worm_crystal").map(p => p.y)).toEqual(rows.map(y => y + 175));
    expect(actual.filter(p => p.item === "greed_crystal").map(p => p.y)).toEqual(rows.map(y => y + 57));
    expect(actual.some(p => p.y > 12000)).toBe(false);

    const original = [1410, 2946, 4994, 6530, 8578, 10626, 13181].flatMap((y, i) => {
      const x = (i === 6 ? 2560 : -32) + shift;
      return [point("worm_crystal", x - 280, y + 45), point("greed_crystal", x - 730, y - 73)];
    });
    const unrelated = { type: "item", item: "heart", x: shift, y: 100, id: "previous-link" };
    const input = { gameMode: mode, seed, ngPlus: 0, worldCenter: width / 2, worldSize: width,
      parallelWorlds: [-1], poisByPW: { "-1,0": [...original, unrelated] }, pixelScenesByPW: { "-1,0": scenes } };
    const fixed = reconcileTempleCrystals(input);
    expect(fixed.poisByPW["-1,0"]).not.toContainEqual(expect.objectContaining({ x: phantom[0], y: 13226 }));
    expect(fixed.poisByPW["-1,0"]).not.toContainEqual(expect.objectContaining({ x: phantom[1], y: 13108 }));
    expect(fixed.poisByPW["-1,0"]).toHaveLength(actual.length + 1);
    expect(fixed.poisByPW["-1,0"]).toContain(unrelated);
    expect(fixed.poisByPW["-1,0"][0]).toBe(original[0]);
    expect(reconcileTempleCrystals(fixed)).toBe(fixed);
    expect(original).toHaveLength(14);
    const hydrated = hydrateBakedGeneration([{ ...input, version: 1, isNGP: false, biomeDataW: width, biomeDataH: 48,
      biomeDataPixels: Buffer.alloc(width * 48 * 4).toString("base64") }], mode === "normal");
    expect(hydrated.poisByPW["-1,0"].filter(p => p.item?.endsWith("_crystal"))).toHaveLength(actual.length);
  });

  it("uses independent spawn rooms and keeps the main arena deflector exactly once", () => {
    const arena = room("general/boss_arena",1536,12288);
    const scenes = [arena, arena, room("spliced/boss_arena",1536,12288), room("general/potion_altar", 0, 0),
      room("temple/altar_top_ending", 0, 12800), room("temple/altar_left", -1024, 6400, "biome=temple_altar_left_empty")];
    expect(templeCrystals(scenes, 0)).toEqual([expect.objectContaining({ item: "worm_crystal", x: 2280, y: 13226 })]);
    expect(templeCrystals(scenes, 1)).toEqual([]);
    expect(templeCrystals([room("temple_altar_empty/altar_empty", 100, 200)], 0)).toEqual([
      expect.objectContaining({ item: "worm_crystal", x: 300, y: 375 })]);
    expect(templeCrystals([room("temple_altar_left/altar_left",600,800)], 0)).toEqual([
      expect.objectContaining({ item: "greed_crystal", x: 862, y: 857 })]);
  });
});
