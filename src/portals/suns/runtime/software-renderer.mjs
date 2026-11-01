// Full-resolution, deterministic rasterizer. No WebGL, canvas calls, random draws,
// particle thinning, frame interpolation, or reduced-resolution glow here.
import { writeParticleVertices } from "./portal-physics.mjs";
import { materialGuides } from "./material-color.mjs";
import { cellGlowColor } from "./material-glow.mjs";
import { resolveLighting, buildLightingTable, lightAt, composeLitChannel } from "./noita-lighting.mjs";
import { blitTile } from "./grid-layout.mjs";
import { WasmRaster } from "./wasm-raster.mjs";
import { unmatteRGBA } from "./alpha.mjs";
import { glowDitherField, GLOW_DITHER_TILE } from "./glow-dither.mjs";
const f = Math.fround;
const PURPLE = 0x44b43cff;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const roundCell = (x) => Math.floor(f(x + (x >= 0 ? 0.5 : -0.5)));
// Native 0x00dd8450 allocates GL_RGBA / GL_UNSIGNED_BYTE render targets.
// Keep these quantization boundaries: source blends, horizontal pass, history.
export function byteRound(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  const low = Math.floor(value),
    part = value - low;
  return low + (part > 0.5 || (part === 0.5 && low & 1) ? 1 : 0);
}
export function unorm8(value) {
  return f(byteRound(value * 255) / 255);
}
const colors = new Map();
function rgb(packed) {
  let c = colors.get(packed);
  if (!c) {
    const r = (packed >>> 16) & 255,
      g = (packed >>> 8) & 255,
      b = packed & 255;
    c = [r, g, b, r / 255, g / 255, b / 255];
    colors.set(packed, c);
  }
  return c;
}
export function sampleTexture(image, u, v, channel) {
  const x = u * image.width - 0.5,
    y = v * image.height - 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  const x0 = clamp(ix, 0, image.width - 1),
    x1 = clamp(ix + 1, 0, image.width - 1);
  const y0 = clamp(iy, 0, image.height - 1),
    y1 = clamp(iy + 1, 0, image.height - 1);
  const data = image.rgba,
    w = image.width;
  const a = data[(y0 * w + x0) * 4 + channel],
    b = data[(y0 * w + x1) * 4 + channel];
  const c = data[(y1 * w + x0) * 4 + channel],
    d = data[(y1 * w + x1) * 4 + channel];
  return (
    ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) / 255
  );
}
// 11 bilinear taps at -7.5,-6,-4.5,...,7.5 equal half a contiguous
// 17-tap sum plus half a 5-tap stride-three sum. Sliding sums make this O(pixels).
// Tests compare against the literal shader sampling formula, including clamped edges.
const blurPlans = new Map();
export function blurAxis(
  source,
  target,
  width,
  height,
  vertical,
  coefficient = 1,
) {
  const length = vertical ? height : width,
    lines = vertical ? width : height;
  const stride = vertical ? width * 3 : 3,
    lineStride = vertical ? 3 : width * 3;
  const key = `${length}:${stride}`;
  let plan = blurPlans.get(key);
  if (!plan) {
    plan = {
      initial: new Int32Array(25),
      add: new Int32Array(length),
      remove: new Int32Array(length),
      subRemove: new Int32Array(length),
    };
    for (let k = -8; k <= 16; k++)
      plan.initial[k + 8] = clamp(k, 0, length - 1) * stride;
    for (let x = 0; x < length; x++) {
      plan.add[x] = clamp(x + 9, 0, length - 1) * stride;
      plan.remove[x] = clamp(x - 8, 0, length - 1) * stride;
      plan.subRemove[x] = clamp(x - 6, 0, length - 1) * stride;
    }
    blurPlans.set(key, plan);
  }
  const initial = plan.initial,
    add = plan.add,
    remove = plan.remove,
    subRemove = plan.subRemove,
    weight = coefficient * 0.5;
  for (let line = 0; line < lines; line++)
    for (let channel = 0; channel < 3; channel++) {
      const base = line * lineStride + channel;
      let total = 0;
      for (let k = 0; k < 17; k++) total += source[base + initial[k]];
      let s0 = 0,
        s1 = 0,
        s2 = 0;
      for (let k = 2; k <= 14; k += 3) {
        s0 += source[base + initial[k]];
        s1 += source[base + initial[k + 1]];
        s2 += source[base + initial[k + 2]];
      }
      let phase = 0,
        index = base;
      for (let x = 0; x < length; x++, index += stride) {
        const entering = source[base + add[x]],
          delta = entering - source[base + subRemove[x]];
        let subset;
        if (phase === 0) {
          subset = s0;
          s0 += delta;
          phase = 1;
        } else if (phase === 1) {
          subset = s1;
          s1 += delta;
          phase = 2;
        } else {
          subset = s2;
          s2 += delta;
          phase = 0;
        }
        target[index] = (total + subset) * weight;
        total += entering - source[base + remove[x]];
      }
    }
}

export class SoftwareRenderer {
  constructor(
    width,
    height,
    resources,
    catalog,
    { aggregateGlow = true, kernelModule = null } = {},
  ) {
    this.width = width;
    this.height = height;
    this.resources = resources;
    this.catalog = catalog;
    this.aggregateGlow = aggregateGlow;
    this.glowTexture = resources.assets["data/particles/particle_glow.png"];
    this.monochrome = false;
    this.monochromeTextures = new Map();
    this.ditherTile = GLOW_DITHER_TILE;
    this.scene = new Uint8ClampedArray(width * height * 4);
    this.source = new Float32Array(width * height * 3);
    this.cellSource = new Uint8ClampedArray(width * height * 4);
    this.history = new Float32Array(width * height * 3);
    this.horizontal = new Float32Array(width * height * 3);
    this.vertical = new Float32Array(width * height * 3);
    this.output = new Uint8ClampedArray(width * height * 4);
    this.layers = new Map();
    this.colorKernels = new Map();
    this.activeKernel = null;
    this.pad = 24;
    this.paddedWidth = width + this.pad * 2;
    this.paddedHeight = height + this.pad * 2;
    this.corners = new Float32Array(8);
    this.phaseX = NaN;
    this.phaseY = NaN;
    this.kernel = null;
    this.edgeWeights = new Float32Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // Source FBO coordinates are bottom-up in the GL path.
        const u = (x + 0.5) / width,
          v = 1 - (y + 0.5) / height;
        let weight = 1;
        if (u > 0.95) weight = 1 - (u - 0.95) * 2;
        else if (u < 0.05) weight = 1 - (0.05 - u) * 2;
        if (v > 0.95) weight = 1 - (v - 0.95) * 2;
        else if (v < 0.05) weight = 1 - (0.05 - v) * 2;
        this.edgeWeights[y * width + x] = weight;
      }
    this.native = null;
    if (kernelModule) {
      try {
        this.native = new WasmRaster(
          kernelModule,
          width,
          height,
          this.glowTexture,
          resources.assets,
        );
        this.scene = this.native.scene;
        this.source = this.native.source;
        this.cellSource = this.native.cellSource;
        this.history = this.native.history;
        this.horizontal = this.native.horizontal;
        this.vertical = this.native.vertical;
        this.native.edges.set(this.edgeWeights);
      } catch {
        this.native = null;
      }
    }
    this.clear();
  }
  clear() {
    this.scene.fill(0);
    this.source.fill(0);
    this.cellSource.fill(0);
    this.history.fill(0);
    this.horizontal.fill(0);
    this.vertical.fill(0);
    if (this.output?.byteLength) {
      this.output.fill(0);
      for (let i = 3; i < this.output.length; i += 4) this.output[i] = 255;
    }
    this.layers.clear();
    this.colorKernels.clear();
    this.activeKernel = null;
  }
  bodyRect(left, top, width, height, color, alpha) {
    const x0 = clamp(Math.ceil(left - 0.5), 0, this.width),
      x1 = clamp(Math.ceil(left + width - 0.5), 0, this.width);
    const y0 = clamp(Math.ceil(top - 0.5), 0, this.height),
      y1 = clamp(Math.ceil(top + height - 0.5), 0, this.height);
    const a = alpha / 255,
      inv = 1 - a,
      c = rgb(color),
      r = c[0] * a,
      g = c[1] * a,
      b = c[2] * a;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * this.width + x) * 4;
        this.scene[i] = r + this.scene[i] * inv;
        this.scene[i + 1] = g + this.scene[i + 1] * inv;
        this.scene[i + 2] = b + this.scene[i + 2] * inv;
        this.scene[i + 3] = alpha + this.scene[i + 3] * inv;
      }
  }
  grayTexture(image) {
    let gray = this.monochromeTextures.get(image);
    if (!gray) {
      const rgba = image.rgba.slice();
      for (let i = 0; i < rgba.length; i += 4) {
        const light = Math.round(rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722);
        rgba[i] = rgba[i + 1] = rgba[i + 2] = light;
      }
      gray = { ...image, rgba };
      this.monochromeTextures.set(image, gray);
    }
    return gray;
  }
  setMonochrome(enabled) {
    if (this.monochrome === enabled) return;
    this.monochrome = enabled;
    if (this.native) for (const image of Object.values(this.resources.assets))
      this.native.setTexture(image, (enabled ? this.grayTexture(image) : image).rgba);
    const glow = this.resources.assets["data/particles/particle_glow.png"];
    this.glowTexture = enabled ? this.grayTexture(glow) : glow;
    this.phaseX = this.phaseY = NaN;
    this.colorKernels.clear(); this.activeKernel = null;
  }
  kernelFor(offsetX, offsetY) {
    const phaseX = Math.ceil(offsetX - 0.5) + 0.5 - offsetX,
      phaseY = Math.ceil(offsetY - 0.5) + 0.5 - offsetY;
    if (phaseX === this.phaseX && phaseY === this.phaseY) return;
    this.phaseX = phaseX;
    this.phaseY = phaseY;
    this.kernel = [];
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 24; x++) {
        const u = (x + phaseX) / 24,
          v = (y + phaseY) / 24;
        const a = sampleTexture(this.glowTexture, u, v, 3);
        const r = sampleTexture(this.glowTexture, u, v, 0) * a,
          g = sampleTexture(this.glowTexture, u, v, 1) * a,
          b = sampleTexture(this.glowTexture, u, v, 2) * a;
        if (r !== 0 || g !== 0 || b !== 0) this.kernel.push({ x, y, r, g, b });
      }
    this.colorKernels.clear();
    this.activeKernel = null;
  }
  glowStamp(x, y, color, alpha, count = 1) {
    const key = (color & 0xffffff) + alpha * 0x1000000;
    let taps = this.colorKernels.get(key);
    if (!taps) {
      taps = [];
      const c = rgb(color),
        r = (c[0] * alpha) / (255 * 255),
        g = (c[1] * alpha) / (255 * 255),
        b = (c[2] * alpha) / (255 * 255);
      for (const k of this.kernel) {
        const qr = byteRound(r * k.r * 255),
          qg = byteRound(g * k.g * 255),
          qb = byteRound(b * k.b * 255);
        // Exactly-zero byte contributions can be omitted; do not threshold real light.
        if (qr || qg || qb) taps.push({ x: k.x, y: k.y, r: qr, g: qg, b: qb });
      }
      this.colorKernels.set(key, taps);
    }
    if (this.native) {
      if (this.activeKernel !== taps) {
        this.native.setKernel(taps);
        this.activeKernel = taps;
      }
      this.native.stamp(x, y, count);
      return;
    }
    for (let j = 0; j < taps.length; j++) {
      const k = taps[j],
        xx = x + k.x,
        yy = y + k.y;
      if (xx < 0 || yy < 0 || xx >= this.width || yy >= this.height) continue;
      const i = (yy * this.width + xx) * 3;
      this.source[i] = f(
        Math.min(255, Math.round(this.source[i] * 255) + k.r * count) / 255,
      );
      this.source[i + 1] = f(
        Math.min(255, Math.round(this.source[i + 1] * 255) + k.g * count) / 255,
      );
      this.source[i + 2] = f(
        Math.min(255, Math.round(this.source[i + 2] * 255) + k.b * count) / 255,
      );
    }
  }
  addGlow(x, y, color, alpha) {
    if (x >= this.width || y >= this.height || x + 24 <= 0 || y + 24 <= 0)
      return;
    if (!this.aggregateGlow) {
      this.glowStamp(x, y, color, alpha);
      return;
    }
    // RGBA8 blending is nonlinear: never combine different alpha values first.
    const layerKey = (color & 0xffffff) + alpha * 0x1000000;
    let layer = this.layers.get(layerKey);
    if (!layer) {
      layer = {
        color,
        alpha,
        weights: new Uint32Array(this.paddedWidth * this.paddedHeight),
        indices: [],
      };
      this.layers.set(layerKey, layer);
    }
    const key = (y + this.pad) * this.paddedWidth + x + this.pad;
    if (layer.weights[key] === 0) layer.indices.push(key);
    layer.weights[key]++;
  }
  flushGlow() {
    for (const layer of this.layers.values()) {
      for (let j = 0; j < layer.indices.length; j++) {
        const key = layer.indices[j],
          weight = layer.weights[key];
        this.glowStamp(
          (key % this.paddedWidth) - this.pad,
          Math.floor(key / this.paddedWidth) - this.pad,
          layer.color,
          layer.alpha,
          weight,
        );
        layer.weights[key] = 0;
      }
      layer.indices.length = 0;
    }
  }
  rasterQuad(
    corners,
    color,
    alpha,
    texture = null,
    region = null,
    additive = false,
    glow = false,
    tint = null,
    linear = false,
  ) {
    if (alpha <= 0) return;
    if (this.native && (glow || !this.transparent)) {
      const c = rgb(color);
      if (glow) this.native.glow(corners, c[3], c[4], c[5], alpha);
      else
        this.native.color(
          corners,
          tint?.[0] ?? c[3],
          tint?.[1] ?? c[4],
          tint?.[2] ?? c[5],
          alpha,
          texture,
          region,
          additive,
          this.afterGlow,
          linear,
        );
      return;
    }
    const target = this.afterGlow ? (this.native?.output ?? this.output) : this.scene;
    const ax = corners[0],
      ay = corners[1],
      ux = corners[2] - ax,
      uy = corners[3] - ay,
      vx = corners[6] - ax,
      vy = corners[7] - ay;
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-12) return;
    const x0 = clamp(
        Math.floor(Math.min(corners[0], corners[2], corners[4], corners[6])),
        0,
        this.width,
      ),
      x1 = clamp(
        Math.ceil(Math.max(corners[0], corners[2], corners[4], corners[6])),
        0,
        this.width,
      );
    const y0 = clamp(
        Math.floor(Math.min(corners[1], corners[3], corners[5], corners[7])),
        0,
        this.height,
      ),
      y1 = clamp(
        Math.ceil(Math.max(corners[1], corners[3], corners[5], corners[7])),
        0,
        this.height,
      );
    const c = rgb(color),
      cr = tint ? tint[0] : c[3],
      cg = tint ? tint[1] : c[4],
      cb = tint ? tint[2] : c[5];
    const tw = texture?.width ?? 0,
      th = texture?.height ?? 0,
      data = texture?.rgba;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - ax,
          dy = y + 0.5 - ay,
          u = (dx * vy - dy * vx) / det,
          v = (dy * ux - dx * uy) / det;
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        let r = cr,
          g = cg,
          bb = cb,
          aa = alpha;
        if (texture) {
          if (glow || linear) {
            const tx = (region?.x ?? 0) + u * (region?.width ?? tw) - 0.5,
              ty = (region?.y ?? 0) + v * (region?.height ?? th) - 0.5,
              ix = Math.floor(tx),
              iy = Math.floor(ty),
              fx = tx - ix,
              fy = ty - iy;
            const xx0 = clamp(ix, 0, tw - 1),
              xx1 = clamp(ix + 1, 0, tw - 1),
              yy0 = clamp(iy, 0, th - 1),
              yy1 = clamp(iy + 1, 0, th - 1);
            const i00 = (yy0 * tw + xx0) * 4,
              i10 = (yy0 * tw + xx1) * 4,
              i01 = (yy1 * tw + xx0) * 4,
              i11 = (yy1 * tw + xx1) * 4;
            const w00 = ((1 - fx) * (1 - fy)) / 255,
              w10 = (fx * (1 - fy)) / 255,
              w01 = ((1 - fx) * fy) / 255,
              w11 = (fx * fy) / 255;
            r *=
              data[i00] * w00 +
              data[i10] * w10 +
              data[i01] * w01 +
              data[i11] * w11;
            g *=
              data[i00 + 1] * w00 +
              data[i10 + 1] * w10 +
              data[i01 + 1] * w01 +
              data[i11 + 1] * w11;
            bb *=
              data[i00 + 2] * w00 +
              data[i10 + 2] * w10 +
              data[i01 + 2] * w01 +
              data[i11 + 2] * w11;
            aa *=
              data[i00 + 3] * w00 +
              data[i10 + 3] * w10 +
              data[i01 + 3] * w01 +
              data[i11 + 3] * w11;
          } else {
            const tx = clamp(
                Math.floor(region.x + u * region.width),
                0,
                tw - 1,
              ),
              ty = clamp(Math.floor(region.y + v * region.height), 0, th - 1),
              i = (ty * tw + tx) * 4;
            r *= data[i] / 255;
            g *= data[i + 1] / 255;
            bb *= data[i + 2] / 255;
            aa *= data[i + 3] / 255;
          }
        }
        if (glow) {
          const i = (y * this.width + x) * 3;
          this.source[i] = unorm8(this.source[i] + r * aa);
          this.source[i + 1] = unorm8(this.source[i + 1] + g * aa);
          this.source[i + 2] = unorm8(this.source[i + 2] + bb * aa);
        } else {
          const i = (y * this.width + x) * 4,
            inv = additive ? 1 : 1 - aa;
          target[i] = r * aa * 255 + target[i] * inv;
          target[i + 1] = g * aa * 255 + target[i + 1] * inv;
          target[i + 2] = bb * aa * 255 + target[i + 2] * inv;
          if (!additive) target[i + 3] = aa * 255 + target[i + 3] * inv;
        }
      }
  }

  rasterCellGlow(corners, color, alpha, strength, gas) {
    const packed = cellGlowColor(color, strength, alpha, gas);
    const c = rgb(packed);
    let r = c[0], g = c[1], b = c[2];
    if (this.monochrome) r = g = b = byteRound(r * .2126 + g * .7152 + b * .0722);
    if (this.native) {
      this.native.cell(corners, r / 255, g / 255, b / 255);
      return;
    }
    const ax = corners[0], ay = corners[1], ux = corners[2] - ax, uy = corners[3] - ay;
    const vx = corners[6] - ax, vy = corners[7] - ay, det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-12) return;
    const x0 = clamp(Math.floor(Math.min(corners[0], corners[2], corners[4], corners[6])), 0, this.width);
    const x1 = clamp(Math.ceil(Math.max(corners[0], corners[2], corners[4], corners[6])), 0, this.width);
    const y0 = clamp(Math.floor(Math.min(corners[1], corners[3], corners[5], corners[7])), 0, this.height);
    const y1 = clamp(Math.ceil(Math.max(corners[1], corners[3], corners[5], corners[7])), 0, this.height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const dx = x + .5 - ax, dy = y + .5 - ay;
      const u = (dx * vy - dy * vx) / det, v = (dy * ux - dx * uy) / det;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      const at = (y * this.width + x) * 4;
      // One material contribution per occupied pixel. Later visible particles
      // replace earlier ones; overlaps must not add another large light source.
      this.cellSource[at] = r; this.cellSource[at + 1] = g; this.cellSource[at + 2] = b;
    }
  }
  drawParticle(p, ox, oy, buildGlow) {
    const color = this.colorOverride ?? p.color ?? PURPLE;
    const cellGlow = buildGlow && p.cellGlow !== undefined && p.glow !== false;
    if (!p.drawLong) {
      const wide =
          p.singleWidth === false &&
          (p.cellType === "gas" || p.cellType === "fire"),
        width = wide ? 2 : 1;
      const alpha = Math.trunc(f(f(p.alpha * (wide ? 0.5 : 1)) * 255)) & 255;
      if (alpha > 0) {
        const x =
            (p.onGrid === false ? p.x : roundCell(f(p.x + 0.5))) - width + ox,
          y = (p.onGrid === false ? p.y : roundCell(f(p.y + 0.5))) - 1 + oy;
        this.bodyRect(x, y, width, 1, color, alpha);
        if (cellGlow) {
          const corners = this.corners;
          corners.set([x, y, x + width, y, x + width, y + 1, x, y + 1]);
          this.rasterCellGlow(corners, color, alpha / 255, p.cellGlow, p.cellType === "gas");
        }
      }
      if (buildGlow && p.cellGlow === undefined && p.glow !== false) {
        const a = f(p.alpha * (p.life < 1 ? p.life : 1));
        const packed =
          Math.trunc(f(f(f(a * f(0.03)) * (p.ultrabright ? 50 : 1)) * 255)) &
          255;
        if (packed > 0) {
          if (p.onGrid === false) {
            const x = p.x - 12 + ox,
              y = p.y - 12 + oy;
            this.rasterQuad(
              [x, y, x + 24, y, x + 24, y + 24, x, y + 24],
              color,
              packed / 255,
              this.glowTexture,
              null,
              true,
              true,
            );
          } else
            this.addGlow(
              Math.trunc(f(p.x + 0.5)) - 12 + Math.ceil(ox - 0.5),
              Math.trunc(f(p.y + 0.5)) - 12 + Math.ceil(oy - 0.5),
              color,
              packed,
            );
        }
      }
    } else {
      const vertices = this.corners;
      let alpha = writeParticleVertices(p, false, vertices);
      for (let i = 0; i < 8; i += 2) {
        vertices[i] += ox;
        vertices[i + 1] += oy;
      }
      this.rasterQuad(vertices, color, alpha);
      if (cellGlow && alpha > 0) this.rasterCellGlow(vertices, color, alpha, p.cellGlow, p.cellType === "gas");
      if (buildGlow && p.cellGlow === undefined && p.glow !== false) {
        alpha = writeParticleVertices(p, true, vertices);
        for (let i = 0; i < 8; i += 2) {
          vertices[i] += ox;
          vertices[i + 1] += oy;
        }
        this.rasterQuad(
          vertices,
          color,
          alpha,
          this.glowTexture,
          null,
          true,
          true,
        );
      }
    }
  }
  drawSprite(sprite, sim, transform = null) {
    const image = this.resources.assets[sprite.asset];
    const tex = image && this.monochrome && (!this.native || this.transparent) ? this.grayTexture(image) : image;
    if (!tex) return;
    let elapsed = transform ? Math.max(0, transform.elapsed) : sim.frame / 60;
    if (!transform && sim.loopFrames && sprite.frames > 1) {
      const cycles = Math.max(1, Math.round(sim.loopFrames / (60 * sprite.wait * sprite.frames)));
      elapsed = sprite.loop ? ((sim.frame - sim.startFrame) % sim.loopFrames) / sim.loopFrames * sprite.wait * sprite.frames * cycles : sprite.wait * sprite.frames;
    }
    let frame = sprite.frames > 1 ? Math.floor(elapsed / sprite.wait) : 0;
    frame = sprite.loop
      ? frame % sprite.frames
      : Math.min(frame, sprite.frames - 1);
    const region = {
      x: sprite.posX + (frame % sprite.perRow) * sprite.width,
      y: sprite.posY + Math.floor(frame / sprite.perRow) * sprite.height,
      width: sprite.width,
      height: sprite.height,
    };
    const x =
        (transform?.x ?? sim.x + (sprite.entityX ?? 0)) -
        sim.x +
        this.width / 2 - (this.centerX ?? 0),
      y =
        (transform?.y ?? sim.y + (sprite.entityY ?? 0)) -
        sim.y +
        this.height / 2 - (this.centerY ?? 0);
    const sx = transform?.scaleX ?? 1,
      sy = transform?.scaleY ?? 1,
      c = transform?.cosine ?? 1,
      s = transform?.sine ?? 0;
    const offX = transform?.centered ? sprite.width / 2 : sprite.offsetX,
      offY = transform?.centered ? sprite.height / 2 : sprite.offsetY;
    const corners = [
      [-offX, -offY],
      [sprite.width - offX, -offY],
      [sprite.width - offX, sprite.height - offY],
      [-offX, sprite.height - offY],
    ].flatMap(([px, py]) => [
      x + c * px * sx - s * py * sy,
      y + s * px * sx + c * py * sy,
    ]);
    let tint = transform?.color ?? null;
    if (this.monochrome && tint) {
      const light = tint[0] * 0.2126 + tint[1] * 0.7152 + tint[2] * 0.0722;
      tint = [light, light, light];
    }
    this.rasterQuad(
      corners,
      0xffffff,
      (transform?.color[3] ?? 1) * sprite.alpha,
      tex,
      region,
      transform?.additive ?? sprite.additive,
      false,
      tint,
      !!sprite.smoothFiltering,
    );
  }
  needsSmoothPresentation(sim, { core = true } = {}) {
    return (core && (sim.definition?.sprites ?? []).some(sprite => sprite.emissive && sprite.smoothFiltering)) ||
      (sim.spriteParticles ?? []).some(p => p.delay <= 0 && p.elapsed >= 0 && p.sprite.emissive && p.sprite.smoothFiltering);
  }
  presentEmissive(sim, options, width, height, crop = null, recycle = null, transferable = false) {
    const size = width * height * 4;
    if (recycle?.byteLength === size && recycle !== this.output.buffer) this.presentationPixels = new Uint8ClampedArray(recycle);
    if (!this.presentationPixels || this.presentationPixels.buffer === this.output.buffer || this.presentationPixels.byteLength < size ||
      transferable && this.presentationPixels.byteLength !== size) this.presentationPixels = new Uint8ClampedArray(size);
    const pixels = this.presentationPixels.subarray(0, size);
    crop ??= { x: 0, y: 0, width: this.width, height: this.height };
    blitTile(this.output, pixels, width, { x: 0, y: 0, width, imageHeight: height, crop }, this.width, this.height);
    // Reuse the same sprite rasterizer without allocating display-sized physics
    // or glow buffers. Only the late artwork is projected to display pixels.
    const surface = Object.create(this), world = Object.create(this);
    Object.assign(surface, { width, height, output: pixels, native: null, afterGlow: true });
    world.native = null;
    const corners = new Float64Array(8), sx = width / crop.width, sy = height / crop.height;
    world.rasterQuad = (vertices, ...args) => {
      for (let i = 0; i < 8; i += 2) { corners[i] = (vertices[i] - crop.x) * sx; corners[i + 1] = (vertices[i + 1] - crop.y) * sy; }
      surface.rasterQuad(corners, ...args);
    };
    if (options.core !== false) for (const sprite of sim.definition?.sprites ?? [])
      if (sprite.emissive) world.drawSprite(sprite, sim);
    for (const p of sim.spriteParticles ?? []) if (p.delay <= 0 && p.elapsed >= 0 && p.sprite.emissive)
      world.drawSprite(p.sprite, sim, p);
    if (options.transparent) unmatteRGBA(pixels, options.background ?? 0, !!options.monochrome);
    return pixels;
  }
  render(
    sim,
    { core = true, glow = true, color = null, background = 0, monochrome = false, smoothGlow = false, transparent = false, lighting = true, deferEmissive = false } = {},
    advance = true,
    outputBuffer = null,
  ) {
    if (outputBuffer) this.output = new Uint8ClampedArray(outputBuffer);
    if (!this.output || this.output.byteLength !== this.width * this.height * 4)
      this.output = new Uint8ClampedArray(this.width * this.height * 4);
    // Presentation-only recolor: particle state, RNG and sprites are untouched.
    this.colorOverride = color;
    this.transparent = transparent;
    this.setMonochrome(monochrome);
    const profile = resolveLighting(lighting, monochrome), lightTable = buildLightingTable(profile);
    const bg = rgb(background);
    // Preserve foreground coverage even for opaque output. The background is
    // composed after lighting and must not become an illuminated surface.
    this.scene.fill(0);
    if (advance) { this.source.fill(0); this.cellSource.fill(0); }
    const ox = this.width / 2 - sim.x - (this.centerX ?? 0),
      oy = this.height / 2 - sim.y - (this.centerY ?? 0);
    this.kernelFor(ox, oy);
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i];
      if (p.alpha <= 0) continue;
      const x = p.x + ox,
        y = p.y + oy;
      if (x < -40 || x > this.width + 40 || y < -40 || y > this.height + 40)
        continue;
      this.drawParticle(p, ox, oy, advance);
    }
    if (core) {
      // Original figures have a steady, faint contour even while paused. This
      // is not part of a Noita effect and never changes particle/RNG state.
      for (const [a, b, color] of materialGuides(sim, this.resources, this.colorOverride)) {
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = Math.hypot(dx, dy);
        if (length === 0) continue;
        const nx = (-dy / length) * 0.5,
          ny = (dx / length) * 0.5,
          cx = this.width / 2 - (this.centerX ?? 0),
          cy = this.height / 2 - (this.centerY ?? 0);
        this.rasterQuad(
          [
            a[0] + cx + nx,
            a[1] + cy + ny,
            b[0] + cx + nx,
            b[1] + cy + ny,
            b[0] + cx - nx,
            b[1] + cy - ny,
            a[0] + cx - nx,
            a[1] + cy - ny,
          ],
          color,
          0.16,
        );
      }
      const sprites =
        sim.definition?.sprites ??
        (sim.effect.startsWith("math_") ? [] : [this.catalog.portalSprite]);
      for (const sprite of sprites) if (!sprite.emissive) this.drawSprite(sprite, sim);
    }
    for (const p of sim.spriteParticles ?? [])
      if (p.delay <= 0 && p.elapsed >= 0 && !p.sprite.emissive) this.drawSprite(p.sprite, sim, p);
    if (advance) {
      this.flushGlow();
      if (this.native) this.native.blur();
      else {
        blurAxis(
          this.history,
          this.horizontal,
          this.width,
          this.height,
          false,
          0.1,
        );
        for (let i = 0; i < this.horizontal.length; i++)
          this.horizontal[i] = unorm8(this.horizontal[i]);
        blurAxis(
          this.horizontal,
          this.vertical,
          this.width,
          this.height,
          true,
          1 / 12.2,
        );
      }
      if (this.native) this.native.accumulate();
      else
        for (let i = 0, j = 0; i < this.history.length; i += 3, j++)
          for (let c = 0; c < 3; c++) {
            const tap = this.source[i + c] * 2.5 + this.cellSource[j * 4 + c] / 255 * 4,
              old = this.vertical[i + c] * this.edgeWeights[j];
            this.history[i + c] = unorm8(
              tap * 0.125 + (old * 0.95 + tap * 0.05),
            );
          }
    }
    if (this.native && !monochrome && !smoothGlow && !transparent) {
      this.native.compose(glow, background, profile, lightTable);
    }
    else {
      const output = this.native?.output ?? this.output;
      if (smoothGlow && glow) this.ditherNoise ??= glowDitherField(this.width, this.height);
      for (let p = 0, i = 0; p < this.width * this.height; p++, i += 4) {
        const grayGlow = monochrome && glow ? Math.max(0, this.history[p * 3] - 0.008) * 0.2126 +
          Math.max(0, this.history[p * 3 + 1] - 0.008) * 0.7152 + Math.max(0, this.history[p * 3 + 2] - 0.008) * 0.0722 : 0;
        const coverage = this.scene[i + 3] / 255;
        const grayLight = monochrome ? lightAt(grayGlow, 0, profile) : 0;
        let noise = 0;
        // Dither only the halo over untouched background. Foreground geometry,
        // flat backgrounds and late emissive sprites retain their exact pixels.
        if (smoothGlow && glow && background !== 0xffffff &&
            this.scene[i] === 0 && this.scene[i + 1] === 0 && this.scene[i + 2] === 0 && coverage === 0) {
          const amount = monochrome ? grayGlow : Math.max(0, this.history[p * 3] - 0.008, this.history[p * 3 + 1] - 0.008, this.history[p * 3 + 2] - 0.008);
          if (amount > 0) noise = this.ditherNoise[p] * Math.min(1, amount * 255);
        }
        for (let c = 0; c < 3; c++) {
          const g = monochrome ? grayGlow : glow ? Math.max(0, this.history[p * 3 + c] - 0.008) : 0;
          const light = monochrome ? grayLight : lightTable[(glow ? byteRound(this.history[p * 3 + c] * 255) : 0) * 3 + c];
          output[i + c] = composeLitChannel(this.scene[i + c] / 255, coverage, g, bg[c] / 255, c, profile, light) * 255 + noise;
        }
        output[i + 3] = transparent ? this.scene[i + 3] : 255;
      }
    }
    // Native SpriteSystem emissive layer is drawn after post_final (0x88ca30).
    // An opaque black sprite must occlude glow as well as the particle bodies.
    this.afterGlow = true;
    if (core && !deferEmissive) {
      const sprites = sim.definition?.sprites ??
        (sim.effect.startsWith("math_") ? [] : [this.catalog.portalSprite]);
      for (const sprite of sprites) if (sprite.emissive) this.drawSprite(sprite, sim);
    }
    if (!deferEmissive) for (const p of sim.spriteParticles ?? [])
      if (p.delay <= 0 && p.elapsed >= 0 && p.sprite.emissive) this.drawSprite(p.sprite, sim, p);
    this.afterGlow = false;
    if (this.native) this.output.set(this.native.output);
    if (transparent && !deferEmissive) unmatteRGBA(this.output, background, monochrome);
    return this.output;
  }
}
