// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Document as SearchDocument } from "flexsearch";
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
import i18next from "../src/i18n";
function fixture() {
  vi.stubGlobal("MessageChannel", undefined);
  const indexes: any[] = [];
  vi.stubGlobal("FlexSearch", {
    Document: (options: any) => {
      const index = new SearchDocument(options);
      indexes.push(index);
      vi.spyOn(index, "add");
      return index;
    },
  });
  const input = document.createElement("input"),
    form = document.createElement("form");
  form.append(input);
  document.body.append(form);
  const sink = {
    on: vi.fn(),
    setResults: vi.fn(),
    setNoResults: vi.fn(),
    setIndexingPlaceholder: vi.fn(),
  };
  const search = new (UnifiedSearch as any)({
    currentMap: "dynamic-main-branch",
    form,
    searchInput: input,
    searchResults: sink,
  });
  return { search, sink, input, indexes };
}
const records = (count: number, prefix = "test") =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: "Test wand",
    type: "wand",
    cards: ["LIGHT_BULLET", "BOMB", "BURST_2"],
    always_casts: ["LIGHT"],
    x: i,
    y: i,
    worldX: i,
    worldY: i,
    pw: 0,
  }));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeAll(async () => {
  await i18next.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: {} } },
  });
});
describe("scheduled dynamic search indexing", () => {
  it("yields before large builds and between bounded batches, publishing a complete index atomically", () => {
    vi.useFakeTimers();
    const { search, sink, indexes } = fixture(),
      pois = records(5000);
    search.setDynamicPOIs(pois);
    expect(indexes[0].add).not.toHaveBeenCalled();
    expect(search.getIndexingState()).toBe("indexing");
    search.setIndexingState("ready");
    expect(search.getIndexingState()).toBe("indexing");
    expect(search.dynamicPOIMap.size).toBe(0);
    let responsive = false;
    setTimeout(() => {
      responsive = true;
      expect(search.getIndexingState()).toBe("indexing");
      expect(search.dynamicPOIMap.size).toBe(0);
    }, 0);
    vi.advanceTimersToNextTimer();
    expect(responsive).toBe(true);
    expect(indexes[0].add.mock.calls.length).toBeLessThanOrEqual(128);
    vi.runAllTimers();
    expect(search.getIndexingState()).toBe("ready");
    expect(search.dynamicPOIMap.size).toBe(5011);
    search.triggerSearch("Test wand");
    expect(sink.setResults.mock.lastCall![0].length).toBe(50);
    expect(
      sink.setResults.mock.lastCall![0].every((p: any) =>
        p.id.startsWith("test-"),
      ),
    ).toBe(true);
  });
  it("cancels an older partially built seed without publishing its index after replacement", () => {
    vi.useFakeTimers();
    const { search, indexes } = fixture();
    search.setDynamicPOIs(records(2000, "old"));
    vi.advanceTimersToNextTimer();
    expect(indexes[0].add.mock.calls.length).toBeGreaterThan(0);
    const oldCount = indexes[0].add.mock.calls.length;
    search.setDynamicPOIs(records(12, "replacement"));
    vi.runAllTimers();
    expect(indexes[0].add).toHaveBeenCalledTimes(oldCount);
    expect(search.dynamicPOIMap.has("replacement-11")).toBe(true);
    expect(search.dynamicPOIMap.has("old-0")).toBe(false);
    expect(search.getIndexingState()).toBe("ready");
  });
  it("cancels pending work when the map clears and keeps small inventories immediately searchable", () => {
    vi.useFakeTimers();
    const { search, sink } = fixture();
    search.setDynamicPOIs(records(2000));
    search.setDynamicPOIs([]);
    vi.runAllTimers();
    expect(search.dynamicPOIMap.size).toBe(0);
    expect(search.dynamicPOIs).toEqual([]);
    search.setDynamicPOIs(records(3));
    expect(search.dynamicPOIMap.size).toBe(14);
    search.triggerSearch("Test wand");
    expect(sink.setResults.mock.lastCall![0]).toHaveLength(3);
  });
  it("closes message-task scheduling when the active seed is replaced", () => {
    const { search, indexes } = fixture(),
      tasks: Array<() => void> = [],
      closed = vi.fn();
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = { onmessage: null as null | (() => void), close: closed };
        port2 = {
          postMessage: () => tasks.push(() => this.port1.onmessage?.()),
          close: closed,
        };
      },
    );
    search.setDynamicPOIs(records(1000));
    expect(tasks).toHaveLength(1);
    tasks.shift()!();
    const count = indexes[0].add.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    search.setDynamicPOIs([]);
    expect(closed).toHaveBeenCalledTimes(2);
    for (const task of tasks) task();
    expect(indexes[0].add).toHaveBeenCalledTimes(count);
    expect(search.dynamicPOIMap.size).toBe(0);
  });
});
