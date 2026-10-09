// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { Document as SearchDocument } from "flexsearch";
import i18next from "../src/i18n";
import {
  getAllPOIsFlat,
  BOSS_REWARD_TYPES,
} from "../src/telescope/poi-inventory";
import fixture from "./fixtures/search/306813029-great-chests.json";
import cubeFixture from "./fixtures/search/786433191-meditation-cube.json";
import { normalizeScenePOIs } from "../src/telescope/scene-pois";
import { PILLAR_REQUIREMENTS } from "../src/data/pillars";
import { CHEST_ONLY_TYPES } from "../src/telescope/poi-containers";

// Only UI/network infrastructure is mocked. The search class, FlexSearch,
// indexing, filtering, translations and inventory projection are real.
vi.mock("../src/flexsearch", () => ({ searchOverlays: () => [] }));
vi.mock("../src/data_sources/overlays", () => ({
  resetBiomeOverlays: () => {},
}));
vi.mock("../src/search/unifiedsearchresults", () => ({
  UnifiedSearchResults: class {},
}));
vi.mock("../src/telescope/poi-spatial-index", () => ({
  loadSpritesheetAndAtlas: vi.fn(),
  FIRST_FRAME_SIZE: {},
}));
vi.mock("../src/auth/auth-service", () => ({
  authService: {
    subscribe: vi.fn(),
    getState: () => ({ authenticated: false, isSubscriber: false }),
  },
}));
vi.mock("../src/auth/auth-ui", () => ({
  AuthUI: { showGetProModal: vi.fn() },
}));
import { UnifiedSearch } from "../src/search/unifiedsearch";

beforeAll(async () => {
  await i18next.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          gameContent: {
            spells: {
              "Spells To Power": "Spells to Power",
              Tuho: "Destruction",
            },
            items: {
              great_chest: "Great Treasure Chest",
              item_chest_treasure_super: "Great Treasure Chest",
              perk_map: "Spatial Awareness",
              perk_moon_radar: "Moon Radar",
              action_destruction: "Destruction",
            },
          },
        },
      },
      fr: {
        translation: {
          gameContent: {
            spells: {
              "Spells To Power": "Sorts en pouvoir",
              Tuho: "Destruction francaise",
            },
            items: {
              great_chest: "Grand coffre au tresor",
              item_chest_treasure_super: "Grand coffre au tresor",
              perk_map: "Conscience spatiale",
              perk_moon_radar: "Radar lunaire",
              action_destruction: "Destruction francaise",
            },
          },
        },
      },
    },
  });
});
afterEach(async () => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await i18next.changeLanguage("en");
});

function searchInventory(poisByPW: Record<string, any[]>) {
  vi.stubGlobal("FlexSearch", {
    Document: (options: any) => new SearchDocument(options),
  });
  const input = document.createElement("input");
  const form = document.createElement("form");
  form.append(input);
  document.body.append(form);
  let results: any[] = [];
  let fallback: unknown;
  const sink = {
    on: vi.fn(),
    setResults: (value: any[]) => {
      results = value;
    },
    setNoResults: (note: unknown) => {
      results = [];
      fallback = note;
    },
  };
  const search = new (UnifiedSearch as any)({
    currentMap: "dynamic-main-branch",
    form,
    searchInput: input,
    searchResults: sink,
  });
  search.setDynamicPOIs(
    getAllPOIsFlat({ poisByPW }).map((p) => ({ ...p, name: p.name ?? p.type })),
  );
  const query = (text: string, filters: string[] = []) => {
    input.value = text;
    search.activeFilters = new Set(filters);
    search.forceRefresh();
    return results;
  };
  return Object.assign(query, {
    // Same public-method sequence as main.ts's triggerPillarSearch hook.
    fromPillar(text: string, filter?: string, rebuild?: () => string) {
      search.setCategoryFilter(filter);
      search.triggerSearchWithFallback(
        text,
        {
          text: "Not found here",
          telescopeUrl:
            "https://lymm37.github.io/noita-telescope/?seed=306813029",
        },
        undefined,
        rebuild,
      );
      return results;
    },
    refreshTranslations() {
      search.refreshTranslations();
      return results;
    },
    getFilters: () => [...search.activeFilters],
    getQuery: () => input.value,
    getFallback: () => fallback,
  });
}

describe("search keeps containers useful and boss rewards individually discoverable", () => {
  it("keeps the meditation pillar search finding the actual cube and its separate chamber", () => {
    const result = normalizeScenePOIs(cubeFixture);
    // The fixture is raw generator output; dynamic-map assigns IDs before
    // handing these records to FlexSearch. Mirror that boundary here.
    const query = searchInventory({ "0,0": result.poisByPW["0,0"].map((poi, i) => ({ ...poi, id:`cube-seed-${i}` })) });
    const link = PILLAR_REQUIREMENTS.secret_meditation.links![0];
    expect(link.structureItem).toBe("meditation_cube");
    const found = query.fromPillar(link.query!);
    expect(found.map((p: any) => p.item).sort()).toEqual(["meditation_chamber", "meditation_cube"]);
    expect(found.find((p: any) => p.item === "meditation_cube")).toMatchObject({ x:-357,y:1626.5 });
    expect(found.find((p: any) => p.item === "meditation_chamber")).toMatchObject({ x:-4352,y:2304 });
  });

  it("returns eight natural chests plus Leviathan's reward exactly once", () => {
    const query = searchInventory(fixture.poisByPW);
    for (const filters of [[], ["c"]]) {
      const found = query("great chest", filters);
      expect(found).toHaveLength(9);
      expect(found.filter((p) => !p.isBossReward)).toHaveLength(8);
      expect(found.filter((p) => p.isBossReward)).toHaveLength(1);
      expect(found.some((p) => p.type === "boss_fish")).toBe(false);
      expect(found.find((p) => p.isBossReward)).toMatchObject({
        item: "great_chest",
        parentType: "boss_fish",
        x: -13967,
        y: 10029,
      });
    }
    const boss = query("Leviathan", ["b"]);
    expect(boss).toHaveLength(1);
    expect(boss[0].items.map((p: any) => p.item)).toEqual([
      "full_heal",
      "great_chest",
    ]);
    expect(query("great chest | Leviathan")).toHaveLength(10);
    expect(query("great chest", ["i"])).toHaveLength(1);
  });

  it("keeps the count independent of the translated chest name", async () => {
    await i18next.changeLanguage("fr");
    expect(searchInventory(fixture.poisByPW)("grand coffre")).toHaveLength(9);
  });

  it("does not count the shop again when its standalone wands match", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "shop",
          type: "holy_mountain_shop",
          name: "Holy Mountain",
          x: 0,
          y: 0,
          items: [
            { id: "wand-a", type: "wand", name: "Test Wand", x: 0, y: 0 },
            { id: "wand-b", type: "wand", name: "Test Wand", x: 0, y: 0 },
          ],
        },
      ],
    });
    expect(query("wand").map((p) => p.id)).toEqual(["wand-a", "wand-b"]);
    expect(query("Holy Mountain")[0].items).toHaveLength(2);
  });

  it.each([...CHEST_ONLY_TYPES])(
    "finds %s by its contents as one container result",
    (type) => {
      const query = searchInventory({
        "0,0": [
          {
            id: "chest",
            type,
            name: "Treasure Chest",
            x: 0,
            y: 0,
            items: [
              {
                id: "loot-a",
                type: "item",
                item: "potion",
                material: "ambrosia",
              },
              {
                id: "loot-b",
                type: "item",
                item: "potion",
                material: "ambrosia",
              },
            ],
          },
        ],
      });
      expect(query("ambrosia").map((p) => p.id)).toEqual(["chest"]);
      expect(query("ambrosia")[0].items).toHaveLength(2);
    },
  );

  it("keeps the already-present Sampo searchable once, separately from Kolmi", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "kolmi",
          type: "boss_centipede",
          name: "Kolmisilma",
          x: 10,
          y: 20,
          items: [
            {
              id: "sampo",
              type: "entity",
              entity: "boss_centipede_sampo",
              name: "Sampo",
              x: 11,
              y: 21,
            },
          ],
        },
      ],
    });
    expect(query("Sampo").map((p) => p.id)).toEqual(["sampo"]);
    expect(query("Kolmisilma")).toHaveLength(1);
  });
});

describe("boss hearts, spell drops and container contents", () => {
  it.each([...BOSS_REWARD_TYPES])(
    "finds %s full-heal drops once without matching their owner",
    (type) => {
      const query = searchInventory({
        "0,0": [
          { id: "loose-heart", type: "item", item: "full_heal", x: 10, y: 20 },
          {
            id: "boss",
            type,
            name: "Reward Owner",
            x: 10,
            y: 20,
            items: [
              { id: "heart-a", type: "item", item: "full_heal", x: 10, y: 20 },
              {
                id: "heart-b",
                type: "item",
                item: "full_heal",
                x: 10,
                y: 20,
                count: 2,
              },
              {
                id: "ignored-heart",
                type: "item",
                item: "full_heal",
                ignore: true,
              },
            ],
          },
        ],
      });
      for (const text of [
        "full heal",
        "full health regeneration",
        "full_heal",
      ]) {
        for (const filters of [[], ["h"]]) {
          const found = query(text, filters);
          expect(found.map((p) => p.id).sort()).toEqual([
            "heart-a",
            "heart-b",
            "loose-heart",
          ]);
          expect(found.filter((p) => p.isBossReward)).toHaveLength(2);
          expect(found.find((p) => p.id === "heart-b").count).toBe(2);
        }
      }
      expect(query("Reward Owner")).toHaveLength(1);
      expect(query("Reward Owner")[0].items).toHaveLength(2);
    },
  );

  it("indexes door-boss spell records by ID and name, retaining distinct copies", async () => {
    const records = {
      "0,0": [
        {
          id: "loose-spell",
          type: "spell",
          item: "SPELLS_TO_POWER",
          x: 10,
          y: 20,
        },
        {
          id: "gate",
          type: "triangle_boss",
          name: "Gate Guardian",
          x: 10,
          y: 20,
          items: [
            {
              id: "drop-a",
              type: "item",
              item: "spell",
              spell: "SPELLS_TO_POWER",
              x: 10,
              y: 20,
            },
            {
              id: "drop-b",
              type: "item",
              item: "spell",
              spell: "spells_to_power",
              x: 10,
              y: 20,
            },
          ],
        },
      ],
    };
    const query = searchInventory(records);
    for (const text of [
      "SPELLS_TO_POWER",
      "Spells To Power",
      "action_spells_to_power",
    ]) {
      for (const filters of [[], ["s"]]) {
        expect(
          query(text, filters)
            .map((p) => p.id)
            .sort(),
        ).toEqual(["drop-a", "drop-b", "loose-spell"]);
      }
    }
    expect(query("Gate Guardian")).toHaveLength(1);
    await i18next.changeLanguage("fr");
    expect(searchInventory(records)("Sorts en pouvoir", ["s"])).toHaveLength(3);
  });

  it("returns the chest once when either spell representation appears in its contents", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "chest",
          type: "chest",
          x: 0,
          y: 0,
          items: [
            { id: "spell-a", type: "spell", item: "SPELLS_TO_POWER" },
            {
              id: "spell-b",
              type: "item",
              item: "spell",
              spell: "SPELLS_TO_POWER",
            },
          ],
        },
      ],
    });
    const found = query("Spells To Power");
    expect(found.map((p) => p.id)).toEqual(["chest"]);
    expect(found[0].items).toHaveLength(2);
  });

  it.each([
    "shop",
    "holy_mountain_shop",
    "eye_room",
    "snowy_room",
    "wand_altar",
  ])(
    "returns %s contents individually without the parent duplicate",
    (type) => {
      const query = searchInventory({
        "0,0": [
          {
            id: "owner",
            type,
            x: 0,
            y: 0,
            items: [
              { id: "a", type: "item", item: "potion", material: "ambrosia" },
              { id: "b", type: "item", item: "potion", material: "ambrosia" },
            ],
          },
        ],
      });
      expect(
        query("ambrosia", ["p"])
          .map((p) => p.id)
          .sort(),
      ).toEqual(["a", "b"]);
    },
  );
});

describe("pillar-card search hook contract", () => {
  it("clears a stale perk filter when a pillar requests a chest search", () => {
    const query = searchInventory(fixture.poisByPW);
    query("great chest", ["pk"]);
    expect(query.fromPillar("Great Treasure Chest", "c")).toHaveLength(9);
    expect(query.getFilters()).toEqual(["c"]);
    // Clicking the same search action again must refresh/open the results.
    expect(query.fromPillar("Great Treasure Chest", "c")).toHaveLength(9);
  });

  it("keeps perk OR searches and their translated-query rebuild working", async () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "moon",
          type: "item",
          item: "perk",
          perk: "moon_radar",
          x: 0,
          y: 0,
        },
        {
          id: "mecha",
          type: "boss_robot",
          name: "Mecha Kolmi",
          x: 100,
          y: 100,
          items: [{ id: "map", type: "item", item: "perk", perk: "map" }],
        },
      ],
    });
    const rebuild = () =>
      i18next.language === "fr"
        ? "Conscience spatiale | Radar lunaire"
        : "Spatial Awareness | Moon Radar";
    expect(
      query
        .fromPillar(rebuild(), "pk", rebuild)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["map", "moon"]);
    await i18next.changeLanguage("fr");
    expect(
      query
        .refreshTranslations()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["map", "moon"]);
    expect(query.getQuery()).toBe(rebuild());
    expect(query.fromPillar("map | moon_radar", "pk")).toHaveLength(2);
  });

  it("finds a boss spell through a pillar's action-key query and keeps fallback notes", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "gate",
          type: "triangle_boss",
          x: 0,
          y: 0,
          items: [
            { id: "spell", type: "item", item: "spell", spell: "DESTRUCTION" },
          ],
        },
      ],
    });
    for (const text of ["Destruction", "action_destruction"]) {
      expect(query.fromPillar(text, "s").map((p) => p.id)).toEqual(["spell"]);
    }
    expect(query.fromPillar("no such pickup", "i")).toEqual([]);
    expect(query.getFallback()).toMatchObject({
      telescopeUrl: "https://lymm37.github.io/noita-telescope/?seed=306813029",
    });
  });

  it("honors the raw mat_* material fallback used by pillar links", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "potion",
          type: "item",
          item: "potion",
          material: "magic_liquid_teleportation",
          x: 0,
          y: 0,
        },
      ],
    });
    expect(
      query.fromPillar("mat_magic_liquid_teleportation").map((p) => p.id),
    ).toEqual(["potion"]);
  });
});
