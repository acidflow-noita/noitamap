/** Lossless completed-pixel storage. No world generation or mip filtering happens here. */
export const PIXEL_STORAGE_VERSION = 1;
export const PIXEL_STORAGE_BLOCK_SIDE = 8;
export const PIXEL_STORAGE_MAX_BLOCKS = 16384;
export const PIXEL_STORAGE_WORDS_BY_MODE = [0, 1, 4, 8, 24, 64] as const;
const OFFSET_MASK = 0x1fffffff;

export interface PackedPixelSurface {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  /** high three bits: mode; low 29: payload offset in u32 words. */
  readonly directory: Uint32Array;
  readonly payload: Uint32Array;
}

export interface PixelStoragePlan {
  readonly width: number;
  readonly height: number;
  readonly blocksWide: number;
  readonly blocksHigh: number;
  readonly blocks: number;
  readonly inputBytes: number;
  readonly directoryBytes: number;
  readonly maximumPayloadBytes: number;
  readonly gpuPlanningBytes: number;
  readonly uniform: Uint32Array;
}

/** A batch is deliberately bounded. Retain compact outputs, never all dense inputs. */
export function pixelStoragePlan(width: number, height: number): PixelStoragePlan {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new RangeError("Positive integer surface dimensions required");
  const blocksWide = Math.ceil(width / 8), blocksHigh = Math.ceil(height / 8);
  const blocks = blocksWide * blocksHigh;
  if (blocks > PIXEL_STORAGE_MAX_BLOCKS)
    throw new RangeError(`Surface exceeds ${PIXEL_STORAGE_MAX_BLOCKS} blocks; split it into bounded batches`);
  return {
    width, height, blocksWide, blocksHigh, blocks,
    inputBytes: width * height * 4,
    directoryBytes: blocks * 4,
    maximumPayloadBytes: blocks * 64 * 4,
    // mode+word count, local prefix offsets, group prefix including the total.
    gpuPlanningBytes: blocks * 12 + 65 * 4,
    uniform: new Uint32Array([width, height, blocksWide, blocks]),
  };
}

function loadBlock(input: Uint32Array, plan: PixelStoragePlan, block: number, pixels: Uint32Array): void {
  const x0 = block % plan.blocksWide * 8, y0 = Math.floor(block / plan.blocksWide) * 8;
  for (let y = 0; y < 8; y++) {
    const row = Math.min(y0 + y, plan.height - 1) * plan.width;
    for (let x = 0; x < 8; x++) pixels[y * 8 + x] = input[row + Math.min(x0 + x, plan.width - 1)];
  }
}

function classify(pixels: Uint32Array, palette: Uint32Array, indices: Uint8Array): number {
  let colors = 0;
  for (let p = 0; p < 64; p++) {
    const rgba = pixels[p];
    let index = 0;
    while (index < colors && palette[index] !== rgba) index++;
    if (index === colors) {
      if (colors === 16) return 5;
      palette[colors++] = rgba;
    }
    indices[p] = index;
  }
  return colors === 1 ? (palette[0] === 0 ? 0 : 1) : colors <= 2 ? 2 : colors <= 4 ? 3 : 4;
}

/** CPU oracle/fixture encoder. Production construction uses the GPU entries below. */
export function packPixelSurface(input: Uint32Array, width: number, height: number): PackedPixelSurface {
  const plan = pixelStoragePlan(width, height);
  if (!(input instanceof Uint32Array) || input.length !== width * height)
    throw new RangeError("Expected one packed RGBA u32 per pixel");
  const directory = new Uint32Array(plan.blocks), pixels = new Uint32Array(64);
  const palette = new Uint32Array(16), indices = new Uint8Array(64);
  let words = 0;
  for (let block = 0; block < plan.blocks; block++) {
    loadBlock(input, plan, block, pixels);
    const mode = classify(pixels, palette, indices);
    directory[block] = ((mode << 29) | words) >>> 0;
    words += PIXEL_STORAGE_WORDS_BY_MODE[mode];
  }
  const payload = new Uint32Array(words);
  for (let block = 0; block < plan.blocks; block++) {
    const entry = directory[block], mode = entry >>> 29, offset = entry & OFFSET_MASK;
    if (mode === 0) continue;
    loadBlock(input, plan, block, pixels);
    if (mode === 1) { payload[offset] = pixels[0]; continue; }
    if (mode === 5) { payload.set(pixels, offset); continue; }
    classify(pixels, palette, indices);
    const bits = mode === 2 ? 1 : mode === 3 ? 2 : 4, colors = 1 << bits;
    // Only used palette entries are semantically relevant. Zero padding makes bytes deterministic.
    let usedColors = 1;
    for (let p = 0; p < 64; p++) usedColors = Math.max(usedColors, indices[p] + 1);
    payload.set(palette.subarray(0, usedColors), offset);
    for (let p = 0; p < 64; p++)
      payload[offset + colors + Math.floor(p * bits / 32)] |= indices[p] << (p * bits % 32);
  }
  return { version: 1, width, height, directory, payload };
}

export function unpackPixelSurface(surface: PackedPixelSurface): Uint32Array {
  const plan = pixelStoragePlan(surface.width, surface.height);
  if (surface.version !== 1 || !(surface.directory instanceof Uint32Array) ||
    !(surface.payload instanceof Uint32Array) || surface.directory.length !== plan.blocks)
    throw new RangeError("Invalid packed pixel surface");
  for (const entry of surface.directory) {
    const mode = entry >>> 29, offset = entry & OFFSET_MASK;
    if (mode > 5 || offset + PIXEL_STORAGE_WORDS_BY_MODE[mode] > surface.payload.length)
      throw new RangeError("Invalid block payload range or mode");
  }
  const output = new Uint32Array(plan.width * plan.height);
  for (let y = 0; y < plan.height; y++) for (let x = 0; x < plan.width; x++) {
    const entry = surface.directory[Math.floor(y / 8) * plan.blocksWide + Math.floor(x / 8)];
    const mode = entry >>> 29, offset = entry & OFFSET_MASK, p = (y % 8) * 8 + x % 8;
    let rgba = 0;
    if (mode === 1) rgba = surface.payload[offset];
    else if (mode === 5) rgba = surface.payload[offset + p];
    else if (mode > 1) {
      const bits = mode === 2 ? 1 : mode === 3 ? 2 : 4, colors = 1 << bits;
      const index = surface.payload[offset + colors + Math.floor(p * bits / 32)] >>> (p * bits % 32) & (colors - 1);
      rgba = surface.payload[offset + index];
    }
    output[y * plan.width + x] = rgba;
  }
  return output;
}

/**
 * Entry dispatches: analyze ceil(blocks/64); scanBlocks ceil(blocks/256);
 * scanGroups 1; encode ceil(blocks/64). Pass boundaries order storage writes.
 * groups[64] is final payload word count. Output capacity must cover that count.
 */
export const PIXEL_STORAGE_ENCODE_WGSL = /* wgsl */ `
struct Parameters { width: u32, height: u32, blocksWide: u32, blocks: u32 }
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read> pixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> blockInfo: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> groups: array<u32>;
@group(0) @binding(5) var<storage, read_write> payload: array<u32>;
@group(0) @binding(6) var<storage, read_write> directory: array<u32>;

fn blockPixel(block: u32, p: u32) -> u32 {
  let x = min((block % params.blocksWide) * 8u + p % 8u, params.width - 1u);
  let y = min((block / params.blocksWide) * 8u + p / 8u, params.height - 1u);
  return pixels[y * params.width + x];
}

@compute @workgroup_size(64)
fn analyze(@builtin(global_invocation_id) global: vec3<u32>) {
  let block = global.x;
  if (block >= params.blocks) { return; }
  var palette: array<u32, 16>;
  var count = 0u;
  for (var p = 0u; p < 64u; p++) {
    let rgba = blockPixel(block, p);
    var found = 0u;
    loop {
      if (found >= count) { break; }
      if (palette[found] == rgba) { break; }
      found++;
    }
    if (found == count) {
      if (count == 16u) { blockInfo[block] = vec2<u32>(5u, 64u); return; }
      palette[count] = rgba;
      count++;
    }
  }
  var mode = 4u; var words = 24u;
  if (count == 1u) {
    mode = 1u; words = 1u;
    if (palette[0] == 0u) { mode = 0u; words = 0u; }
  } else if (count == 2u) { mode = 2u; words = 4u; }
  else if (count <= 4u) { mode = 3u; words = 8u; }
  blockInfo[block] = vec2<u32>(mode, words);
}

var<workgroup> scan: array<u32, 256>;
@compute @workgroup_size(256)
fn scanBlocks(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
  let block = group.x * 256u + lane;
  scan[lane] = 0u;
  if (block < params.blocks) { scan[lane] = blockInfo[block].y; }
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    let at = (lane + 1u) * step * 2u - 1u;
    if (at < 256u) { scan[at] += scan[at - step]; }
    workgroupBarrier();
  }
  if (lane == 0u) { groups[group.x] = scan[255]; scan[255] = 0u; }
  workgroupBarrier();
  for (var step = 128u; step > 0u; step /= 2u) {
    let at = (lane + 1u) * step * 2u - 1u;
    if (at < 256u) {
      let left = scan[at - step]; scan[at - step] = scan[at]; scan[at] += left;
    }
    workgroupBarrier();
  }
  if (block < params.blocks) { offsets[block] = scan[lane]; }
}

@compute @workgroup_size(64)
fn scanGroups(@builtin(local_invocation_index) lane: u32) {
  let count = (params.blocks + 255u) / 256u;
  scan[lane] = 0u;
  if (lane < count) { scan[lane] = groups[lane]; }
  workgroupBarrier();
  for (var step = 1u; step < 64u; step *= 2u) {
    let at = (lane + 1u) * step * 2u - 1u;
    if (at < 64u) { scan[at] += scan[at - step]; }
    workgroupBarrier();
  }
  if (lane == 0u) { groups[64] = scan[63]; scan[63] = 0u; }
  workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) {
    let at = (lane + 1u) * step * 2u - 1u;
    if (at < 64u) {
      let left = scan[at - step]; scan[at - step] = scan[at]; scan[at] += left;
    }
    workgroupBarrier();
  }
  if (lane < count) { groups[lane] = scan[lane]; }
}

@compute @workgroup_size(64)
fn encode(@builtin(global_invocation_id) global: vec3<u32>) {
  let block = global.x;
  if (block >= params.blocks) { return; }
  let mode = blockInfo[block].x;
  let offset = offsets[block] + groups[block / 256u];
  directory[block] = (mode << 29u) | offset;
  if (mode == 0u) { return; }
  if (mode == 1u) { payload[offset] = blockPixel(block, 0u); return; }
  if (mode == 5u) {
    for (var p = 0u; p < 64u; p++) { payload[offset + p] = blockPixel(block, p); }
    return;
  }
  let bits = select(select(4u, 2u, mode == 3u), 1u, mode == 2u);
  let colors = 1u << bits;
  var palette: array<u32, 16>;
  var indices: array<u32, 8>;
  var count = 0u;
  for (var p = 0u; p < 64u; p++) {
    let rgba = blockPixel(block, p);
    var index = 0u;
    loop {
      if (index >= count) { break; }
      if (palette[index] == rgba) { break; }
      index++;
    }
    if (index == count) { palette[count] = rgba; count++; }
    indices[(p * bits) / 32u] |= index << ((p * bits) % 32u);
  }
  for (var i = 0u; i < colors; i++) { payload[offset + i] = palette[i]; }
  for (var i = 0u; i < bits * 2u; i++) { payload[offset + colors + i] = indices[i]; }
}
`;

/** Can also be included in a presentation shader for direct completed-pixel reads. */
export const PIXEL_STORAGE_READ_WGSL = /* wgsl */ `
fn readCompletedPixel(x: u32, y: u32) -> u32 {
  let block = (y / 8u) * params.blocksWide + x / 8u;
  let entry = directory[block];
  let mode = entry >> 29u;
  let offset = entry & 0x1fffffffu;
  let p = (y % 8u) * 8u + x % 8u;
  if (mode == 0u) { return 0u; }
  if (mode == 1u) { return payload[offset]; }
  if (mode == 5u) { return payload[offset + p]; }
  let bits = select(select(4u, 2u, mode == 3u), 1u, mode == 2u);
  let colors = 1u << bits;
  let index = (payload[offset + colors + (p * bits) / 32u] >> ((p * bits) % 32u)) & (colors - 1u);
  return payload[offset + index];
}
`;

export const PIXEL_STORAGE_DECODE_WGSL = /* wgsl */ `
struct Parameters { width: u32, height: u32, blocksWide: u32, blocks: u32 }
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read> directory: array<u32>;
@group(0) @binding(2) var<storage, read> payload: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;
${PIXEL_STORAGE_READ_WGSL}
@compute @workgroup_size(64)
fn decode(@builtin(global_invocation_id) global: vec3<u32>) {
  let p = global.x;
  if (p >= params.width * params.height) { return; }
  output[p] = readCompletedPixel(p % params.width, p / params.width);
}
`;
