import { describe, expect, it } from "vitest";
import { buildPillarSegments, isAchievementPillarSegment, PILLAR_BASE } from "../src/data/pillars";

describe("pillar search", () => {
  it("includes engraved segments while excluding structural pieces", () => {
    const segments = buildPillarSegments(PILLAR_BASE.x, PILLAR_BASE.y, () => true);
    const searchable = segments.filter(isAchievementPillarSegment);

    expect(searchable.length).toBeGreaterThan(0);
    expect(searchable.every((segment) => segment.item === "pillar_segment")).toBe(true);
    expect(searchable.every((segment) => !segment.flag.startsWith("__struct"))).toBe(true);
    expect(searchable.length).toBeLessThan(segments.length);
  });

  it("does not classify regular items as achievement pillar segments", () => {
    expect(isAchievementPillarSegment({ type: "item", item: "emerald_tablet" })).toBe(false);
  });
});
