import { beforeAll, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import native from "./fixtures/portals/native-collision-matrix.json";

type State = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  collisionX: number;
  collisionY: number;
  rng: number;
  bounce: boolean;
};
let outcomes: { name: string; frames: State[] }[];
beforeAll(async () => {
  outcomes = await new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./helpers/portal-collision-gpu.mjs", import.meta.url),
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("GPU collision test timed out"));
    }, 30000);
    const finish = () => clearTimeout(timeout);
    worker.once("error", (error) => {
      finish();
      reject(error);
    });
    worker.once("exit", (code) => {
      finish();
      if (code) reject(new Error(`GPU worker exited ${code}`));
    });
    worker.once("message", (result) => {
      finish();
      result.error ? reject(new Error(result.error)) : resolve(result.outcomes);
    });
  });
}, 40000);

describe("actual portal transform-feedback shader versus native movement", () => {
  it.each(native.results)("$name", (reference) => {
    const actual = outcomes.find(
      (result) => result.name === reference.name,
    )!.frames;
    expect(actual).toHaveLength(reference.frames.length);
    reference.frames.forEach((frame, i) => {
      const got = actual[i];
      for (const field of [
        "x",
        "y",
        "vx",
        "vy",
        "collisionX",
        "collisionY",
      ] as const)
        expect(
          got[field],
          `${reference.name} frame ${i}: ${field}`,
        ).toBeCloseTo(frame[field], 4);
      expect(got.rng, `${reference.name} frame ${i}: RNG`).toBe(frame.rng);
      expect(got.bounce, `${reference.name} frame ${i}: bounce`).toBe(
        frame.bounce,
      );
      if (frame.dead) expect(got.life).toBeLessThan(0);
      else
        expect(got.life, `${reference.name} frame ${i}: life`).toBeCloseTo(
          frame.life,
          4,
        );
    });
  });
});
