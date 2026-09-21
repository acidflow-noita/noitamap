import { describe, expect, it } from "vitest";
import catalog from "../src/portals/assets/effects.json";
import native from "./fixtures/portals/native-collision.json";

describe("inspected portal collision policy", () => {
  it("distinguishes non-colliding eye-room parent particles from all nine colliding child trails", () => {
    const emitters = catalog.effects.teleport_hourglass_return.emitters;
    expect(emitters).toHaveLength(11);
    expect(emitters.slice(0, 2).map((e) => e.collideWithGrid)).toEqual([false, false]);
    for (const trail of emitters.slice(2)) {
      expect(trail).toMatchObject({ collideWithGrid: true, drawLong: true, vyMin: 60, vyMax: 60, lifeMin: 10, lifeMax: 20, force: 0.02, gx: 0, gy: 0, attractor: 0, friction: 0 });
    }
    expect(catalog.effects.teleport_liquid_powered.emitters.every((e) => e.collideWithGrid === false)).toBe(true);
  });
  it("records native collision/bounce behavior rather than claiming a lifetime cap fixes it", () => {
    const [air, kill, bounce] = native.results;
    expect(air).toMatchObject({ y: 0.5, vy: 60, life: 20, dead: false, queries: [] });
    expect(kill).toMatchObject({ y: -0.5, dead: true, queries: [[0, 0]] });
    expect(bounce.y).toBe(-0.5);
    expect(bounce.dead).toBe(false);
    expect(bounce.vy).toBeLessThan(0);
    expect(bounce.life).toBeGreaterThanOrEqual(0.5);
    expect(bounce.life).toBeLessThanOrEqual(1.5);
  });
});
