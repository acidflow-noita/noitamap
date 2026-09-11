// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { Document as SearchDocument } from "flexsearch";
import i18next from "../src/i18n";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import fixture from "./fixtures/search/306813029-great-chests.json";

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
            items: {
              great_chest: "Great Treasure Chest",
              item_chest_treasure_super: "Great Treasure Chest",
            },
          },
        },
      },
      fr: {
        translation: {
          gameContent: {
            items: {
              great_chest: "Grand coffre au tresor",
              item_chest_treasure_super: "Grand coffre au tresor",
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
  const sink = {
    on: vi.fn(),
    setResults: (value: any[]) => {
      results = value;
    },
    setNoResults: () => {
      results = [];
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
  return (text: string, filters: string[] = []) => {
    input.value = text;
    search.activeFilters = new Set(filters);
    search.forceRefresh();
    return results;
  };
}

describe("search counts world objects, not duplicated container/reward matches", () => {
  it("returns exactly the eight natural great chests for seed 306813029", () => {
    const query = searchInventory(fixture.poisByPW);
    for (const filters of [[], ["c"]]) {
      const found = query("great chest", filters);
      expect(found).toHaveLength(8);
      expect(found.every((p) => p.type === "great_chest")).toBe(true);
    }
    const boss = query("Leviathan", ["b"]);
    expect(boss).toHaveLength(1);
    expect(boss[0].items.map((p: any) => p.item)).toEqual([
      "full_heal",
      "great_chest",
    ]);
    expect(query("great chest | Leviathan")).toHaveLength(9);
    expect(query("great chest", ["i"])).toEqual([]);
  });

  it("keeps the count independent of the translated chest name", async () => {
    await i18next.changeLanguage("fr");
    expect(searchInventory(fixture.poisByPW)("grand coffre")).toHaveLength(8);
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

  it("still searches inside an unexpanded chest without duplicating its loot", () => {
    const query = searchInventory({
      "0,0": [
        {
          id: "chest",
          type: "chest",
          name: "Treasure Chest",
          x: 0,
          y: 0,
          items: [
            { id: "loot", type: "item", item: "potion", material: "ambrosia" },
          ],
        },
      ],
    });
    expect(query("ambrosia").map((p) => p.id)).toEqual(["chest"]);
  });

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
