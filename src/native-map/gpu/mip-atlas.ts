/// <reference types="@webgpu/types" />

export const MIP_ATLAS_SIDE = 1024;
export const MIP_CHAIN_SIDE = 512;
export const MIP_CHAIN_PIXELS = 349525;
export const MIP_CHAIN_BYTES = MIP_CHAIN_PIXELS * 4;

export interface CompletedMipRectangle {
  readonly page: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly sourcePixelOffset: number;
}

/** Explicit final-pixel addresses. The renderer never regenerates or filters a level. */
export function mipAtlasRectangles(pageCount: number): readonly CompletedMipRectangle[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 3)
    throw new RangeError('A mip atlas holds one through three completed page chains');
  const rectangles: CompletedMipRectangle[] = [];
  for (let page = 0; page < pageCount; page++) {
    let offset = 0;
    for (let level = 0, size = 512; size >= 1; level++, size /= 2) {
      const origin = 1024 - size * 2;
      rectangles.push({ page, level, x: origin + (page === 1 ? size : 0),
        y: origin + (page === 2 ? size : 0), size, sourcePixelOffset: offset });
      offset += size * size;
    }
  }
  return rectangles;
}

/** Single pass, at most three input page chains plus one bounded 4 MiB atlas. */
export const MIP_ATLAS_WGSL = /* wgsl */ `
struct Parameters { count: u32, firstAt: u32, secondAt: u32, thirdAt: u32 }
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read> first: array<u32>;
@group(0) @binding(2) var<storage, read> second: array<u32>;
@group(0) @binding(3) var<storage, read> third: array<u32>;
@group(0) @binding(4) var<storage, read_write> atlas: array<u32>;

@compute @workgroup_size(8, 8)
fn pack(@builtin(global_invocation_id) global: vec3<u32>) {
  if (global.x >= 1024u || global.y >= 1024u) { return; }
  var x = global.x;
  var y = global.y;
  var offset = 0u;
  var color = 0u;
  for (var size = 512u; size > 0u; size /= 2u) {
    if (x >= size && y >= size) {
      x -= size; y -= size; offset += size * size;
      continue;
    }
    var page = 0u;
    if (x >= size) { page = 1u; x -= size; }
    else if (y >= size) { page = 2u; y -= size; }
    if (page < params.count) {
      let source = offset + y * size + x;
      switch page {
        case 0u: { color = first[params.firstAt + source]; }
        case 1u: { color = second[params.secondAt + source]; }
        default: { color = third[params.thirdAt + source]; }
      }
    }
    break;
  }
  atlas[global.y * 1024u + global.x] = color;
}
`;

export async function createGpuMipAtlas(device: GPUDevice) {
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto',
    compute: { module: device.createShaderModule({ code: MIP_ATLAS_WGSL }), entryPoint: 'pack' } });
  return {
    /** Append to the caller's existing encoder after its mip passes; no wait or readback here. */
    encode(encoder: GPUCommandEncoder, sources: readonly GPUBuffer[], wordOffsets: readonly number[] = sources.map(() => 0)) {
      const rectangles = mipAtlasRectangles(sources.length);
      if (wordOffsets.length !== sources.length || sources.some((source, i) =>
        !Number.isSafeInteger(wordOffsets[i]) || wordOffsets[i] < 0 || source.size < wordOffsets[i] * 4 + MIP_CHAIN_BYTES))
        throw new RangeError('Each source must contain all ten complete contiguous mip levels');
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([sources.length, wordOffsets[0], wordOffsets[1] ?? 0, wordOffsets[2] ?? 0]));
      const atlas = device.createBuffer({ size: 1024 * 1024 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const buffers = [params, sources[0], sources[1] ?? sources[0], sources[2] ?? sources[0], atlas];
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(128, 128); pass.end();
      return {
        buffer: atlas, width: 1024, height: 1024, pageCount: sources.length, rectangles,
        sourceBytes: sources.reduce((bytes, source) => bytes + source.size, 0),
        atlasBytes: atlas.size, uniformBytes: params.size,
        disposeInputs() { params.destroy(); },
        destroy() { params.destroy(); atlas.destroy(); },
      };
    },
  };
}
