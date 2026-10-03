import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { nativePortalGL } from "./native-portal-gl.mjs";
import { GpuParticles } from "../../src/portals/runtime/gpu-particles.mjs";
import { GPU_SHADERS } from "../../src/portals/runtime/gpu-grid-renderer.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/portals/native-collision-matrix.json",
      import.meta.url,
    ),
  ),
);
let gpu, engine;
try {
  gpu = nativePortalGL();
  const gl = gpu.gl,
    texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, param, gl.NEAREST);
  for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
  let field;
  const renderer = { gl, program: gpu.program, collisionField: () => field };
  engine = new GpuParticles(renderer, GPU_SHADERS.quadFragment);
  const outcomes = [];
  for (const { name, input: c, frames } of fixture.results) {
    const width = 256,
      height = 256;
    const left = Math.trunc(c.x) - 128,
      top = Math.trunc(c.y) - 128;
    const cells = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const coordinate = c.axis === "x" ? x + left : y + top;
        if (c.positive ? coordinate >= c.boundary : coordinate <= c.boundary)
          cells[y * width + x] = c.kind;
      }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      width,
      height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      cells,
    );
    field = { texture, width, height, x: -left, y: -top };
    const particle = {
      ...c,
      prevX: c.x,
      prevY: c.y,
      maxLife: c.life,
      alpha: 1,
      age: 0,
      gx: 0,
      gy: 0,
      friction: 0,
      fadeRate: 0,
      airflowForce: 0,
      airflowScale: 0,
      drawLong: true,
      cellType: c.particleKind === 1 ? "liquid" : "fire",
      collideWithGrid: c.collide,
      collisionBounce: c.bounce,
      collisionX: c.collisionX ?? c.x,
      collisionY: c.collisionY ?? c.y,
      collisionRng: c.rng,
    };
    const sim = {
      particles: [particle],
      elapsedFrames: 0,
      time: 0,
      advanceParticles() {},
    };
    engine.configure(new Map([["test", { simulation: sim }]]), true);
    const pool = engine.pools.get("test"),
      actual = [];
    for (let i = 0; i < frames.length; i++) {
      engine.update(pool, i / 60);
      const values = new Float32Array(12);
      gl.bindBuffer(gl.ARRAY_BUFFER, pool.dynamic[pool.current]);
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, values);
      actual.push({
        x: values[0],
        y: values[1],
        vx: values[2],
        vy: values[3],
        life: values[7],
        collisionX: values[8],
        collisionY: values[9],
        rng: values[10] | ((values[11] & 32767) << 16),
        bounce: !!(values[11] & 32768),
      });
    }
    outcomes.push({ name, frames: actual });
  }
  const error = gl.getError();
  if (error) throw new Error(`GLES error: 0x${error.toString(16)}`);
  engine.dispose();
  engine = null;
  gl.deleteTexture(texture);
  parentPort.postMessage({ outcomes, renderer: gpu.renderer });
} catch (error) {
  parentPort.postMessage({ error: error.stack });
} finally {
  engine?.dispose();
  gpu?.dispose();
  parentPort.close();
}
