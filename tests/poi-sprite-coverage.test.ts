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
 * This enumerates every {type}/{item} branch getSpriteKey can return — the
 * special/hand-authored wand sprites, the boss/container POI types, every
 * item:* case, the pillar segments (via the real buildPillarSegments emission
 * path), and every spell — and asserts each resolves to a present atlas key.
 *
 * It also checks the structural invariant that container types carrying `items`
 * are wired into CONTAINER_TYPES (and chest-likes into CHEST_ONLY_TYPES). A POI
 * renders correctly only when (1) getSpriteKey has a case for it, (2) it is in
 * CONTAINER_TYPES if it has contents, and (3) the atlas has the key. Missing any
 * of the three is the recurring "added a POI, forgot a wiring" bug class.
 */
import { describe, it, expect, beforeAll } from "vitest";
import atlas from "../src/data/atlas.json";
import spells from "../src/data/spells.json";
import { buildPillarSegments } from "../src/data/pillars";

const atlasMap = atlas as Record<string, unknown>;

// poi-spatial-index's import chain (spoiler-free / skip-creatures) touches
// localStorage + matchMedia at module-eval time. jsdom's default "about:blank"
// origin doesn't expose localStorage, so stub the globals BEFORE the dynamic
// import below resolves (static imports are hoisted and would run too early).
type GetSpriteKey = (poi: any, atlas?: any) => string | string[] | null;
let getSpriteKey: GetSpriteKey;
let CONTAINER_TYPES: Set<string>;
let CHEST_ONLY_TYPES: Set<string>;

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
  ({ getSpriteKey, CONTAINER_TYPES, CHEST_ONLY_TYPES } = await import("../src/telescope/poi-spatial-index"));
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

  // ── item:* branch coverage ────────────────────────────────────────────────
  // Every {type:'item', item:'…'} case in getSpriteKey, with a representative
  // POI. `material` is the value telescope carries on potions/pouches/essences.
  // A label is attached only so the failure message is readable.
  const ITEM_POIS: Array<{ label: string; poi: any }> = [
    { label: "potion", poi: { type: "item", item: "potion" } },
    { label: "potion_normal", poi: { type: "item", item: "potion_normal" } },
    { label: "pouch", poi: { type: "item", item: "pouch" } },
    { label: "powder_stash_pouch", poi: { type: "item", item: "powder_stash_pouch" } },
    { label: "powder_stash", poi: { type: "item", item: "powder_stash" } },
    { label: "gold", poi: { type: "item", item: "gold" } },
    { label: "goldnugget", poi: { type: "item", item: "goldnugget" } },
    { label: "heart", poi: { type: "item", item: "heart" } },
    { label: "heart_bigger", poi: { type: "item", item: "heart_bigger" } },
    { label: "heart_extra", poi: { type: "item", item: "heart_extra" } },
    { label: "heart_mimic", poi: { type: "item", item: "heart_mimic" } },
    { label: "full_heal", poi: { type: "item", item: "full_heal" } },
    { label: "item:chest", poi: { type: "item", item: "chest" } },
    { label: "item:great_chest", poi: { type: "item", item: "great_chest" } },
    { label: "chest_present", poi: { type: "item", item: "chest_present" } },
    { label: "spell_refresh", poi: { type: "item", item: "spell_refresh" } },
    { label: "broken_wand", poi: { type: "item", item: "broken_wand" } },
    { label: "jar", poi: { type: "item", item: "jar" } },
    { label: "bomb", poi: { type: "item", item: "bomb" } },
    { label: "bomb_holy", poi: { type: "item", item: "bomb_holy" } },
    { label: "bomb_holy_giga", poi: { type: "item", item: "bomb_holy_giga" } },
    { label: "torch", poi: { type: "item", item: "torch" } },
    { label: "wandstone", poi: { type: "item", item: "wandstone" } },
    { label: "essence(default)", poi: { type: "item", item: "essence" } },
    { label: "essence:fire", poi: { type: "item", item: "essence", material: "fire" } },
    { label: "essence:water", poi: { type: "item", item: "essence", material: "water" } },
    { label: "essence:air", poi: { type: "item", item: "essence", material: "air" } },
    { label: "essence:alcohol", poi: { type: "item", item: "essence", material: "alcohol" } },
    { label: "essence:laser", poi: { type: "item", item: "essence", material: "laser" } },
    { label: "orb", poi: { type: "item", item: "orb" } },
    { label: "orb(collected)", poi: { type: "item", item: "orb", collected: true } },
    { label: "perk", poi: { type: "item", item: "perk" } },
    { label: "emerald_tablet", poi: { type: "item", item: "emerald_tablet" } },
    { label: "book", poi: { type: "item", item: "book" } },
    { label: "paha_silma", poi: { type: "item", item: "paha_silma" } },
    { label: "egg", poi: { type: "item", item: "egg" } },
    { label: "karl", poi: { type: "item", item: "karl" } },
    { label: "essence_eater", poi: { type: "item", item: "essence_eater" } },
    { label: "worm_crystal", poi: { type: "item", item: "worm_crystal" } },
    { label: "greed_crystal", poi: { type: "item", item: "greed_crystal" } },
    { label: "statue_hand", poi: { type: "item", item: "statue_hand" } },
    { label: "sun_rock", poi: { type: "item", item: "sun_rock" } },
    { label: "darksun_rock", poi: { type: "item", item: "darksun_rock" } },
    { label: "musicstone", poi: { type: "item", item: "musicstone" } },
    { label: "music_machine", poi: { type: "item", item: "music_machine" } },
  ];

  it("every item:* POI branch resolves to a present atlas key", () => {
    const missing: Array<{ label: string; key: string | string[] | null }> = [];
    for (const { label, poi } of ITEM_POIS) {
      const { key, ok } = resolvesInAtlas(poi);
      if (!ok) missing.push({ label, key });
    }
    expect(missing, `item:* branches with no atlas image (empty squares on map):\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  // ── Container POI types (the chest sprite shown on the map) ────────────────
  const CONTAINER_POIS: Array<{ label: string; poi: any }> = [
    { label: "chest", poi: { type: "chest" } },
    { label: "chest(dark)", poi: { type: "chest", chestVariant: "dark" } },
    { label: "chest(coral)", poi: { type: "chest", chestVariant: "coral" } },
    { label: "pacifist_chest", poi: { type: "pacifist_chest" } },
    { label: "great_chest", poi: { type: "great_chest" } },
    { label: "utility_box", poi: { type: "utility_box" } },
  ];

  it("every container POI type resolves to a present atlas key", () => {
    const missing: Array<{ label: string; key: string | string[] | null }> = [];
    for (const { label, poi } of CONTAINER_POIS) {
      const { key, ok } = resolvesInAtlas(poi);
      if (!ok) missing.push({ label, key });
    }
    expect(missing, `container types with no atlas image (empty squares on map):\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  // ── Achievement-pillar segments ───────────────────────────────────────────
  // Drive the real emission path (buildPillarSegments) so this stays correct as
  // PILLAR_FLAGS changes. Build once all-locked and once all-unlocked: locked
  // engraved segments use the grayscale twin, unlocked use the colour sprite —
  // both must exist in the atlas.
  it("every pillar segment (locked + unlocked) resolves to a present atlas key", () => {
    const segs = [
      ...buildPillarSegments(0, 0, () => false), // all locked  → pillar_gray:*
      ...buildPillarSegments(0, 0, () => true), // all unlocked → pillar:*
    ];
    const missing: Array<{ segCode: string; locked: boolean; key: string | string[] | null }> = [];
    for (const seg of segs) {
      const { key, ok } = resolvesInAtlas(seg);
      if (!ok) missing.push({ segCode: (seg as any).segCode, locked: (seg as any).locked, key });
    }
    expect(missing, `pillar segments with no atlas image:\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  // ── Spells (item:'spell' inside wands/containers) ─────────────────────────
  // Every action in spells.json must have a baked spell:* sprite, else its icon
  // is an empty square in wand/container cards and search (task 10 class:
  // MASS_POLYMORPH "Muodonmuutos", essence spells, etc.).
  it("every spell resolves to a present atlas key", () => {
    const missing: Array<{ id: string; key: string | string[] | null }> = [];
    for (const s of spells as Array<{ id: string }>) {
      const { key, ok } = resolvesInAtlas({ type: "item", item: "spell", spell: s.id });
      if (!ok) missing.push({ id: s.id, key });
    }
    expect(
      missing,
      `${missing.length}/${(spells as unknown[]).length} spells with no atlas sprite (empty squares in cards/search):\n${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  // ── Structural invariant ──────────────────────────────────────────────────
  // A chest-only type must also be a container type, or its contents never get
  // indexed (shown in card/search). Catches the half-wired-POI bug at its root.
  it("CHEST_ONLY_TYPES is a subset of CONTAINER_TYPES", () => {
    const orphans = [...CHEST_ONLY_TYPES].filter((t) => !CONTAINER_TYPES.has(t));
    expect(orphans, `chest-only types missing from CONTAINER_TYPES: ${orphans.join(", ")}`).toEqual([]);
  });
});
