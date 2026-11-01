// Original image-authoring format. Source RGB is used only for luminance masks,
// never as particle color. Native emitter PNGs contain probability/time data.
import { validateColor } from "./particle-color.mjs";

export const IMAGE_PROJECT_VERSION = 1;
export const IMAGE_COLOR = "#b43cff";
export const MAX_SOURCE_SIZE = 512;
export const MASK_DEFAULTS = Object.freeze({ resolution: 96, channel: "auto", threshold: 96, invert: false, trim: true, shape: "outline", shaded: false });
export const IMAGE_DEFAULTS = Object.freeze({ motion: "rotate", degreesPerSecond: 30, density: 0.7, interval: 4, lifetime: 0.4, drift: 2, gravity: 0, turbulence: 0.03 });

function number(value, name, low, high, integer = false) {
  if (!Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value)))
    throw new RangeError(`Invalid ${name}; expected ${low}–${high}`);
  return value;
}
function choice(value, choices, name) {
  if (!choices.includes(value)) throw new RangeError(`Invalid ${name}`);
  return value;
}
function bool(value, name) {
  if (typeof value !== "boolean") throw new RangeError(`Invalid ${name}`);
  return value;
}
export function maskSettings(input = {}) {
  const p = { ...MASK_DEFAULTS, ...input };
  return {
    resolution: number(p.resolution, "resolution", 8, 192, true),
    channel: choice(p.channel, ["auto", "alpha", "luminance"], "mask channel"),
    threshold: number(p.threshold, "threshold", 1, 255, true),
    invert: bool(p.invert, "invert"), trim: bool(p.trim, "trim"),
    shape: choice(p.shape, ["outline", "fill"], "shape"), shaded: bool(p.shaded, "shaded density"),
  };
}
export function imageSettings(input = {}) {
  const p = { ...IMAGE_DEFAULTS, ...input };
  return {
    motion: choice(p.motion, ["static", "rotate"], "motion"),
    degreesPerSecond: number(p.degreesPerSecond, "rotation speed", -180, 180),
    density: number(p.density, "density", 0.01, 1),
    interval: number(p.interval, "emission interval", 1, 12, true),
    lifetime: number(p.lifetime, "lifetime", 0.1, 3),
    drift: number(p.drift, "drift", 0, 40),
    gravity: number(p.gravity, "gravity", -100, 100),
    turbulence: number(p.turbulence, "turbulence", 0, 0.5),
  };
}
function bytes(value, length, name) {
  if ((!Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Uint8ClampedArray)) || value.length !== length)
    throw new RangeError(`Invalid ${name} data`);
  for (const n of value) number(n, name, 0, 255, true);
  return Uint8Array.from(value);
}
export function validateSource(source) {
  if (!source || typeof source !== "object") throw new RangeError("Missing source image");
  const width = number(source.width, "source width", 1, MAX_SOURCE_SIZE, true);
  const height = number(source.height, "source height", 1, MAX_SOURCE_SIZE, true);
  return { width, height, rgba: bytes(source.rgba, width * height * 4, "source pixels") };
}
export function validateMask(mask) {
  if (!mask || typeof mask !== "object") throw new RangeError("Missing emission mask");
  const width = number(mask.width, "mask width", 1, 192, true);
  const height = number(mask.height, "mask height", 1, 192, true);
  return { width, height, values: bytes(mask.values, width * height, "mask pixels") };
}
export function validateProject(input) {
  if (!input || input.format !== "noita-image-emitter" || input.version !== IMAGE_PROJECT_VERSION)
    throw new RangeError("Unsupported image-emitter project format/version");
  if (typeof input.name !== "string" || input.name.length > 120) throw new RangeError("Invalid project name");
  return {
    format: "noita-image-emitter", version: IMAGE_PROJECT_VERSION, name: input.name,
    source: validateSource(input.source), mask: maskSettings(input.mask), settings: imageSettings(input.settings),
    color: validateColor(input.color), background: validateColor(input.background),
    glow: input.glow === undefined ? true : bool(input.glow, "glow"),
  };
}
export function serializeProject(project) {
  const p = validateProject(project);
  return JSON.stringify({ ...p, source: { ...p.source, rgba: Array.from(p.source.rgba) } });
}

export function convertMask(source, settings = {}) {
  const { width: sw, height: sh, rgba } = validateSource(source), p = maskSettings(settings);
  let hasTransparency = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { hasTransparency = true; break; }
  const channel = p.channel === "auto" ? (hasTransparency ? "alpha" : "luminance") : p.channel;
  const coverage = new Uint8Array(sw * sh);
  let left = sw, top = sh, right = -1, bottom = -1;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    // Transparency always gates inclusion, even for an inverted brightness mask.
    const luma = (54 * rgba[i] + 183 * rgba[i + 1] + 19 * rgba[i + 2]) / 256;
    const value = channel === "alpha" ? rgba[i + 3] : Math.round(rgba[i + 3] * (p.invert ? 255 - luma : luma) / 255);
    coverage[y * sw + x] = value;
    if (value >= p.threshold) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < left) return { width: 1, height: 1, values: new Uint8Array(1), channel };
  if (!p.trim) { left = top = 0; right = sw - 1; bottom = sh - 1; }
  const cw = right - left + 1, ch = bottom - top + 1;
  const scale = p.resolution / Math.max(cw, ch);
  const width = Math.max(1, Math.round(cw * scale)), height = Math.max(1, Math.round(ch * scale));
  const fill = new Uint8Array(width * height);
  // Nearest-neighbour sampling keeps authored pixel edges sharp and predictable.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = left + Math.min(cw - 1, Math.floor((x + 0.5) * cw / width));
    const sy = top + Math.min(ch - 1, Math.floor((y + 0.5) * ch / height));
    const value = coverage[sy * sw + sx];
    fill[y * width + x] = value >= p.threshold ? (p.shaded ? value : 255) : 0;
  }
  const values = fill.slice();
  if (p.shape === "outline") for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (fill[i - 1] && fill[i + 1] && fill[i - width] && fill[i + width]) values[i] = 0;
  }
  return { width, height, values, channel };
}
export function emissionPoints(mask, density = 1) {
  const m = validateMask(mask);
  number(density, "density", 0.01, 1);
  const points = [];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const probability = Math.round(m.values[y * m.width + x] * density);
    if (probability) points.push({ x: x - m.width / 2 + 0.5, y: y - m.height / 2 + 0.5, probability });
  }
  return points;
}
export function emissionEstimate(mask, settings) {
  const p = imageSettings(settings), points = emissionPoints(mask, p.density);
  const perSecond = points.reduce((sum, point) => sum + point.probability / 255, 0) * 60 / p.interval;
  return { points: points.length, perSecond, live: perSecond * p.lifetime };
}
export function emitterPixels(mask, density = 1) {
  const m = validateMask(mask);
  number(density, "density", 0.01, 1);
  const rgba = new Uint8ClampedArray(m.width * m.height * 4);
  for (let i = 0; i < m.values.length; i++) {
    rgba[i * 4] = Math.round(m.values[i] * density);
    // G=0 is a continuously selected bucket with image_animation_speed=0.
    // A=255 is deliberate: transparent RGB can be destroyed by image editors.
    rgba[i * 4 + 3] = 255;
  }
  return { width: m.width, height: m.height, rgba };
}
