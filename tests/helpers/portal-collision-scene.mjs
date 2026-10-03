import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { nativePortalGL } from "./native-portal-gl.mjs";
import { GpuParticles } from "../../src/portals/runtime/gpu-particles.mjs";
import { GPU_SHADERS } from "../../src/portals/runtime/gpu-grid-renderer.mjs";
import { MapGpuRenderer } from "../../src/portals/gpu-renderer.mjs";
import {
  decodeAssets,
  makeSimulation,
} from "../../src/portals/runtime/effect-simulation.mjs";
const catalog = JSON.parse(
  readFileSync(
    new URL("../../src/portals/assets/effects.json", import.meta.url),
  ),
);
const binary = readFileSync(
  new URL("../../src/portals/assets/effects.bin", import.meta.url),
);
const resources = decodeAssets(
  catalog,
  binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
);
let gpu, engine;
try {
  gpu = nativePortalGL();
  const gl = gpu.gl,
    texture = gl.createTexture(),
    field = resources.eyeCollision;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8UI,
    field.width,
    field.height,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    field.cells,
  );
  for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, param, gl.NEAREST);
  for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
  const renderer = {
    gl,
    program: gpu.program,
    eyeCollision: { ...field, texture },
    collisionField(sim) {
      return sim.airOnly
        ? null
        : MapGpuRenderer.prototype.collisionField.call(this, sim);
    },
  };
  engine = new GpuParticles(renderer, GPU_SHADERS.quadFragment);
  const entries = new Map(
    ["continuous", "restored", "air"].map((key) => {
      const simulation = makeSimulation(
        {
          effect: "eye_room",
          worldSeed: 1,
          x: 0,
          y: 0,
          retainInvisible: false,
        },
        catalog,
        resources,
      );
      simulation.airOnly = key === "air";
      return [key, { simulation }];
    }),
  );
  engine.configure(entries, true);
  for (let frame = 0; frame < 600; frame++) {
    for (const { simulation } of entries.values()) simulation.step();
    if (frame === 299) {
      // Restore/re-upload real GPU state, including sampled positions, bounce
      // bit and all 31 RNG bits; the continuous simulation is the control.
      engine.pools.get("restored").restore(false);
      engine.pools.delete("restored");
      engine.configure(entries, true);
    }
  }
  const diagnostics = MapGpuRenderer.prototype.diagnostics.call({
    ...renderer,
    particles: engine,
    targets: new Map(),
    canvas: { width: 1, height: 1 },
    assetBytes: field.cells.byteLength,
  });
  const counts = Object.fromEntries(
    [...engine.pools].map(([key, pool]) => [
      key,
      { live: pool.live, visible: pool.visible, capacity: pool.capacity },
    ]),
  );
  engine.configure(entries, false);
  const continuous = entries.get("continuous").simulation,
    restored = entries.get("restored").simulation;
  const trails = (sim) => sim.particles.filter((p) => p.collideWithGrid);
  const summary = (sim) => ({
    particles: sim.particles.length,
    trails: trails(sim).length,
    beyondFloor: trails(sim).filter((p) => p.y >= 92).length,
    maxY: Math.max(...trails(sim).map((p) => p.y)),
    emissionState: sim.emissionRng.state,
    lifetimeState: sim.lifetimeRng.state,
  });
  const replayExact =
    JSON.stringify(continuous.particles) === JSON.stringify(restored.particles);
  const particle = (x, life = 20) => ({
    x,
    y: 83.5,
    prevX: x,
    prevY: 83.5,
    vx: 0,
    vy: 0,
    gx: 0,
    gy: 0,
    friction: 0,
    fadeRate: 0,
    airflowForce: 0,
    airflowScale: 0,
    life,
    maxLife: life,
    alpha: 1,
    age: 0,
    drawLong: true,
    cellType: "fire",
    color: 0x87654321,
    collideWithGrid: true,
    collisionBounce: true,
    collisionX: x,
    collisionY: 83.5,
    collisionRng: 12345,
  });
  const simulation = (particles, effect = "eye_room") => ({
    particles,
    effect,
    x: 0,
    y: 0,
    elapsedFrames: 0,
    frame: 0,
    time: 0,
    advanceParticles() {},
  });
  const short = simulation([{ ...particle(0.5, 1.1), vy: 60 }]);
  const shortEntries = new Map([["short", { simulation: short }]]);
  engine.configure(shortEntries, true);
  for (let i = 0; i < 70; i++) short.advanceParticles();
  engine.configure(shortEntries, false);
  const extendedLifetime = short.particles.map((p) => p.life);

  const compact = simulation(
    [particle(10, 1 / 60), particle(11, 1 / 60)],
    "unreviewed",
  );
  const compactEntries = new Map([["compact", { simulation: compact }]]);
  engine.configure(compactEntries, true);
  compact.particles.push({ ...particle(100), collisionRng: 1234567890 });
  compact.advanceParticles();
  compact.advanceParticles();
  const startBeforeCompaction = engine.pools.get("compact").start;
  for (let i = 0; i < 1025; i++) compact.particles.push(particle(1000 + i));
  compact.advanceParticles();
  engine.configure(compactEntries, false);
  const compaction = {
    startBeforeCompaction,
    count: compact.particles.length,
    first: compact.particles[0],
    last: compact.particles.at(-1),
  };
  const error = gl.getError();
  if (error) throw new Error(`GLES error: 0x${error.toString(16)}`);
  engine.dispose();
  engine = null;
  gl.deleteTexture(texture);
  parentPort.postMessage({
    continuous: summary(continuous),
    air: summary(entries.get("air").simulation),
    replayExact,
    counts,
    diagnostics,
    extendedLifetime,
    compaction,
  });
} catch (error) {
  parentPort.postMessage({ error: error.stack });
} finally {
  engine?.dispose();
  gpu?.dispose();
  parentPort.close();
}
