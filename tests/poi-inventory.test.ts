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

describe("available inventory without parent/child duplication", () => {
  it("has 9 available chests, of which 8 match the natural-only Sage reference", () => {
    const before = JSON.stringify(fixture);
    const flat = getAllPOIsFlat(fixture);
    expect(flat.filter((p) => p.type === "great_chest")).toHaveLength(8);
    expect(countGreatChests(flat)).toBe(9);
    expect(countGreatChests(flat.filter((p) => !p.isBossReward))).toBe(8);
    const drops = flat.filter((p) => p.parentType === "boss_fish");
    expect(drops).toHaveLength(2);
    expect(drops.every((p) => p.isBossReward === true)).toBe(true);
    expect(drops.find((p) => p.item === "great_chest")).toMatchObject({
      parentId: "d-pw_0_0_boss_fish_-13967_10029_11606",
      worldX: -13967,
      worldY: 10029,
    });
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
    "exposes each %s reward once, with explicit provenance",
    (type) => {
      const flat = project({
        id: "boss",
        type,
        x: 1,
        y: 2,
        items: [{ id: "drop", type: "wand", cards: ["LIGHT_BULLET"] }],
      });
      expect(flat).toHaveLength(2);
      expect(flat[0].type).toBe(type);
      expect(ownedItems(flat).filter((p) => p.type === "wand")).toHaveLength(1);
      expect(flat[1]).toMatchObject({
        id: "drop",
        parentId: "boss",
        parentType: type,
        isBossReward: true,
        worldX: 1,
        worldY: 2,
      });
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

  it("preserves quantities without adding a boss or chest preview to the item total", () => {
    const flat = project(
      {
        id: "chest",
        type: "chest",
        x: 0,
        y: 0,
        items: [
          {
            id: "potion-a",
            type: "item",
            item: "potion",
            material: "ambrosia",
          },
          {
            id: "potion-b",
            type: "item",
            item: "potion",
            material: "ambrosia",
          },
        ],
      },
      {
        id: "boss",
        type: "boss_fish",
        x: 10,
        y: 20,
        items: [{ id: "hearts", type: "item", item: "full_heal", count: 2 }],
      },
    );
    expect(ownedItems(flat).filter((p) => p.item === "potion")).toHaveLength(2);
    const hearts = ownedItems(flat).filter((p) => p.item === "full_heal");
    expect(hearts).toHaveLength(1);
    expect(hearts.reduce((n, p) => n + (p.count ?? 1), 0)).toBe(2);
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
    expect(flat.every((p) => !p.isBossReward)).toBe(true);
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
    expect(countGreatChests(flat)).toBe(4);
    expect(countGreatChests(flat.filter((p) => !p.isBossReward))).toBe(3);
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

describe("authored coral chest biome", () => {
  it("repairs old baked/cached coral metadata in all worlds without mutating it", () => {
    const raw = {poisByPW:Object.fromEntries([-1,0,1].map(pw=>[`${pw},0`,[
      {id:`coral-${pw}`,type:"chest",chestVariant:"coral",biome:"desert",x:11519+pw*35840,y:-4886,items:[{type:"item",item:"spell",spell:"DIVIDE_2"}]},
      {id:`desert-${pw}`,type:"chest",biome:"desert",x:11519+pw*35840,y:0,items:[]},
    ]]))};
    const before=JSON.stringify(raw);
    const flat=getAllPOIsFlat(raw as any);
    expect(flat.filter(p=>p.id?.startsWith("coral-")).map(p=>p.biome)).toEqual(["song_room","song_room","song_room"]);
    expect(flat.filter(p=>p.id?.startsWith("desert-")).every(p=>p.biome==="desert")).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);expect(flat).toHaveLength(6);
  });
});

describe("inventory projection copies", () => {
  it("overrides stale projected fields while retaining metadata, key order and shallow preview references", () => {
    const symbol = Symbol('metadata');
    const child = Object.freeze({ type: 'wand', x: 0, y: null, pw: 99,
      parentType: 'old-type', parentId: 'old-id', isBossReward: false,
      biome: '', worldX: 999, worldY: 888, cards: ['BOMB'], extra: { keep: true }, [symbol]: 'kept' });
    const items = Object.freeze([child]);
    const parent = Object.freeze({ type: 'boss_fish', id: 'fish', x: -35840, y: -24576,
      pw: 88, worldX: 777, worldY: 666, biome: 'lake', items,
      extra: { parent: true }, rewards: ['old-preview'] });
    const flat = getAllPOIsFlat({ poisByPW: { '-1,-1': [parent] } } as any);
    expect(flat[0]).toMatchObject({ id: 'fish', pw: -1, worldX: -35840, worldY: -24576, biome: 'lake' });
    expect(Object.hasOwn(flat[0], 'items')).toBe(false);
    expect(flat[0].rewards).toEqual(items);
    expect(flat[0].rewards).not.toBe(items);
    expect(flat[0].rewards?.[0]).toBe(child);
    expect(flat[0].extra).toBe(parent.extra);
    expect(flat[1]).toMatchObject({ pw: -1, parentType: 'boss_fish', parentId: 'fish',
      isBossReward: true, biome: 'lake', worldX: 0, worldY: -24576 });
    expect(flat[1].cards).toBe(child.cards);
    expect(flat[1].extra).toBe(child.extra);
    expect((flat[1] as any)[symbol]).toBe('kept');
    expect(Reflect.ownKeys(flat[1])).toEqual(Reflect.ownKeys(child));
    expect(child.parentId).toBe('old-id');
    expect(parent.rewards).toEqual(['old-preview']);
  });

  it("reads changed IDs, coordinates and reward metadata on each call without altering previous projections", () => {
    const child = { type: 'wand', id: 'old-child', x: null, y: 0, biome: '', isBossReward: false };
    const parent = { type: 'holy_mountain_shop', id: 'old-shop', x: 100, y: 200, biome: 'coalmine', items: [child] };
    const generation = { poisByPW: { '1,0': [parent] } } as any;
    const previous = getAllPOIsFlat(generation);
    parent.id = 'new-shop'; parent.x = 300; parent.biome = 'snowcave';
    child.id = 'new-child'; child.x = 12 as any; child.isBossReward = true;
    const current = getAllPOIsFlat(generation);
    expect(previous[1]).toMatchObject({ id: 'old-child', parentId: 'old-shop', worldX: 100,
      worldY: 0, pw: 1, biome: 'coalmine', isBossReward: false });
    expect(current[1]).toMatchObject({ id: 'new-child', parentId: 'new-shop', worldX: 12,
      worldY: 0, pw: 1, biome: 'snowcave', isBossReward: true });
    expect(previous[1]).not.toBe(current[1]);
    expect(current[0].previewItems?.[0]).toBe(child);
    expect(Object.hasOwn(current[0], 'items')).toBe(false);
    expect(Reflect.ownKeys(current[1])).toEqual(['type', 'id', 'x', 'y', 'biome', 'isBossReward',
      'pw', 'parentType', 'parentId', 'worldX', 'worldY']);
  });
});
