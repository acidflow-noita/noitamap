import { SoftwareRenderer } from "./software-renderer.mjs";
import { materialGuides } from "./material-color.mjs";
import { cellGlowColor } from "./material-glow.mjs";

// Use the same native-backed geometry/alpha/sprite rules as the CPU reference.
// Only quad rasterization changes. Batched instances replace per-pixel JS loops.
export class QuadBatch {
  constructor() { this.data = new Float32Array(16 * 1024); this.count = 0; }
  append(corners, color, alpha, texture, region, tint) {
    if ((this.count + 1) * 16 > this.data.length) {
      const larger = new Float32Array(this.data.length * 2);
      larger.set(this.data); this.data = larger;
    }
    const i = this.count++ * 16, d = this.data;
    for (let j = 0; j < 8; j++) d[i + j] = corners[j];
    d[i + 8] = tint?.[0] ?? ((color >>> 16) & 255) / 255;
    d[i + 9] = tint?.[1] ?? ((color >>> 8) & 255) / 255;
    d[i + 10] = tint?.[2] ?? (color & 255) / 255;
    d[i + 11] = alpha;
    d[i + 12] = region ? region.x / texture.width : 0;
    d[i + 13] = region ? region.y / texture.height : 0;
    d[i + 14] = region ? (region.x + region.width) / texture.width : 1;
    d[i + 15] = region ? (region.y + region.height) / texture.height : 1;
  }
}
export class GpuScene {
  constructor(resources, catalog) {
    this.resources = resources; this.catalog = catalog;
    this.width = 480; this.height = 320;
    this.glowTexture = resources.assets["data/particles/particle_glow.png"];
    this.corners = new Float32Array(8);
    this.rect = new Float32Array(8);
    this.scene = []; this.glow = []; this.cells = []; this.emissive = [];
  }
  rasterQuad(corners, color, alpha, texture = null, region = null, additive = false, glow = false, tint = null, linear = false) {
    if (alpha <= 0) return;
    const list = glow ? this.glow : this.afterGlow ? this.emissive : this.scene;
    let batch = list[list.used - 1];
    const filtered = glow || linear;
    if (!batch || batch.texture !== texture || batch.additive !== additive || batch.linear !== filtered) {
      const index = list.used++;
      batch = list[index] ??= new QuadBatch();
      batch.count = 0; batch.texture = texture; batch.additive = additive; batch.linear = filtered;
    }
    batch.append(corners, color, alpha, texture, region, tint);
  }
  rectangle(x, y, width, height, color, alpha, glow = false) {
    const c = this.rect;
    c[0] = x; c[1] = y; c[2] = x + width; c[3] = y;
    c[4] = x + width; c[5] = y + height; c[6] = x; c[7] = y + height;
    this.rasterQuad(c, color, alpha, glow ? this.glowTexture : null, null, glow, glow);
  }
  bodyRect(x, y, width, height, color, alpha) {
    this.rectangle(x, y, width, height, color, alpha / 255);
  }
  addGlow(x, y, color, alpha) { this.rectangle(x, y, 24, 24, color, alpha / 255, true); }
  rasterCellGlow(corners, color, alpha, strength, gas) {
    if (alpha <= 0) return;
    let batch = this.cells[this.cells.used - 1];
    if (!batch) {
      batch = this.cells[this.cells.used++] ??= new QuadBatch();
      batch.count = 0; batch.texture = null; batch.additive = false;
      batch.linear = false; batch.replace = true;
    }
    // One material value per occupied pixel. Later particles replace earlier
    // ones, including a fading particle whose quantized light has reached zero.
    batch.append(corners, cellGlowColor(color, strength, alpha, gas), 1);
  }
  drawSprite(sprite, sim, transform = null) {
    this.afterGlow = !!sprite.emissive;
    SoftwareRenderer.prototype.drawSprite.call(this, sprite, sim, transform);
    this.afterGlow = false;
  }
  build(sim, { core = true, color = null } = {}, advance = true, particles = true) {
    this.scene.used = 0; this.glow.used = 0; this.cells.used = 0; this.emissive.used = 0;
    // Presentation-only recolor, resolved by the shared drawParticle.
    this.colorOverride = color;
    const cx = this.width / 2 - (this.centerX ?? 0), cy = this.height / 2 - (this.centerY ?? 0);
    const ox = cx - sim.x, oy = cy - sim.y;
    for (const p of particles ? sim.particles : []) {
      if (p.alpha <= 0 || p.x + ox < -40 || p.y + oy < -40 ||
          p.x + ox > this.width + 40 || p.y + oy > this.height + 40) continue;
      SoftwareRenderer.prototype.drawParticle.call(this, p, ox, oy, advance);
    }
    if (core) {
      for (const [a, b, guideColor] of materialGuides(sim, this.resources, color)) {
        const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
        if (!length) continue;
        const nx = -dy / length * 0.5, ny = dx / length * 0.5;
        this.rasterQuad([
          a[0]+cx+nx, a[1]+cy+ny, b[0]+cx+nx, b[1]+cy+ny,
          b[0]+cx-nx, b[1]+cy-ny, a[0]+cx-nx, a[1]+cy-ny,
        ], guideColor, 0.16);
      }
      for (const sprite of sim.definition?.sprites ?? (sim.effect.startsWith("math_") ? [] : [this.catalog.portalSprite]))
        this.drawSprite(sprite, sim);
    }
    for (const p of sim.spriteParticles ?? []) if (p.delay <= 0 && p.elapsed >= 0)
      this.drawSprite(p.sprite, sim, p);
  }
}
