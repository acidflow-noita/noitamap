import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../src/portals/assets/effects.json";
import native from "./fixtures/portals/native-collision-matrix.json";
import { DT, stepParticle } from "../src/portals/runtime/portal-physics.mjs";
import {
  decodeAssets,
  makeSimulation,
} from "../src/portals/runtime/effect-simulation.mjs";
import {
  blocksParticle,
  collisionFieldFor,
} from "../src/portals/runtime/particle-collision.mjs";

const binary = readFileSync(
  new URL("../src/portals/assets/effects.bin", import.meta.url),
);
const resources = decodeAssets(
  catalog,
  binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
);
const baseParticle = {
  x: 0.5,
  y: -0.5,
  prevX: 0.5,
  prevY: -0.5,
  vx: 0,
  vy: 60,
  life: 20,
  maxLife: 20,
  alpha: 1,
  age: 0,
  gx: 0,
  gy: 0,
  friction: 0,
  fadeRate: 0,
  airflowForce: 0,
  airflowScale: 0,
  collideWithGrid: true,
  collisionBounce: true,
  collisionRng: 12345,
};

describe("CPU collision reference and material scene", () => {
  it.each(native.results)(
    "matches native movement: $name",
    ({ input: c, frames }) => {
      const width = 256,
        height = 256,
        left = Math.trunc(c.x) - 128,
        top = Math.trunc(c.y) - 128;
      const cells = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const coordinate = c.axis === "x" ? x + left : y + top;
          if (c.positive ? coordinate >= c.boundary : coordinate <= c.boundary)
            cells[y * width + x] = c.kind;
        }
      const field = { cells, width, height, x: -left, y: -top };
      const input = c as typeof c & {
        collisionX?: number;
        collisionY?: number;
      };
      const p = {
        ...baseParticle,
        ...c,
        collisionRng: c.rng,
        collideWithGrid: c.collide,
        collisionBounce: c.bounce,
        cellType: c.particleKind === 1 ? "liquid" : "fire",
        collisionX: input.collisionX ?? c.x,
        collisionY: input.collisionY ?? c.y,
      };
      frames.forEach((expected, i) => {
        stepParticle(p, i / 60, DT, field);
        for (const key of [
          "x",
          "y",
          "vx",
          "vy",
          "collisionX",
          "collisionY",
        ] as const)
          expect(p[key], `${i}.${key}`).toBeCloseTo(expected[key], 4);
        expect(p.collisionRng).toBe(expected.rng);
        expect(p.collisionBounce).toBe(expected.bounce);
        if (expected.dead) expect(p.life).toBeLessThan(0);
        else expect(p.life).toBeCloseTo(expected.life, 4);
      });
    },
  );

  it("decodes the hashed material program, not the eye artwork", () => {
    const field = resources.eyeCollision;
    expect(field).toMatchObject({ width: 512, height: 512, x: 256, y: 255 });
    expect(createHash("sha256").update(field.cells).digest("hex")).toBe(
      catalog.eyeCollision.sha256,
    );
    expect(blocksParticle(field, 0.5, 83.5)).toBe(false);
    for (let y = 84; y < 92; y++)
      expect(blocksParticle(field, 0.5, y)).toBe(true);
    expect(blocksParticle(field, 0.5, 92)).toBe(false); // unknown base biome, not an invented wall
    expect(blocksParticle(field, -10000, 0)).toBe(false);
    expect(blocksParticle(field, 10000, 0)).toBe(false);
  });

  it.each([-35000, 0, 35000])(
    "anchors the actual floor to portal world position %i",
    (x) => {
      const field = collisionFieldFor(
        { effect: "eye_room", x, y: 2048 },
        resources.eyeCollision,
      );
      const p = {
        ...baseParticle,
        x: x + 0.5,
        y: 2048 + 83.5,
        collisionX: x + 0.5,
        collisionY: 2048 + 83.5,
      };
      stepParticle(p, 0, DT, field);
      expect(p.y).toBe(2048 + 83.5);
      expect(p.vy).toBeLessThan(0);
      const parent = { ...p, vy: 60, life: 20, collideWithGrid: false };
      stepParticle(parent, 0, DT, field);
      expect(parent.y).toBe(2048 + 84.5);
      expect(parent.life).toBe(Math.fround(20 - DT));
    },
  );

  it("enables only reviewed eye-room placements, in both simulation implementations", () => {
    for (const effect of [
      "eye_room",
      "teleport_hourglass_return",
      "holy_mountain",
      "teleport_liquid_powered",
    ]) {
      const sim = makeSimulation(
        { effect, worldSeed: 1, x: 0, y: 0 },
        catalog,
        resources,
      );
      expect(!!sim.collisionField).toBe(
        effect === "eye_room" || effect === "teleport_hourglass_return",
      );
    }
  });

  it("rejects truncated or malformed collision fields", () => {
    for (const patch of [
      { offset: -1 },
      { length: 1 },
      { width: 0 },
      { width: NaN },
      { offset: Infinity },
    ]) {
      expect(() =>
        decodeAssets(
          { ...catalog, eyeCollision: { ...catalog.eyeCollision, ...patch } },
          binary.buffer.slice(
            binary.byteOffset,
            binary.byteOffset + binary.byteLength,
          ),
        ),
      ).toThrow();
    }
  });
});

it("keeps shadow replay independent of per-particle collision randomness", async () => {
  const { cloneSimulation, makeShadow, replayStepsFor } =
    await import("../src/portals/worker-runtime");
  const fresh = () =>
    makeSimulation(
      { effect: "eye_room", worldSeed: 1, x: 0, y: 0, retainInvisible: false },
      catalog,
      resources,
    );
  const continuous = fresh(),
    shadow = makeShadow(fresh());
  const window = replayStepsFor("eye_room"),
    end = window + 200;
  for (let i = 0; i < end; i++) continuous.step();
  for (let i = 0; i < end - window; i++) shadow.step();
  const replay = cloneSimulation(shadow);
  for (let i = 0; i < window; i++) replay.step();
  expect(replay.particles).toEqual(continuous.particles);
  expect(replay.emissionRng.state).toBe(continuous.emissionRng!.state);
  expect(replay.lifetimeRng.state).toBe(continuous.lifetimeRng!.state);
  expect(replay.time).toBe(continuous.time);
}, 15000);
