// @vitest-environment jsdom
/**
 * POI item-emission coverage — the test the previous attempt was missing.
 *
 * The old poi-sprite-coverage.test.ts checks a HAND-WRITTEN list of POI shapes.
 * It passes while real generation still emits items it never thought to list —
 * which is exactly how "It's a wand, ok?" and a dozen chest-loot items ended up
 * as empty squares on the map.
 *
 * This test removes the hand-list: it scans the telescope generation library
 * (lib/noita-telescope/js) for EVERY `item: '<name>'` literal it actually emits,
 * then asserts each one resolves — via the real getSpriteKey — to a sprite key
 * present in the committed atlas. A new item literal that nobody wired a sprite
 * for fails HERE instead of shipping invisible.
 *
 * Items that genuinely have no committed sprite yet are listed in
 * NO_SPRITE_YET with the reason. That list is the owner's to-do: each entry is a
 * real empty-square on the map until a sprite/term is supplied (CLAUDE.md: do
 * not invent in-game terms or sprite mappings — they must come from game data).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import atlas from "../src/data/atlas.json";

const atlasMap = atlas as Record<string, unknown>;
const LIB_JS = join(__dirname, "..", "lib", "noita-telescope", "js");

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

/** Every distinct `item: '<name>'` literal telescope emits across its JS lib. */
function collectEmittedItems(): string[] {
  const set = new Set<string>();
  for (const f of readdirSync(LIB_JS)) {
    if (!f.endsWith(".js")) continue;
    const txt = readFileSync(join(LIB_JS, f), "utf8");
    for (const m of txt.matchAll(/item:\s*['"]([a-z0-9_]+)['"]/gi)) set.add(m[1]);
  }
  return [...set].sort();
}

// Items that are NOT individual map markers — they never reach getSpriteKey as a
// drawable POI, so they need no atlas sprite. Container/structural/branch tokens.
const NOT_A_MARKER = new Set([
  "spell", // resolved via its own spell:* path (covered by poi-sprite-coverage)
  "wand", // resolved via wand sprite path
  "orb", // has its own orb branch
  "potion", "potion_normal", "potion_secret", "potion_random", // potion branch
  "pouch", // pouch branch
  "portal", // teleporter link, rendered as a scene not a marker
  "blocked_by_unlock", // a gating sentinel, not a real item
]);

// Items telescope emits that have NO committed sprite yet. Each is a real
// empty-square on the map / missing icon in cards until a sprite is supplied.
// DO NOT add a getSpriteKey mapping with an invented atlas key to silence this —
// the key must exist in the baked atlas (see CLAUDE.md). Removing an entry here
// without adding a real sprite will (correctly) fail the test.
//
// Owner to-do (needs sprite asset baked into spritesheet + atlas, or a confirmed
// existing-key mapping):
const NO_SPRITE_YET: Record<string, string> = {
  true_orb: "no item:true_orb; ultra-rare chest loot",
  kakkakikkare: "no sprite; rare chest gag item",
  treasure: "no item:treasure key",
  kuu: "no item:kuu (the Moon) sprite",
  kivi: "no item:kivi sprite",
  kummitus: "no item:kummitus sprite",
  kiuaskivi: "no item:kiuaskivi (Sauna Stone) sprite",
  ukkoskivi: "no item:ukkoskivi (Thunderstone) sprite",
  chaos_die: "no item:chaos_die sprite (prop:greed_die exists for greed only)",
  shiny_orb: "no item:shiny_orb sprite",
  greed_orb: "no item:greed_orb sprite",
  refresh_mimic: "no item:refresh_mimic sprite",
  mimic: "no item:mimic sprite (heart-mimic disguise handled elsewhere)",
  potion_mimic_empty: "no item:potion_mimic_empty sprite",
  oil_receptacle_puzzle: "puzzle receptacle, no sprite",
  steam_receptacle_puzzle: "puzzle receptacle, no sprite",
  water_receptacle_puzzle: "puzzle receptacle, no sprite",
  buried_eye_teleporter: "no sprite",
  vault_puzzle_arpaluu: "no item:vault_puzzle_arpaluu sprite",
  vault_puzzle_varpuluuta: "no item:vault_puzzle_varpuluuta sprite",
  trailer_altar: "trailer-only altar, no sprite",
  chest_leggy: "lukki-chest; rendered as a creature elsewhere, no item sprite",
  oil: "branch token, not a standalone marker",
};

function resolves(item: string): boolean {
  const key = getSpriteKey({ type: "item", item }, atlasMap);
  if (key == null) return false;
  const root = Array.isArray(key) ? key[0] : key;
  return !!atlasMap[root];
}

describe("POI item-emission coverage", () => {
  it("every telescope-emitted item resolves to a present atlas sprite (or is allow-listed)", () => {
    const emitted = collectEmittedItems();
    const unexpectedMissing: string[] = [];
    for (const item of emitted) {
      if (NOT_A_MARKER.has(item)) continue;
      if (NO_SPRITE_YET[item] !== undefined) continue;
      if (!resolves(item)) unexpectedMissing.push(item);
    }
    expect(
      unexpectedMissing,
      `These items are emitted by telescope but render as EMPTY SQUARES (no atlas sprite).\n` +
        `Add a real sprite (baked into the atlas) + a getSpriteKey case, or — if it has no\n` +
        `sprite yet — add it to NO_SPRITE_YET with a reason:\n  ${unexpectedMissing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("NO_SPRITE_YET entries are still actually missing (prune resolved ones)", () => {
    // Keeps the to-do list honest: once a sprite is added, the item resolves and
    // must be removed from NO_SPRITE_YET (otherwise the allowlist rots).
    const nowResolved: string[] = [];
    for (const item of Object.keys(NO_SPRITE_YET)) {
      if (NOT_A_MARKER.has(item)) continue;
      if (resolves(item)) nowResolved.push(item);
    }
    expect(
      nowResolved,
      `These now resolve to a sprite — remove them from NO_SPRITE_YET:\n  ${nowResolved.join("\n  ")}`,
    ).toEqual([]);
  });
});
