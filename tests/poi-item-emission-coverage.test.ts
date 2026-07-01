// @vitest-environment jsdom
/**
 * POI render coverage — asserts POIs actually get a DRAWN sprite.
 *
 * The previous version of this test only checked that `getSpriteKey` returned
 * an atlas key that exists. That can't catch the two failure modes that keep
 * shipping "empty square" POIs:
 *
 *   1. A POI whose atlas key exists but is never drawn because the emission
 *      path suppresses it (e.g. friend boss was flagged `clickOnly`, which
 *      makes buildMarkerData emit a hit-target with spriteKey="" — a valid
 *      atlas key for `enemy:friend` exists, so a key-only test stays green
 *      while the sprite is invisible on every map).
 *   2. A POI type that the regex-based emitted-item scan never sees at all
 *      (wands are `type:"wand"`, bosses are `type:"friend"` etc. — not
 *      `item:'<name>'` literals), so it was never tested despite the docstring
 *      claiming it covered "It's a wand, ok?".
 *
 * So this test runs the REAL buildMarkerData over representative POI shapes and
 * asserts the sprite that would be painted on the map is present. A regression
 * that suppresses a sprite (clickOnly, missing key, unwired container) fails
 * HERE instead of shipping invisible.
 *
 * NOTE: This exercises the marker/decor emission path (same code the live map
 * and the DZI decor bake both call). It does NOT run the pixel compositor
 * (jsdom has no real canvas), so bake-only geometry bugs — e.g. a marker past a
 * biome edge being clipped out of the region canvas — are out of scope here and
 * covered by manual bake QA.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import atlas from "../src/data/atlas.json";

const atlasMap = atlas as Record<string, unknown>;
const LIB_JS = join(__dirname, "..", "lib", "noita-telescope", "js");

type GetSpriteKey = (poi: any, atlas?: any) => string | string[] | null;
type BuildMarkerData = (result: any) => Promise<{ items: Array<{ poi: any; spriteKey: string | string[]; osdX: number; osdY: number; w: number; h: number }> }>;

let getSpriteKey: GetSpriteKey;
let buildMarkerData: BuildMarkerData;

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
  // buildMarkerData awaits loadSpritesheet(), which sets `img.src` and waits for
  // onload. jsdom never fires onload for a file path, so stub Image to resolve
  // immediately — the spritesheet bitmap is only stored on the returned object;
  // the `items` array (all this test inspects) is built from the atlas alone.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    set src(v: string) {
      this._src = v;
      queueMicrotask(() => this.onload && this.onload());
    }
    get src() {
      return this._src;
    }
  }
  (globalThis as any).Image = FakeImage as any;

  ({ getSpriteKey } = await import("../src/telescope/poi-spatial-index"));
  ({ buildMarkerData } = (await import("../src/telescope/poi-spatial-index")) as any);
});

/** Root atlas key of a getSpriteKey result. */
function rootKeyOf(key: string | string[] | null): string | null {
  if (key == null) return null;
  const k = Array.isArray(key) ? key[0] : key;
  return k === "" ? null : k;
}

// ── Real-render coverage ────────────────────────────────────────────────────
//
// Each fixture is a POI shape telescope actually emits (types/fields taken from
// lib/noita-telescope + telescope-adapter). `expect` is the atlas key that MUST
// appear as a drawn (non-empty, atlas-present) sprite among buildMarkerData's
// output. `expect: CLICK_ONLY` means the POI is deliberately painted into the
// baked background and emits only an invisible hit target (no drawn sprite) —
// asserted so a future change that starts/stops drawing it is caught.
const CLICK_ONLY = Symbol("click-only");

interface Fixture {
  label: string;
  poi: any;
  expect: string | string[] | typeof CLICK_ONLY;
}

const FIXTURES: Fixture[] = [
  // The regressions this file exists for:
  {
    label: "friend boss (Toveri) — must draw enemy:friend, NOT be click-only",
    poi: { type: "friend", name: "Toveri", x: -5120, y: 4608, biome: "friend_3", items: [{ type: "item", item: "full_heal" }] },
    expect: "enemy:friend",
  },
  {
    label: "It's a wand, ok? — Experimental Wand 1",
    poi: { type: "wand", item: "wand", sprite: "custom/experimental_wand_1", name: "IfElse Experimental Wand", x: 16121, y: 9987 },
    expect: "wand:custom/experimental_wand_1",
  },
  {
    label: "It's a wand, ok? — Experimental Wand 2",
    poi: { type: "wand", item: "wand", sprite: "custom/experimental_wand_2", name: "Colour Experimental Wand", x: 16121, y: 9987 },
    expect: "wand:custom/experimental_wand_2",
  },
  // A spread of other emission paths so a broad wiring regression trips here too.
  {
    label: "boss_wizard (Mestarien mestari) — multi-layer sprite",
    poi: { type: "boss_wizard", name: "Mestarien mestari", x: 12573, y: 15178 },
    expect: "enemy:boss_wizard_wizard_body",
  },
  {
    label: "regular wand (wand_0484)",
    poi: { type: "wand", item: "wand", sprite: "wand_0484", name: "Some Wand", x: 0, y: 0 },
    expect: "wand:wand_0484",
  },
  {
    label: "emerald tablet",
    poi: { type: "item", item: "emerald_tablet", x: 0, y: 0 },
    expect: "item:emerald_tablet",
  },
  {
    label: "essence of earth (laser key)",
    poi: { type: "item", item: "essence", material: "laser", x: 0, y: 0 },
    expect: "essence:laser",
  },
  {
    label: "chest",
    poi: { type: "chest", x: 0, y: 0 },
    expect: "item:chest_random",
  },
  // Deliberately click-only (painted into baked bg): fisher's Alchemist's Note.
  {
    label: "Alchemist's Note (fisher book) — click-only by design",
    poi: { type: "item", item: "book", clickOnly: true, nameKey: "booktitle_fisher", name: "Alchemist's Note", x: -12440, y: 200 },
    expect: CLICK_ONLY,
  },
];

describe("POI render coverage (real buildMarkerData)", () => {
  it("every renderable fixture POI produces a drawn, atlas-present sprite", async () => {
    // One generation result carrying all fixtures on the main plane.
    const result = {
      worldCenter: 0,
      poisByPW: { "0,0": FIXTURES.map((f) => f.poi) },
    };
    const md = await buildMarkerData(result as any);

    // Map each fixture's POI (by identity for top-level, by coords for the wand
    // marker) to the drawn sprite keys emitted for it.
    const drawnRootsByPoi = new Map<any, Set<string>>();
    for (const it of md.items) {
      const root = rootKeyOf(it.spriteKey);
      if (root === null) continue;
      let set = drawnRootsByPoi.get(it.poi);
      if (!set) drawnRootsByPoi.set(it.poi, (set = new Set()));
      set.add(root);
    }
    // Every drawn root key across the whole batch (for container-unwrap cases
    // where the inner item is a fresh object not identical to the fixture poi).
    const allDrawnRoots = new Set<string>();
    for (const set of drawnRootsByPoi.values()) for (const k of set) allDrawnRoots.add(k);

    const failures: string[] = [];
    for (const f of FIXTURES) {
      if (f.expect === CLICK_ONLY) {
        // Must emit a marker but with NO drawn sprite (spriteKey === "").
        const emitted = md.items.some((it) => it.poi === f.poi);
        const drew = drawnRootsByPoi.has(f.poi);
        if (!emitted) failures.push(`${f.label}: expected a click-only hit target, none emitted`);
        else if (drew) failures.push(`${f.label}: expected NO drawn sprite (click-only), but one was drawn`);
        continue;
      }
      const expectedRoot = Array.isArray(f.expect) ? f.expect[0] : f.expect;
      if (!atlasMap[expectedRoot]) {
        failures.push(`${f.label}: test's own expected key '${expectedRoot}' is not in the atlas`);
        continue;
      }
      const own = drawnRootsByPoi.get(f.poi);
      const drawn = (own && own.has(expectedRoot)) || allDrawnRoots.has(expectedRoot);
      if (!drawn) {
        failures.push(
          `${f.label}: expected drawn sprite '${expectedRoot}' but buildMarkerData emitted no such marker ` +
            `(this is the "empty square" bug — a suppressed/mis-wired sprite)`,
        );
      }
    }

    expect(failures, `\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});

// ── Secondary guard: every emitted `item:` literal resolves to an atlas key ───
//
// This is the old scan, kept because it cheaply catches a NEW item literal that
// nobody wired a sprite for. It is a KEY-EXISTENCE guard only — it does not
// prove the item is drawn (that's the real-render block above), and it does not
// see wands/bosses/containers (non-`item:` shapes).
const NOT_A_MARKER = new Set([
  "spell", "wand", "orb",
  "potion", "potion_normal", "potion_secret", "potion_random",
  "pouch", "portal", "blocked_by_unlock",
]);

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

function collectEmittedItems(): string[] {
  const set = new Set<string>();
  for (const f of readdirSync(LIB_JS)) {
    if (!f.endsWith(".js")) continue;
    const txt = readFileSync(join(LIB_JS, f), "utf8");
    for (const m of txt.matchAll(/item:\s*['"]([a-z0-9_]+)['"]/gi)) set.add(m[1]);
  }
  return [...set].sort();
}

function resolvesInAtlas(item: string): boolean {
  const root = rootKeyOf(getSpriteKey({ type: "item", item }, atlasMap));
  return root !== null && !!atlasMap[root];
}

describe("emitted item literals resolve to an atlas key (key-existence guard)", () => {
  it("every telescope-emitted item: literal resolves (or is allow-listed)", () => {
    const unexpectedMissing = collectEmittedItems().filter(
      (item) => !NOT_A_MARKER.has(item) && NO_SPRITE_YET[item] === undefined && !resolvesInAtlas(item),
    );
    expect(
      unexpectedMissing,
      `These item: literals resolve to no atlas sprite (empty square). Add a real sprite +\n` +
        `getSpriteKey case, or add to NO_SPRITE_YET with a reason:\n  ${unexpectedMissing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("NO_SPRITE_YET stays honest — prune entries that now resolve", () => {
    const nowResolved = Object.keys(NO_SPRITE_YET).filter((item) => !NOT_A_MARKER.has(item) && resolvesInAtlas(item));
    expect(
      nowResolved,
      `These now resolve — remove from NO_SPRITE_YET:\n  ${nowResolved.join("\n  ")}`,
    ).toEqual([]);
  });
});
