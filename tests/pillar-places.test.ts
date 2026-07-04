/**
 * PILLAR_PLACES must cover EVERY fixed-coordinate pillar link (with or without
 * a wiki page), so each goto destination gets a clickable map hit-area and a
 * searchable name. Regression: places without wiki (The Tower, Moon, ...) were
 * silently dropped, leaving no way to reopen their card after closing it.
 */
import { describe, it, expect } from "vitest";
import { PILLAR_PLACES, PILLAR_FLAGS, pillarPlaceAssociation, pillarFlagName } from "../src/data/pillars";

describe("pillar places", () => {
  it("includes every fixed-coordinate link, with or without wiki", () => {
    const labels = new Set(PILLAR_PLACES.map((p) => p.label));
    for (const expected of [
      "Mountain Altar",
      "Nullifying Altar",
      "The Tower",
      "Avarice Diamond",
      "Moon",
      "Dark Moon",
      "Greed Curse Pedestal",
      "End of Everything",
      "Gourd Cave",
      "Meditation Cube",
      "Buried Eye",
      "Hourglass",
    ]) {
      expect(labels, `missing place: ${expected}`).toContain(expected);
    }
  });

  it("every place carries a wiki page", () => {
    for (const p of PILLAR_PLACES) {
      expect(p.wiki, `place without wiki: ${p.label}`).toMatch(/^https:\/\/noita\.wiki\.gg\//);
    }
  });

  it("deduplicates by rounded coords", () => {
    const keys = PILLAR_PLACES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("associates a synthesized pillar_place POI back to its pillar", () => {
    const tower = PILLAR_PLACES.find((p) => p.label === "The Tower")!;
    expect(tower).toBeDefined();
    const assoc = pillarPlaceAssociation({ type: "pillar_place", x: tower.x, y: tower.y });
    expect(assoc).not.toBeNull();
    expect(assoc!.flag).toBe("secret_tower");
  });
});

describe("pillar segment titles", () => {
  it("resolves proper names instead of prettified flags", () => {
    expect(pillarFlagName("secret_dmoon")).toBe("Blood Moon");
    expect(pillarFlagName("special_mood")).toBe("Gourd Moon");
    expect(pillarFlagName("dead_mood")).toBe("Dark Gourd Moon");
    expect(pillarFlagName("essence_laser")).toBe("Essence of Earth");
    expect(pillarFlagName("progress_newgameplusplus3")).toBe("New Game+++");
    expect(pillarFlagName("miniboss_dragon")).toBe("Suomuhauki");
    expect(pillarFlagName("card_unlocked_divide")).toBe("Avarice");
  });

  it("covers every achievement flag with a curated title", () => {
    for (const pillar of PILLAR_FLAGS) {
      for (const [flag] of pillar) {
        // The naive fallback produces "Prefix: Rest" — no curated title contains ": ".
        expect(pillarFlagName(flag), `uncurated title for flag: ${flag}`).not.toContain(": ");
      }
    }
  });
});

