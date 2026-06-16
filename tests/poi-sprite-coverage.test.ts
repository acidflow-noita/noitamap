// @vitest-environment jsdom
/**
 * POI sprite coverage — guards against "empty square" POIs.
 *
 * Every POI that telescope can emit must resolve, via getSpriteKey, to an atlas
 * key that actually exists in the committed src/data/atlas.json. The map marker
 * renderer draws ONLY from that atlas (no per-marker data.zip fallback), so a
 * sprite key missing from the atlas = an invisible / empty-square marker even
 * though the POI still shows up in search and the seed report.
 *
 * This test enumerates the special/hand-authored wand sprites telescope hardcodes
 * (lib/noita-telescope/js/static_spawns.js + misc_generation.js) plus the boss /
 * container POI types, and asserts each resolves to a present atlas key.
 */
import { describe, it, expect, beforeAll } from "vitest";
import atlas from "../src/data/atlas.json";

const atlasMap = atlas as Record<string, unknown>;

// poi-spatial-index's import chain (spoiler-free / skip-creatures) touches
// localStorage + matchMedia at module-eval time. jsdom's default "about:blank"
// origin doesn't expose localStorage, so stub the globals BEFORE the dynamic
// import below resolves (static imports are hoisted and would run too early).
type GetSpriteKey = (poi: any, atlas?: any) => string | string[] | null;
let getSpriteKey: GetSpriteKey;

beforeAll(async () => {
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }
  if (typeof (globalThis as any).matchMedia === "undefined") {
    (globalThis as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    if (typeof (globalThis as any).window !== "undefined") {
      (globalThis as any).window.matchMedia = (globalThis as any).matchMedia;
    }
  }
  ({ getSpriteKey } = await import("../src/telescope/poi-spatial-index"));
});

function resolvesInAtlas(poi: any): { key: string | string[] | null; ok: boolean } {
  const key = getSpriteKey(poi, atlasMap);
  if (key == null) return { key, ok: false };
  const keys = Array.isArray(key) ? key : [key];
  // A composite (array) is fine if its first/root layer is present.
  const ok = keys.length > 0 && !!atlasMap[keys[0]];
  return { key, ok };
}

// Special, hand-authored wand sprites telescope assigns by name. These are the
// ones most prone to atlas-key drift (custom/ paths, original Noita filenames).
const SPECIAL_WAND_SPRITES = [
  "custom/experimental_wand_1", // IfElse Experimental Wand
  "custom/experimental_wand_2", // Colour Experimental Wand
  "custom/actual_wand_honest", // "It's a wand, ok?" Experimental Wand
  "custom/chainsaw", // Saha Experimental Wand
  "custom/good_01", // good wands 1-3
  "custom/good_02",
  "custom/good_03",
  "custom/kantele", // Kantele
  "custom/flute", // Huilu
  "custom/handgun", // starting loadout bolt staff
  "custom/bomb_wand", // starting loadout bomb wand
  "custom/plant_01", // ruusu
  "custom/wood_01", // kiekurakeppi
  "custom/scepter_01", // valtikka
  "custom/vasta",
  "custom/vihta",
  "custom/skull_01", // arpaluu
  "custom/plant_02", // varpuluuta
  "wand_0001", // a generic procedural wand sprite
];

// Non-wand POI types that must render their own marker sprite.
const POI_TYPES = [
  { type: "starting_loadout" },
  { type: "alchemist_boss" },
  { type: "pyramid_boss" },
  { type: "dragon" },
  { type: "boss_wizard" },
  { type: "boss_ghost" },
  { type: "boss_sky" },
  { type: "islandspirit" },
  { type: "boss_centipede" },
  { type: "boss_robot" },
  { type: "boss_meat" },
  { type: "boss_pit" },
  { type: "tiny" },
];

describe("POI sprite coverage", () => {
  it("every special wand sprite resolves to a present atlas key", () => {
    const missing: Array<{ sprite: string; key: string | string[] | null }> = [];
    for (const sprite of SPECIAL_WAND_SPRITES) {
      const { key, ok } = resolvesInAtlas({ type: "wand", sprite });
      if (!ok) missing.push({ sprite, key });
    }
    expect(missing, `Wand sprites with no atlas image (empty squares on map):\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  it("every boss / loadout POI type resolves to a present atlas key", () => {
    const missing: Array<{ type: string; key: string | string[] | null }> = [];
    for (const poi of POI_TYPES) {
      const { key, ok } = resolvesInAtlas(poi);
      if (!ok) missing.push({ type: poi.type, key });
    }
    expect(missing, `POI types with no atlas image (empty squares on map):\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });
});
