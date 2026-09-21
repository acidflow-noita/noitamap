import { collisionFieldFor } from "./particle-collision.mjs";
import {
  PortalSimulation,
  EFFECTS,
  DT,
  PORTAL_EMITTERS,
} from "./portal-physics.mjs";
import { stepSprite } from "./sprite-physics.mjs";
import { MATH_EFFECTS, figureSegments } from "./math-figures.mjs";
import { FigureTracers } from "./math-tracers.mjs";
import { MATH_TRAIL_SCALE, validateMathTrailScale } from "./math-settings.mjs";
const f = Math.fround;
export function decodeAssets(catalog, buffer) {
  const assets = {},
    images = {};
  for (const [key, a] of Object.entries(catalog.assets)) {
    if (
      a.offset < 0 ||
      a.length !== a.width * a.height * 4 ||
      a.offset + a.length > buffer.byteLength
    )
      throw new Error(`Invalid asset ${key}`);
    assets[key] = { ...a, rgba: new Uint8Array(buffer, a.offset, a.length) };
  }
  for (const [key, a] of Object.entries(catalog.imageAnimations)) {
    if (
      a.offset < 0 ||
      a.count < 0 ||
      a.offset + a.count * 6 > buffer.byteLength
    )
      throw new Error(`Invalid animation ${key}`);
    const view = new DataView(buffer, a.offset, a.count * 6),
      points = [];
    for (let i = 0; i < a.count; i++)
      points.push({
        x: view.getInt16(i * 6, true) / 2,
        y: view.getInt16(i * 6 + 2, true) / 2,
        probability: view.getUint8(i * 6 + 4),
        time: view.getUint8(i * 6 + 5),
      });
    images[key] = { ...a, points };
  }
  const field = catalog.eyeCollision;
  let eyeCollision = null;
  if (field) {
    if (![field.offset, field.length, field.width, field.height, field.x, field.y].every(Number.isSafeInteger) ||
        field.offset < 0 || field.width <= 0 || field.height <= 0 ||
        field.length !== field.width * field.height || field.offset + field.length > buffer.byteLength)
      throw new Error("Invalid eye-room collision material field");
    eyeCollision = { ...field, cells: new Uint8Array(buffer, field.offset, field.length) };
  }
  return { assets, images, eyeCollision };
}
function integer(rng, min, max) {
  if (min === max) return min;
  if (min > max) [min, max] = [max, min];
  return min + (rng.next() % (max - min + 1));
}
function sortedRange(rng, a, b) {
  return a <= b ? rng.range(a, b) : rng.range(b, a);
}
// 0x00bc984f..0x00bc99f0, checked by executing the native instruction range.
export function imageWindow(cursor, speed, loop, maxTime, points) {
  if (cursor < 0) return { cursor, start: -1, count: 0 };
  const low = Math.trunc(cursor),
    next = f(cursor + speed),
    high = Math.trunc(next);
  let start = -1,
    end = 0;
  for (let i = 0; i < points.length; i++) {
    const time = points[i].time;
    if (start < 0 && time >= low) start = i;
    if (time > high) break;
    if (start >= 0) end = i + 1;
  }
  return {
    cursor: high > maxTime ? (loop ? 0 : -1) : next,
    start,
    count: start < 0 ? 0 : Math.max(0, end - start),
  };
}
export class SourceSimulation extends PortalSimulation {
  constructor(options, definition, resources, catalog) {
    super({ ...options, effect: "holy_mountain" });
    this.effect = options.effect;
    this.definition = definition;
    this.resources = resources;
    this.catalog = catalog;
    this.emitters = definition.emitters.map((c) => ({
      config: c,
      next:
        Math.max(0, c.delay) +
        integer(this.emissionRng, c.intervalMin, c.intervalMax) -
        1,
      cursor: f((resources.images[c.image]?.maxTime ?? 0) * c.imagePhase || 0),
    }));
    this.spriteEmitters = definition.spriteEmitters.map((c) => ({
      config: c,
      next: 0,
    }));
    this.spriteParticles = [];
  }
  create(c, x, y, pixel = null) {
    const rng = this.emissionRng;
    const emitterX = x,
      emitterY = y;
    let ox = f(rng.range(c.xMin, c.xMax) + f(c.offsetX)),
      oy = f(rng.range(c.yMin, c.yMax) + f(c.offsetY));
    if ((rng.next() % 100) + 1 > c.chance) return;
    if (c.radiusMax > 0) {
      const r = f(
        f(f(Math.sqrt(rng.unit())) * f(c.radiusMax - c.radiusMin)) +
          c.radiusMin,
      );
      const half = f(f(c.sector * f(0.017453292)) * 0.5),
        a = rng.range(-half, half);
      ox = f(ox + f(f(Math.cos(a)) * r));
      oy = f(oy + f(f(Math.sin(a)) * r));
    } else if (pixel) {
      if (f(pixel.probability * c.imageProbability) <= f(rng.unit() * 255))
        return;
      ox = f(ox + pixel.x);
      oy = f(oy + pixel.y);
    }
    const vy = sortedRange(rng, c.vyMin, c.vyMax),
      vx = sortedRange(rng, c.vxMin, c.vxMax);
    const direction = f(c.direction * f(0.017453292)),
      rotation = sortedRange(rng, -direction, direction);
    const co = f(Math.cos(rotation)),
      sn = f(Math.sin(rotation));
    const distance = f(Math.sqrt(f(f(ox * ox) + f(oy * oy))));
    const radialX = distance > 0 ? f(f(ox / distance) * c.speed) : 0,
      radialY = distance > 0 ? f(f(oy / distance) * c.speed) : 0;
    // Keep the separate cosmetic random stream, even in visual-only mode.
    this.lifetimeRng.next();
    const life = this.lifetimeRng.float(c.lifeMin, c.lifeMax);
    this.lifetimeRng.integer(0, 100);
    if (this.particles.length >= 100000) {
      this.dropped++;
      return;
    }
    const material = this.catalog.materials[c.material],
      alpha = c.alpha >= 0 ? f(c.alpha) : f((material.color >>> 24) / 255);
    x = f(f(x + ox) + 0.5);
    y = f(f(y + oy) + 0.5);
    this.particles.push({
      x,
      y,
      prevX: x,
      prevY: y,
      vx: f(radialX + f(f(vx * co) - f(vy * sn))),
      vy: f(radialY + f(f(vx * sn) + f(vy * co))),
      gx: f(c.gx),
      gy: f(c.gy),
      friction: f(c.friction),
      life,
      maxLife: life,
      age: 0,
      alpha,
      fadeRate: c.fade ? f(-1 / life) : 0,
      airflowForce: f(c.force),
      airflowScale: f(c.scale),
      drawLong: c.drawLong,
      color: material.color,
      glow: material.glow > 0,
      onGrid: c.onGrid,
      singleWidth: c.singleWidth,
      ultrabright: c.ultrabright,
      back: c.back,
      cellType: material.cellType,
      collideWithGrid: c.collideWithGrid === true,
      // Isolated per-particle stream: same native RNG transition, not a claim
      // to know the live game's globally interleaved cosmetic random state.
      collisionRng: this.lifetimeRng.state,
      collisionX: x, collisionY: y, collisionBounce: true,
      attractor: f(c.attractor),
      targetX: emitterX,
      targetY: emitterY,
    });
    this.totalEmitted++;
  }
  emitSource(state) {
    const c = state.config,
      rng = this.emissionRng;
    if (
      state.next > this.elapsedFrames ||
      (c.endFrame >= 0 && this.elapsedFrames >= c.endFrame)
    )
      return;
    state.next =
      this.elapsedFrames +
      Math.max(1, integer(rng, c.intervalMin, c.intervalMax));
    const count = integer(rng, c.countMin, c.countMax);
    rng.range(c.xMin, c.xMax);
    rng.range(c.yMin, c.yMax); // native batch setup
    if (!c.image) {
      for (let i = 0; i < count; i++)
        this.create(
          c,
          f(this.x + (c.entityX ?? 0)),
          f(this.y + (c.entityY ?? 0)),
        );
      return;
    }
    if (state.cursor < 0) return;
    const image = this.resources.images[c.image],
      window = imageWindow(
        state.cursor,
        c.imageSpeed,
        c.imageLoop,
        image.maxTime,
        image.points,
      );
    state.cursor = window.cursor;
    // count_min/max does not replace the image's time-bucket sample count.
    for (let i = 0; i < window.count; i++)
      this.create(
        c,
        f(this.x + (c.entityX ?? 0)),
        f(this.y + (c.entityY ?? 0)),
        image.points[window.start + i],
      );
  }

  emitSprite(state) {
    if (state.next > this.elapsedFrames) return;
    const c = state.config,
      r = this.emissionRng,
      n = (key, d = 0) => Number(c[key] ?? d);
    state.next =
      this.elapsedFrames +
      Math.max(
        1,
        integer(
          r,
          n("emission_interval_min_frames", 1),
          n("emission_interval_max_frames", 1),
        ),
      );
    const count = integer(r, n("count_min", 1), n("count_max", 1));
    for (let i = 0; i < count; i++) {
      const sprite = c.sprites[integer(r, 0, c.sprites.length - 1)];
      const x = f(
          this.x +
            r.range(
              n("randomize_position.min_x"),
              n("randomize_position.max_x"),
            ),
        ),
        y = f(
          this.y +
            r.range(
              n("randomize_position.min_y"),
              n("randomize_position.max_y"),
            ),
        );
      let vx = f(
          n("velocity.x") +
            r.range(
              n("randomize_velocity.min_x"),
              n("randomize_velocity.max_x"),
            ),
        ),
        vy = f(
          n("velocity.y") +
            r.range(
              n("randomize_velocity.min_y"),
              n("randomize_velocity.max_y"),
            ),
        );
      if (n("velocity_always_away_from_center") !== 0) {
        const dx = x - this.x,
          dy = y - this.y,
          d = Math.hypot(dx, dy),
          speed = Math.hypot(vx, vy);
        if (d > 0) {
          vx = f((dx / d) * speed);
          vy = f((dy / d) * speed);
        }
      }
      this.spriteParticles.push({
        sprite,
        x,
        y,
        vx,
        vy,
        gx: n("gravity.x"),
        gy: n("gravity.y"),
        slowdown: n("velocity_slowdown"),
        age: 0,
        delay: n("delay"),
        life: f(
          n("lifetime", 1) +
            r.range(n("randomize_lifetime.min"), n("randomize_lifetime.max")),
        ),
        rotation: f(
          n("rotation") +
            r.range(n("randomize_rotation.min"), n("randomize_rotation.max")),
        ),
        elapsed: 0,
        angularVelocity: f(
          n("angular_velocity") +
            r.range(
              n("randomize_angular_velocity.min"),
              n("randomize_angular_velocity.max"),
            ),
        ),
        scaleX: f(
          n("scale.x", 1) +
            r.range(n("randomize_scale.min_x"), n("randomize_scale.max_x")),
        ),
        scaleY: f(
          n("scale.y", 1) +
            r.range(n("randomize_scale.min_y"), n("randomize_scale.max_y")),
        ),
        scaleVelocityX: n("scale_velocity.x"),
        scaleVelocityY: n("scale_velocity.y"),
        color: [
          n("color.r", 1),
          n("color.g", 1),
          n("color.b", 1),
          n("color.a", 1),
        ],
        colorChange: [
          n("color_change.r"),
          n("color_change.g"),
          n("color_change.b"),
          n("color_change.a"),
        ],
        centered: n("sprite_centered") !== 0,
        velocityRotation: n("use_velocity_as_rotation") !== 0,
        additive: n("additive") !== 0,
      });
      const particle = this.spriteParticles.at(-1);
      particle.cosine = f(Math.cos(particle.rotation));
      particle.sine = f(Math.sin(particle.rotation));
    }
  }
  updateSprites() {
    let write = 0;
    for (const p of this.spriteParticles) {
      p.age++;
      if (stepSprite(p) && (p.color[3] > 0 || p.colorChange[3] > 0))
        this.spriteParticles[write++] = p;
    }
    this.spriteParticles.length = write;
  }
  step() {
    if (
      this.definition.lifetime < 0 ||
      this.elapsedFrames < this.definition.lifetime
    ) {
      for (const e of this.emitters) this.emitSource(e);
      for (const e of this.spriteEmitters) this.emitSprite(e);
    }
    this.updateSprites();
    this.advanceParticles();
  }
}
// Original geometry keeps meditation's stationary births, friction, airflow,
// and -1/lifetime fading. The default lingers 50% longer; the math-only control
// scales lifetimes for new sparks without changing the native Noita emitters.
export const MATH_EMISSION = Object.freeze({
  ...PORTAL_EMITTERS.trail,
  lifeMin: PORTAL_EMITTERS.trail.lifeMin * MATH_TRAIL_SCALE.default,
  lifeMax: PORTAL_EMITTERS.trail.lifeMax * MATH_TRAIL_SCALE.default,
});
export class MathSimulation extends PortalSimulation {
  constructor(options) {
    super({ ...options, effect: "meditation" });
    this.effect = options.effect;
    this.setTrailScale(options.mathTrailScale);
    this.guides = figureSegments(this.effect, this.frame);
    this.path = new FigureTracers(
      this.effect,
      this.guides,
      this.worldSeed,
      this.startFrame,
    );
  }
  setTrailScale(value = MATH_TRAIL_SCALE.default) {
    const scale = validateMathTrailScale(value);
    if (scale === this.mathTrailScale) return;
    this.mathTrailScale = scale;
    this.trailEmission =
      scale === MATH_TRAIL_SCALE.default
        ? MATH_EMISSION
        : Object.freeze({
            ...PORTAL_EMITTERS.trail,
            lifeMin: PORTAL_EMITTERS.trail.lifeMin * scale,
            lifeMax: PORTAL_EMITTERS.trail.lifeMax * scale,
          });
    // Existing particles keep their age, fade and motion. A live edit consumes
    // no RNG and never clears the drawing or restarts the geometric animation.
  }
  step() {
    this.guides = figureSegments(this.effect, this.frame);
    this.path.trace(this.guides, (tracer, id, edge, from, to) => {
      // Sample only the intended edge in the current projection. Rotation or
      // changing branches must not draw an artificial diagonal between edges.
      tracer.previous.x = f(from[0] + this.x);
      tracer.previous.y = f(from[1] + this.y);
      const before = this.particles.length;
      this.emitTrail(
        tracer.previous,
        { x: f(to[0] + this.x), y: f(to[1] + this.y) },
        this.trailEmission,
      );
      for (let i = before; i < this.particles.length; i++) {
        this.particles[i].mathEdge = edge;
        this.particles[i].mathEmitter = id;
      }
    });
    this.advanceParticles();
  }
}

export function makeSimulation(options, catalog, resources) {
  let simulation;
  if (Object.hasOwn(EFFECTS, options.effect)) simulation = new PortalSimulation(options);
  else if (Object.hasOwn(MATH_EFFECTS, options.effect)) simulation = new MathSimulation(options);
  else {
    const definition = catalog.effects[options.effect];
    if (!definition) throw new RangeError("Unknown effect");
    simulation = new SourceSimulation(options, definition, resources, catalog);
  }
  simulation.collisionField = collisionFieldFor(simulation, resources.eyeCollision);
  return simulation;
}
