// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { telescopeSearchUrl } from "../src/search/telescope-link";
import i18next from "../src/i18n";

vi.mock("../src/flexsearch", () => ({ searchOverlays: () => [] }));
vi.mock("../src/data_sources/overlays", () => ({
  resetBiomeOverlays: () => {},
}));
vi.mock("../src/telescope/telescope-osd-bridge", () => ({
  getPOISpriteFirstFrame: vi.fn(),
  getTaikasauvaIcon: vi.fn(),
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
vi.mock("../src/spoiler-free", () => ({ isSpoilerFree: () => false }));
import { UnifiedSearch } from "../src/search/unifiedsearch";
import { UnifiedSearchResults } from "../src/search/unifiedsearchresults";

beforeAll(async () => {
  await i18next.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          search: {
            noResults: "Nothing found",
            searchTelescope: "Search in Telescope",
          },
        },
      },
    },
  });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Telescope search links", () => {
  it("passes only the resolved seed and query, with no camera or unrelated URL state", () => {
    history.replaceState(
      null,
      "",
      "/?m=dy&se=999&x=20&y=-30&z=1731&u=abc&ds=1",
    );
    const url = new URL(telescopeSearchUrl(" chainsaw + 氷 & water ", 12333)!);
    expect(url.origin).toBe("https://lymm37.github.io");
    expect([...url.searchParams]).toEqual([
      ["seed", "12333"],
      ["q", "chainsaw + 氷 & water"],
    ]);
    expect(telescopeSearchUrl("heart", 0)).toContain("seed=0");
  });
  it.each([null, -1, 2147483648, NaN, Infinity, 1.5])(
    "does not link an unavailable/unsupported seed %s",
    (seed) => {
      expect(telescopeSearchUrl("chainsaw", seed)).toBeUndefined();
    },
  );
  it("does not open a search for whitespace", () => {
    expect(telescopeSearchUrl("  ", 42)).toBeUndefined();
  });

  function fixture() {
    const form = document.createElement("form"),
      input = document.createElement("input"),
      list = document.createElement("ul");
    form.append(input);
    document.body.append(form, list);
    const sink = new UnifiedSearchResults(list);
    const link = vi.fn((query: string) => telescopeSearchUrl(query, 12333));
    const search = new (UnifiedSearch as any)({
      currentMap: "dynamic-main-branch",
      form,
      searchInput: input,
      searchResults: sink,
      getTelescopeSearchUrl: link,
    });
    return { search, input, list, link };
  }
  it("offers a handoff only for an empty result after the seed index is ready", () => {
    const f = fixture();
    f.search.triggerSearch("chainsaw");
    expect(f.list.querySelector("a")).toBeNull();
    f.search.setIndexingState("indexing");
    expect(f.list.querySelector("a")).toBeNull();
    f.search.setIndexingState("ready");
    expect(f.list.textContent).toContain("Search in Telescope");
    expect(new URL(f.list.querySelector("a")!.href).searchParams.get("q")).toBe(
      "chainsaw",
    );
    expect(f.list.querySelector("a")!.rel).toBe("noopener noreferrer");
    expect(f.list.lastElementChild?.querySelector("a")).toBe(
      f.list.querySelector("a"),
    );
    f.search.triggerSearch("");
    expect(f.list.querySelector("a")).toBeNull();
  });
  it("does not add the handoff when the query has a matching map item", () => {
    const f = fixture();
    f.search.indexingState = "ready";
    f.search.dynamicPOIs = [
      {
        id: "heart-1",
        type: "item",
        item: "heart",
        name: "heart",
        worldX: 0,
        worldY: 0,
      },
    ];
    f.search.searchResults = { setResults: vi.fn(), setNoResults: vi.fn() };
    f.search.triggerSearch("heart");
    expect(f.search.searchResults.setResults).toHaveBeenCalledOnce();
    expect(f.search.searchResults.setNoResults).not.toHaveBeenCalled();
    expect(f.link).not.toHaveBeenCalled();
  });
  it("refreshes the seed on activation and cancels a stale query link", () => {
    const f = fixture();
    f.search.setIndexingState("ready");
    f.search.triggerSearch("chainsaw");
    const anchor = f.list.querySelector("a")!;
    f.link.mockImplementation((query) => telescopeSearchUrl(query, 456));
    anchor.dispatchEvent(new Event("contextmenu"));
    expect(new URL(anchor.href).searchParams.get("seed")).toBe("456");
    f.input.value = "new query";
    const click = new MouseEvent("click", { cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(anchor.hasAttribute("href")).toBe(false);
  });
  it("keeps a pillar explanation while handing off its actual query", () => {
    const f = fixture();
    f.search.setIndexingState("ready");
    f.search.triggerSearchWithFallback("chainsaw", {
      text: "Existing pillar explanation",
      telescopeUrl: "https://lymm37.github.io/noita-telescope/?seed=1",
    });
    expect(f.list.textContent).toContain("Existing pillar explanation");
    expect(new URL(f.list.querySelector("a")!.href).searchParams.get("q")).toBe(
      "chainsaw",
    );
  });
  it("does not offer the dynamic handoff for static map searches", () => {
    const f = fixture();
    f.search.currentMap = "regular-main-branch";
    f.search.setIndexingState("ready");
    f.search.triggerSearch("no such item");
    expect(f.list.querySelector("a")).toBeNull();
    expect(f.link).not.toHaveBeenCalled();
  });
});
