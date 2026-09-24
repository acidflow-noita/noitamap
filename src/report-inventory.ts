/** Selected-seed inventory only. These counts are never population references.
 * Shared by the live report and daily baker so ownership/quantities agree. */
export interface InventoryPOI {
  type: string;
  pw?: number;
  [key: string]: any;
}
export type LootSource = "world" | "shop" | "chest" | "wand" | "always" | "reward";
export const UKKO_ENTITIES = new Set(["thundermage", "thundermage_big"]);

/** Telescope's static_spawns.js emits these as ordinary wands, including Saha
 * (a boss reward). Their fixed properties/decks, and frame-dependent ranges,
 * cannot distinguish one seed from another. Do not generalize to custom/*:
 * a guaranteed position or boss source can still contain seed-generated loot. */
const FIXED_WAND_SPRITES = new Set([
  "custom/chainsaw", "custom/good_01", "custom/good_02", "custom/good_03",
  "custom/experimental_wand_1", "custom/experimental_wand_2",
  "custom/actual_wand_honest", "custom/kantele", "custom/flute",
]);
// static_spawns.js emits the instrument separately from a shop-shaped owner
// holding two copies of every fixed note. Match that audited inventory, not
// every pickup (or every shop) in these biomes: the Tree also has rolled eggs.
const FIXED_INSTRUMENT_NOTES: Record<string, readonly string[]> = {
  mountain_tree: ["KANTELE_A", "KANTELE_D", "KANTELE_DIS", "KANTELE_E", "KANTELE_G"],
  ocarina: ["OCARINA_A", "OCARINA_B", "OCARINA_C", "OCARINA_D", "OCARINA_E", "OCARINA_F", "OCARINA_GSHARP", "OCARINA_A2"],
};
function fixedInstrumentNotes(poi: InventoryPOI): boolean {
  if (poi.type !== "shop" || !Object.hasOwn(FIXED_INSTRUMENT_NOTES, poi.biome)) return false;
  const notes = FIXED_INSTRUMENT_NOTES[poi.biome];
  const items = poi.items ?? poi.previewItems;
  if (!Array.isArray(items) || items.length !== notes.length * 2) return false;
  return notes.every(note => items.filter(item => spellId(item) === note && quantity(item) === 1).length === 2);
}
// Exact invariant children from boss-pois.ts, telescope-adapter.ts and
// Telescope's misc_generation.js. Other drops from the SAME boss remain valid:
// e.g. the Pit Boss's generated wands and the Dragon's rolled orbit spell.
const FIXED_BOSS_ITEMS: Record<string, readonly string[]> = {
  boss_wizard: ["item:wandstone", "spell:RESET", "spell:ADD_TRIGGER", "spell:ADD_TIMER", "spell:ADD_DEATH_TRIGGER", "spell:DUPLICATE"],
  boss_ghost: ["item:sunseed", "item:full_heal"],
  boss_robot: ["perk:map"],
  boss_sky: ["entity:playerghost"],
  islandspirit: ["spell:MASS_POLYMORPH"],
  boss_fish: ["item:great_chest", "item:full_heal"],
  boss_pit: ["spell:WORM_RAIN", "spell:METEOR_RAIN", "item:full_heal"],
  pit_boss: ["spell:WORM_RAIN", "spell:METEOR_RAIN", "item:full_heal"],
  friend: ["item:full_heal"],
  dragon: ["item:heart"],
};

function fixedReportLoot(poi: InventoryPOI, owner = poi.parentType): boolean {
  if (poi.type === "wand" && FIXED_WAND_SPRITES.has(String(poi.sprite))) return true;
  if (fixedInstrumentNotes(poi)) return true;
  // Adapter Crystal Key chests contain invariant first-open spell lists;
  // their frame-random repeat-open contents are not predicted map inventory.
  if (poi.type === "chest" && (poi.chestVariant === "coral" || poi.chestVariant === "dark"
    || poi.nameKey === "item_chest_light" || poi.nameKey === "item_chest_dark")) return true;
  const spell = spellId(poi);
  const identity = spell ? `spell:${spell}`
    : poi.type === "entity" ? `entity:${String(poi.entity ?? "").split("/").pop()!.replace(/\.xml$/i, "")}`
      : poi.item === "perk" ? `perk:${poi.perk}`
        : `item:${poi.item ?? poi.type}`;
  return Object.hasOwn(FIXED_BOSS_ITEMS, String(owner))
    && FIXED_BOSS_ITEMS[String(owner)].includes(identity);
}

/** Seed-report finds only; leave the map/search inventory and POI card previews
 * untouched. Filter before counting or ranking so every report surface agrees.
 * Flat children and nested contents owned by an excluded object disappear too;
 * the same spell/item from a random chest, shop or boss roll remains eligible. */
export function reportFindInventory<P extends InventoryPOI>(records: P[]): P[] {
  const excludedIds = new Set<string>();
  const excludedUnidentifiedChildren = new Set<string>();
  const children = new Map<string, P[]>();
  // Native bake metadata can predate runtime ID assignment. Its flat children
  // still retain the owner's type and each preview's exact world position.
  function unidentifiedChildKey(poi: InventoryPOI, owner?: InventoryPOI): string | null {
    if (poi.parentId || (!owner && !poi.parentType)) return null;
    const x = poi.x ?? poi.worldX ?? owner?.x ?? owner?.worldX;
    const y = poi.y ?? poi.worldY ?? owner?.y ?? owner?.worldY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return JSON.stringify([owner?.type ?? poi.parentType, poi.pw ?? owner?.pw ?? 0,
      poi.type, poi.item, poi.spell, poi.biome ?? owner?.biome, x, y]);
  }
  for (const poi of records) {
    if (fixedReportLoot(poi)) {
      if (poi.id) excludedIds.add(poi.id);
      else {
        const owned = poi.previewItems ?? poi.items;
        if (Array.isArray(owned)) for (const child of owned) {
          const key = unidentifiedChildKey(child, poi);
          if (key) excludedUnidentifiedChildren.add(key);
        }
      }
    }
    if (poi.parentId) {
      const siblings = children.get(poi.parentId) ?? [];
      siblings.push(poi); children.set(poi.parentId, siblings);
    }
  }
  // Set iteration visits additions, so even out-of-order descendants propagate.
  for (const id of excludedIds) for (const child of children.get(id) ?? [])
    if (child.id) excludedIds.add(child.id);
  function filter(poi: P, owner?: string, depth = 0): P | null {
    if (depth > 32 || fixedReportLoot(poi, poi.parentType ?? owner)
      || excludedIds.has(poi.id) || excludedIds.has(poi.parentId)
      || excludedUnidentifiedChildren.has(unidentifiedChildKey(poi) ?? "")) return null;
    if (!Array.isArray(poi.items)) return poi;
    const items = poi.items.map((item: P) => filter(item, poi.type, depth + 1)).filter((item: P | null): item is P => item !== null);
    return items.every((item: P, index: number) => item === poi.items[index]) && items.length === poi.items.length
      ? poi : { ...poi, items };
  }
  return records.map(poi => filter(poi)).filter((poi): poi is P => poi !== null);
}

export function spellId(poi: InventoryPOI): string | null {
  return poi.type === "spell" && poi.item
    ? String(poi.item)
    : poi.type === "item" && poi.item === "spell" && poi.spell
      ? String(poi.spell) : null;
}
export function cardId(card: unknown): string | null {
  if (typeof card === "string") return card || null;
  if (card && typeof card === "object" && "id" in card) return String(card.id || "") || null;
  return null;
}
export function quantity(poi: InventoryPOI): number {
  const value = Number(poi.count ?? poi.amount ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
function source(poi: InventoryPOI): LootSource {
  if (poi.isBossReward) return "reward";
  if (poi.parentType === "wand") return "wand";
  if (/chest/.test(poi.parentType ?? "")) return "chest";
  if (/shop/.test(poi.parentType ?? "")) return "shop";
  return "world";
}

/** Consume flattened children OR nested items, never previews/rewards twice.
 * A wand's actual deck owns its spells ahead of duplicated flat children. */
export function visitReportInventory<P extends InventoryPOI>(
  records: P[],
  visitor: {
    item?: (poi: P, from: LootSource, count: number) => void;
    spell?: (id: string, poi: P, from: LootSource, count: number) => void;
  },
): void {
  const expanded = new Set(records.filter(poi => !poi.ignore).map(poi => poi.parentId).filter(Boolean));
  const deckOwners = new Set(records.filter(poi => !poi.ignore && poi.type === "wand"
    && (Array.isArray(poi.cards) || Array.isArray(poi.always_casts))).map(poi => poi.id).filter(Boolean));
  function visit(poi: P, from: LootSource, multiplier = 1, depth = 0) {
    if (poi.ignore || depth > 32) return;
    const n = quantity(poi) * multiplier;
    const id = spellId(poi);
    if (id && !(poi.parentType === "wand" && deckOwners.has(poi.parentId))) visitor.spell?.(id, poi, from, n);
    if (poi.type === "wand") {
      for (const card of Array.isArray(poi.cards) ? poi.cards : []) {
        const id = cardId(card);
        if (id) visitor.spell?.(id, poi, from === "reward" ? "reward" : from === "chest" ? "chest" : "wand", n);
      }
      for (const card of Array.isArray(poi.always_casts) ? poi.always_casts : []) {
        const id = cardId(card);
        if (id) visitor.spell?.(id, poi, "always", n);
      }
    }
    visitor.item?.(poi, from, n);
    if (Array.isArray(poi.items) && !(poi.id && expanded.has(poi.id))) {
      for (const item of poi.items) {
        const child = {
          ...item, pw: poi.pw, worldX: poi.worldX, worldY: poi.worldY,
          biome: item.biome ?? poi.biome, parentId: poi.id ?? poi.parentId,
          parentType: poi.type, isBossReward: poi.isBossReward || item.isBossReward,
        } as P;
        visit(child, child.isBossReward ? "reward" : /chest/.test(poi.type) ? "chest"
          : /shop/.test(poi.type) ? "shop" : from, n, depth + 1);
      }
    }
  }
  for (const poi of records) visit(poi, source(poi));
}

/** Compact tuple: natural inventory, conditional boss rewards. */
export type InventoryCount = [number, number];
export type InventoryKind = "spells" | "materials" | "ukkos";
export type WorldInventoryCounts = Record<InventoryKind, Record<string, InventoryCount>>;
export interface ReportInventorySnapshot {
  /** V1/v2 included invariant special/boss loot or instrument notes. Recount
   * preserved POIs instead of trusting those older eligibility policies. */
  version: 3;
  seed: number;
  worlds: Record<number, WorldInventoryCounts>;
}
const kinds: InventoryKind[] = ["spells", "materials", "ukkos"];
const emptyWorld = (): WorldInventoryCounts => ({ spells: {}, materials: {}, ukkos: {} });
export function createReportInventorySnapshot(seed: number, records: InventoryPOI[], worlds: number[] = []): ReportInventorySnapshot {
  const snapshot: ReportInventorySnapshot = { version: 3, seed, worlds: {} };
  for (const pw of worlds) snapshot.worlds[pw] = emptyWorld();
  for (const poi of records) snapshot.worlds[poi.pw ?? 0] ??= emptyWorld();
  function add(kind: InventoryKind, id: string, poi: InventoryPOI, count: number) {
    const totals = (snapshot.worlds[poi.pw ?? 0] ??= emptyWorld())[kind];
    const entry = Object.hasOwn(totals, id) ? totals[id] : (Object.defineProperty(totals, id, {
      value: [0, 0], enumerable: true, writable: true, configurable: true,
    }), totals[id]);
    entry[poi.isBossReward ? 1 : 0] += count;
  }
  visitReportInventory(reportFindInventory(records), {
    spell: (id, poi, _from, count) => add("spells", id, poi, count),
    item: (poi, _from, count) => {
      if (poi.material) add("materials", String(poi.material), poi, count);
      const entity = poi.type === "entity" ? String(poi.entity ?? "").split("/").pop()!.replace(/\.xml$/i, "") : "";
      if (UKKO_ENTITIES.has(entity)) add("ukkos", entity, poi, count);
    },
  });
  return snapshot;
}

/** Invalid, mismatched or incomplete snapshots fall back to live POI counting. */
export function readReportInventorySnapshot(value: unknown, seed: number, requiredWorlds: number[] = []): ReportInventorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as ReportInventorySnapshot;
  if (v.version !== 3 || v.seed !== seed || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
    || !v.worlds || typeof v.worlds !== "object" || Array.isArray(v.worlds)) return null;
  for (const [pw, counts] of Object.entries(v.worlds)) {
    if (!Number.isSafeInteger(Number(pw)) || String(Number(pw)) !== pw || !counts || typeof counts !== "object") return null;
    for (const kind of kinds) {
      if (!counts[kind] || typeof counts[kind] !== "object" || Array.isArray(counts[kind])) return null;
      for (const count of Object.values(counts[kind]))
        if (!Array.isArray(count) || count.length !== 2 || count.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) return null;
    }
  }
  return requiredWorlds.every(pw => Object.hasOwn(v.worlds, pw)) ? v : null;
}

export function sliceReportInventorySnapshot(snapshot: ReportInventorySnapshot, worlds: number[]): ReportInventorySnapshot {
  return { ...snapshot, worlds: Object.fromEntries(worlds.filter(pw => Object.hasOwn(snapshot.worlds, pw)).map(pw => [pw, snapshot.worlds[pw]])) };
}

/** null means this world is unavailable; zero means it was counted and absent. */
export function reportInventoryCount(snapshot: ReportInventorySnapshot, worlds: number[], kind: InventoryKind, ids?: string[]): number | null {
  if (worlds.some(pw => !Object.hasOwn(snapshot.worlds, pw))) return null;
  return worlds.reduce((sum, pw) => {
    const counts = snapshot.worlds[pw][kind];
    return sum + (ids ? [...new Set(ids)].map(id => Object.hasOwn(counts, id) ? counts[id] : [0, 0]) : Object.values(counts))
      .reduce((n, count) => n + count[0] + count[1], 0);
  }, 0);
}
