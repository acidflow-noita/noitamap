// GPU particle physics/geometry, with the original CPU emission/RNG and sprite
// scripts. No per-frame particle readback or CPU quad construction. This is an
// opt-in experimental backend, NOT a claim of fully GPU-authored or bit-exact
// Noita simulation. CPU pool accounting preserves the reference's capacity and
// expiration rules without visiting every live particle every frame.
import { COLLISION_RETENTION_STEPS } from "./particle-collision.mjs";
import { DT } from "./portal-physics.mjs";
import { PARTICLE_SHADERS } from "./gpu-particle-shaders.mjs";
const f = Math.fround;
const DEFAULT_COLOR = 0x44b43cff;

// Count repeated float32 subtractions exactly, jumping only within a fixed
// exponent bin where the rounded decrement is constant. Used for bookkeeping,
// never as a replacement for the GPU's actual lifetime/alpha update.
export function expirationSteps(value, decrement = DT, inclusive = false) {
  value = f(value); decrement = f(decrement);
  if (!(decrement > 0)) return Infinity;
  let steps = 0;
  while (inclusive ? value > 0 : value >= 0) {
    const next = f(value - decrement);
    if (next === value) return Infinity;
    value = next; steps++;
    if (value <= 0) continue;
    const floor = 2 ** Math.floor(Math.log2(value));
    const delta = value - f(value - decrement);
    const jump = Math.max(0, Math.floor((value - floor - decrement) / delta));
    if (jump) { value = f(value - jump * delta); steps += jump; }
  }
  return steps;
}
function flags(p) {
  return (p.drawLong ? 1 : 0) | (p.onGrid !== false ? 2 : 0) |
    (!p.drawLong && p.singleWidth === false && ["gas", "fire"].includes(p.cellType) ? 4 : 0) |
    (p.glow !== false ? 8 : 0) | (p.ultrabright ? 16 : 0) |
    (p.singleWidth === false ? 32 : 0) |
    ((p.cellType === "gas" ? 1 : p.cellType === "fire" ? 2 : p.cellType === "liquid" ? 3 : 0) << 6) |
    ((p.mathEmitter === undefined ? 0 : p.mathEmitter + 1) << 8) | (p.back ? 4096 : 0) | (p.collideWithGrid ? 8192 : 0);
}
function allocate(gl, bytes) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_COPY);
  if (gl.getError() !== gl.NO_ERROR) { gl.deleteBuffer(buffer); throw new Error("GPU particle buffer allocation failed; choose fewer figures or the CPU reference"); }
  return buffer;
}

class ParticlePool {
  constructor(engine, sim) {
    this.engine = engine; this.gl = engine.gl; this.sim = sim;
    this.capacity = this.start = this.end = this.head = 0;
    this.dynamic = []; this.static = null; this.current = 0;
    this.cohorts = []; this.events = new Map(); this.pending = [];
    this.live = 0; this.visible = 0;
    const original = sim.particles;
    this.originalAdvance = sim.advanceParticles;
    const pool = this;
    this.list = {
      get length() { return pool.live; },
      push(p) { this[pool.live++] = p; pool.pending.push(p); return pool.live; },
    };
    this.pendingBase = 0;
    try {
      this.upload(original, true);
    } catch (error) { this.dispose(); throw error; }
    sim.particles = this.list;
    sim.advanceParticles = () => this.advance();
  }
  event(tick, live, visible) {
    if (!Number.isFinite(tick)) return;
    const event = this.events.get(tick) ?? [0, 0];
    event[0] += live; event[1] += visible; this.events.set(tick, event);
  }
  ensure(count) {
    if (this.end + count <= this.capacity) return;
    const gl = this.gl, used = this.end - this.start;
    let capacity = this.capacity || 1024;
    while (capacity < used + count) capacity *= 2;
    const dynamic = [], oldStart = this.start;
    let data;
    try {
      dynamic.push(allocate(gl, capacity * 48));
      dynamic.push(allocate(gl, capacity * 48));
      data = allocate(gl, capacity * 64);
      if (used) {
        for (const [from, to, stride] of [[this.dynamic[this.current], dynamic[0], 48], [this.static, data, 64]]) {
          gl.bindBuffer(gl.COPY_READ_BUFFER, from); gl.bindBuffer(gl.COPY_WRITE_BUFFER, to);
          gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, this.start * stride, 0, used * stride);
        }
      }
    } catch (error) {
      for (const buffer of [...dynamic, data]) if (buffer) gl.deleteBuffer(buffer);
      throw error;
    }
    for (const buffer of [...this.dynamic, this.static]) if (buffer) gl.deleteBuffer(buffer);
    this.dynamic = dynamic; this.static = data; this.current = 0; this.capacity = capacity;
    this.cohorts = this.cohorts.slice(this.head);
    for (const cohort of this.cohorts) cohort.end -= oldStart;
    this.head = 0; this.start = 0; this.end = used;
  }
  upload(particles, importing = false) {
    if (!particles.length) return;
    this.ensure(particles.length);
    const tick = this.sim.elapsedFrames;
    const dynamic = new Float32Array(particles.length * 12), data = new Float32Array(particles.length * 16);
    let lastDeath = tick;
    particles.forEach((p, i) => {
      const birth = tick - (importing ? p.age : 0), color = (p.color ?? DEFAULT_COLOR) >>> 0;
      const rng = p.collisionRng || 1;
      dynamic.set([p.x, p.y, p.vx, p.vy, p.prevX, p.prevY, p.alpha, p.life,
        p.collisionX ?? p.x, p.collisionY ?? p.y, rng & 65535,
        (rng >>> 16) | (p.collisionBounce !== false ? 32768 : 0)], i * 12);
      data.set([p.gx, p.gy, p.friction, p.fadeRate, p.airflowForce, p.airflowScale, p.attractor ?? 0, p.maxLife,
        p.targetX ?? 0, p.targetY ?? 0, color & 65535, color >>> 16,
        flags(p), birth & 65535, birth >>> 16, p.mathEdge ?? -1], i * 16);
      // Native life reset can extend a nearly-expired particle. Keep its slot
      // conservatively; the shader alone decides actual death/visibility.
      const reserve = p.collideWithGrid && this.engine.renderer.collisionField?.(this.sim) ? COLLISION_RETENTION_STEPS : 0;
      const death = tick + expirationSteps(p.life) + reserve;
      const fade = p.fadeRate < 0 ? tick + expirationSteps(p.alpha, -f(p.fadeRate * DT), true) : Infinity;
      lastDeath = Math.max(lastDeath, death);
      this.event(death, -1, 0);
      if (importing) this.live++;
      if (p.alpha > 0) { this.visible++; this.event(Math.min(death, fade), 0, -1); }
      else if (p.fadeRate > 0 && death > tick + 1) { this.event(tick + 1, 0, 1); this.event(death, 0, -1); }
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic[this.current]); gl.bufferSubData(gl.ARRAY_BUFFER, this.end * 48, dynamic);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.static); gl.bufferSubData(gl.ARRAY_BUFFER, this.end * 64, data);
    this.end += particles.length;
    this.cohorts.push({ end: this.end, death: lastDeath });
  }
  advance() {
    const sim = this.sim;
    this.upload(this.pending);
    for (let i = this.pendingBase; i < this.pendingBase + this.pending.length; i++) delete this.list[i];
    this.pending.length = 0;
    const tick = sim.elapsedFrames + 1, event = this.events.get(tick);
    if (event) { this.live += event[0]; this.visible += event[1]; this.events.delete(tick); }
    while (this.head < this.cohorts.length && this.cohorts[this.head].death <= tick)
      this.start = this.cohorts[this.head++].end;
    if (this.start === this.end) { this.start = this.end = this.head = 0; this.cohorts.length = 0; }
    this.engine.update(this, sim.time);
    sim.visibleCount = this.visible;
    sim.elapsedFrames++; sim.frame++; sim.time = f(sim.time + DT);
    this.pendingBase = this.live;
  }
  restore(discard = false) {
    const sim = this.sim, gl = this.gl;
    if (!discard && this.engine.renderer.lost) throw new Error("GPU context lost. Restart to recover the GPU-resident particle state.");
    const particles = [];
    if (!discard && this.end > this.start) {
      const count = this.end - this.start, dynamic = new Float32Array(count * 12), data = new Float32Array(count * 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic[this.current]); gl.getBufferSubData(gl.ARRAY_BUFFER, this.start * 48, dynamic);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.static); gl.getBufferSubData(gl.ARRAY_BUFFER, this.start * 64, data);
      for (let i = 0; i < count; i++) {
        const a = dynamic.subarray(i * 12, i * 12 + 12), b = data.subarray(i * 16, i * 16 + 16);
        if (a[7] < 0) continue;
        const bits = b[12], emitter = (bits >> 8) & 15;
        const p = { x:a[0],y:a[1],vx:a[2],vy:a[3],prevX:a[4],prevY:a[5],alpha:a[6],life:a[7],
          gx:b[0],gy:b[1],friction:b[2],fadeRate:b[3],airflowForce:b[4],airflowScale:b[5],attractor:b[6],maxLife:b[7],
          targetX:b[8],targetY:b[9],color:(b[10] | (b[11] << 16)) >>> 0,
          age:sim.elapsedFrames-(b[13]+b[14]*65536),drawLong:!!(bits&1),onGrid:!!(bits&2),glow:!!(bits&8),ultrabright:!!(bits&16),
          singleWidth:!(bits&32),collideWithGrid:!!(bits&8192),collisionX:a[8],collisionY:a[9],collisionRng:(a[10]|((a[11]&32767)<<16)),collisionBounce:!!(a[11]&32768),
          cellType:((bits>>6)&3)===1?"gas":((bits>>6)&3)===2?"fire":((bits>>6)&3)===3?"liquid":"",back:!!(bits&4096) };
        if (emitter) { p.mathEmitter = emitter - 1; p.mathEdge = b[15]; }
        particles.push(p);
      }
    }
    sim.particles = particles; sim.advanceParticles = this.originalAdvance;
    sim.visibleCount = particles.reduce((n, p) => n + (p.alpha > 0), 0);
    this.dispose();
  }
  dispose() {
    for (const buffer of [...this.dynamic, this.static]) if (buffer) this.gl.deleteBuffer(buffer);
    this.dynamic = []; this.static = null;
  }
}

export class GpuParticles {
  constructor(renderer, fragment) {
    this.renderer = renderer; this.gl = renderer.gl; this.pools = new Map();
    this.updateProgram = renderer.program(PARTICLE_SHADERS.updateVertex, PARTICLE_SHADERS.updateFragment,
      ["simulationTime", "collisionEnabled", "collisionCells", "collisionOrigin", "collisionSize"], ["nextMotion", "nextAppearance", "nextContact"]);
    this.drawProgram = renderer.program(PARTICLE_SHADERS.drawVertex, fragment, ["origin", "overrideColor", "glowPass", "image", "textured"]);
    this.updateVAO = this.gl.createVertexArray(); this.drawVAO = this.gl.createVertexArray();
    this.feedback = this.gl.createTransformFeedback();
    const gl = this.gl;
    this.emptyCollisionTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.emptyCollisionTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  configure(entries, enabled) {
    for (const [key, pool] of this.pools) {
      const retained = entries.get(key)?.simulation === pool.sim;
      if (!retained || !enabled) { pool.restore(!retained); this.pools.delete(key); }
    }
    if (enabled) for (const [key, entry] of entries) if (!this.pools.has(key)) {
      const pool = new ParticlePool(this, entry.simulation);
      pool.pendingBase = pool.live;
      this.pools.set(key, pool);
    }
  }
  inputs(pool, instanced) {
    const gl = this.gl;
    gl.bindVertexArray(instanced ? this.drawVAO : this.updateVAO);
    for (const [buffer, first, count, stride] of [[pool.dynamic[pool.current], 0, 2, 48], [pool.static, 2, 4, 64]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (let i = 0; i < count; i++) {
        gl.enableVertexAttribArray(first + i);
        gl.vertexAttribPointer(first + i, 4, gl.FLOAT, false, stride, pool.start * stride + i * 16);
        gl.vertexAttribDivisor(first + i, instanced ? 1 : 0);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, pool.dynamic[pool.current]);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 48, pool.start * 48 + 32);
    gl.vertexAttribDivisor(6, instanced ? 1 : 0);
  }
  update(pool, time) {
    const count = pool.end - pool.start;
    if (!count) return;
    const gl = this.gl;
    this.inputs(pool, false);
    gl.useProgram(this.updateProgram.program); gl.uniform1f(this.updateProgram.uniforms.simulationTime, time);
    // Only the reviewed eye-room material field is enabled. Unknown/outside
    // cells never become invented walls for other portal placements.
    const collision = this.renderer.collisionField?.(pool.sim);
    const uniforms = this.updateProgram.uniforms;
    gl.uniform1i(uniforms.collisionEnabled, collision ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0 + 7);
    gl.bindTexture(gl.TEXTURE_2D, collision?.texture ?? this.emptyCollisionTexture);
    gl.uniform1i(uniforms.collisionCells, 7);
    gl.uniform2f(uniforms.collisionOrigin, collision?.x ?? 0, collision?.y ?? 0);
    gl.uniform2i(uniforms.collisionSize, collision?.width ?? 1, collision?.height ?? 1);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, pool.dynamic[1 - pool.current], pool.start * 48, count * 48);
    gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, count); gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    pool.current = 1 - pool.current;
  }
  draw(sim, key, options, glow) {
    const pool = this.pools.get(key), count = pool.end - pool.start;
    if (!count) return;
    const gl = this.gl, p = this.drawProgram;
    this.inputs(pool, true); gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.origin, 240 - sim.x, 160 - sim.y);
    const color = options.color;
    gl.uniform4f(p.uniforms.overrideColor, ((color >>> 16) & 255) / 255, ((color >>> 8) & 255) / 255, (color & 255) / 255, color == null ? 0 : 1);
    gl.uniform1i(p.uniforms.glowPass, Number(glow)); gl.uniform1i(p.uniforms.textured, Number(glow));
    this.renderer.sample(p, "image", glow ? this.renderer.textures.get(this.renderer.sceneBuilder.glowTexture) : this.renderer.white, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, glow ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count); gl.disable(gl.BLEND);
  }
  dispose() {
    this.configure(new Map(), false);
    this.gl.deleteTexture(this.emptyCollisionTexture);
    this.gl.deleteVertexArray(this.updateVAO); this.gl.deleteVertexArray(this.drawVAO); this.gl.deleteTransformFeedback(this.feedback);
  }
}
