import { describe, expect, it } from "vitest";
import {
  getAllPOIsFlat,
  getPoiPreviewItems,
  BOSS_REWARD_TYPES,
} from "../src/telescope/poi-inventory";
import fixture from "./fixtures/search/306813029-great-chests.json";

const project = (...pois: any[]) =>
  getAllPOIsFlat({ poisByPW: { "0,0": pois } });
// Mirrors consumers that walk chest loot as well as the flat inventory. A
// parent/child duplicate must not be counted twice even by this consumer.
const ownedItems = (pois: any[]): any[] =>
  pois.flatMap((p) => [p, ...ownedItems(p.items ?? [])]);
const countGreatChests = (pois: any[]) =>
  ownedItems(pois).filter(
    (p) => p.type === "great_chest" || p.item === "great_chest",
  ).length;

describe("countable world inventory", () => {
  it("matches the supplied Sage reference of 8 for seed 306813029", () => {
    const before = JSON.stringify(fixture);
    const flat = getAllPOIsFlat(fixture);
    expect(flat.filter((p) => p.type === "great_chest")).toHaveLength(8);
    expect(countGreatChests(flat)).toBe(8);
    expect(flat.filter((p) => p.parentType === "boss_fish")).toEqual([]);
    const boss = flat.find((p) => p.type === "boss_fish")!;
    expect(boss.items).toBeUndefined();
    expect(boss.rewards?.map((p) => p.item)).toEqual([
      "full_heal",
      "great_chest",
    ]);
    expect(getPoiPreviewItems(boss)).toEqual(boss.rewards);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it.each([...BOSS_REWARD_TYPES])(
    "does not turn %s rewards into spawned items",
    (type) => {
      const flat = project({
        id: "boss",
        type,
        x: 1,
        y: 2,
        items: [{ id: "drop", type: "wand", cards: ["LIGHT_BULLET"] }],
      });
      expect(flat).toHaveLength(1);
      expect(flat[0].type).toBe(type);
      expect(ownedItems(flat).filter((p) => p.type === "wand")).toEqual([]);
      expect(getPoiPreviewItems(flat[0])?.[0].id).toBe("drop");
    },
  );

  it("counts expanded shop items only once but preserves the shop's preview", () => {
    const flat = project({
      id: "shop",
      type: "holy_mountain_shop",
      x: 0,
      y: 512,
      items: [
        { id: "a", type: "wand", x: 0, y: 512 },
        { id: "b", type: "wand", x: 0, y: 512 },
        { id: "ignored", type: "wand", ignore: true },
      ],
    });
    expect(flat).toHaveLength(3);
    expect(flat[0].items).toBeUndefined();
    expect(getPoiPreviewItems(flat[0])?.map((p) => p.id)).toEqual(["a", "b"]);
    expect(ownedItems(flat).filter((p) => p.type === "wand")).toHaveLength(2);
    expect(flat.slice(1).map((p) => p.parentId)).toEqual(["shop", "shop"]);
  });

  it("retains chest loot without emitting duplicate loose items", () => {
    const flat = project({
      id: "chest",
      type: "chest",
      x: 0,
      y: 0,
      items: [{ id: "wand", type: "wand", cards: ["LIGHT_BULLET"] }],
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].items).toHaveLength(1);
    expect(getPoiPreviewItems(flat[0])).toBe(flat[0].items);
    expect(ownedItems(flat).filter((p) => p.type === "wand")).toHaveLength(1);
  });

  it("keeps the Sampo, which exists before Kolmisilma is defeated", () => {
    const flat = project({
      id: "kolmi",
      type: "boss_centipede",
      x: 3556,
      y: 13026,
      items: [
        {
          id: "sampo",
          type: "entity",
          entity: "boss_centipede_sampo",
          name: "Sampo",
          x: 3555,
          y: 13050,
        },
      ],
    });
    expect(flat.map((p) => p.id)).toEqual(["kolmi", "sampo"]);
    expect(flat[0].rewards).toBeUndefined();
    expect(flat[0].items).toBeUndefined();
    expect(flat[1]).toMatchObject({
      parentType: "boss_centipede",
      parentId: "kolmi",
      worldX: 3555,
      worldY: 13050,
    });
  });

  it("never deduplicates legitimate co-located entities or parallel worlds", () => {
    const flat = getAllPOIsFlat({
      poisByPW: {
        "0,0": [
          { id: "a", type: "great_chest", x: -13967, y: 10029 },
          { id: "b", type: "great_chest", x: -13967, y: 10029 },
          {
            id: "fish",
            type: "boss_fish",
            x: -13967,
            y: 10029,
            items: [{ type: "item", item: "great_chest" }],
          },
        ],
        "1,0": [{ id: "c", type: "great_chest", x: -13967, y: 10029 }],
      },
    });
    expect(countGreatChests(flat)).toBe(3);
    expect(
      flat.filter((p) => p.type === "great_chest").map((p) => p.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("still unwraps actual enemy spawns without counting the synthetic group", () => {
    const flat = project({
      type: "enemies",
      id: "spawn",
      x: 100,
      y: 200,
      biome: "coalmine",
      items: [
        { id: "a", type: "entity", entity: "longleg", x: 100, y: 200 },
        { id: "b", type: "entity", entity: "longleg", x: 100, y: 200 },
      ],
    });
    expect(flat.map((p) => p.id)).toEqual(["a", "b"]);
    expect(
      flat.every((p) => p.parentType === "enemies" && p.biome === "coalmine"),
    ).toBe(true);
  });
});
