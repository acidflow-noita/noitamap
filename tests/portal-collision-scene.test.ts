import { expect, it } from "vitest";
import { Worker } from "node:worker_threads";

it("collides with the actual eye-room steel and preserves GPU restore/replay state", async () => {
  const result: any = await new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./helpers/portal-collision-scene.mjs", import.meta.url),
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("GPU scene test timed out"));
    }, 60000);
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error(`GPU scene worker exited ${code}`));
    });
    worker.once("message", (result) => {
      clearTimeout(timeout);
      result.error ? reject(new Error(result.error)) : resolve(result);
    });
  });
  expect(result.air.beyondFloor).toBeGreaterThan(0);
  expect(result.air.maxY).toBeGreaterThan(500);
  expect(result.continuous.trails).toBeGreaterThan(0);
  expect(result.continuous.beyondFloor).toBe(0);
  // Native sampled motion can end fractionally inside the first steel row.
  expect(result.continuous.maxY).toBeLessThan(85);
  expect(result.replayExact).toBe(true);
  expect(result.extendedLifetime).toHaveLength(1);
  expect(result.extendedLifetime[0]).toBeGreaterThan(0.2);
  expect(result.compaction).toMatchObject({
    startBeforeCompaction: 2,
    count: 1026,
    first: {
      x: 100,
      collisionX: 100,
      collisionRng: 1234567890,
      color: 0x87654321,
    },
    last: { x: 2024, collisionX: 2024, collisionRng: 12345, color: 0x87654321 },
  });
  expect(result.continuous.emissionState).toBe(result.air.emissionState);
  expect(result.continuous.lifetimeState).toBe(result.air.lifetimeState);
  expect(result.counts.continuous.live).toBeGreaterThan(
    result.continuous.particles,
  );
  expect(result.counts.continuous.capacity).toBeGreaterThan(1024);
  expect(result.diagnostics.particleCountsAreUpperBounds).toBe(true);
  const buffers = Object.values(result.counts).reduce(
    (total: number, pool: any) => total + pool.capacity * 160,
    0,
  );
  expect(result.diagnostics.estimatedGPUBytes).toBe(buffers + 512 * 512 + 4);
}, 65000);
