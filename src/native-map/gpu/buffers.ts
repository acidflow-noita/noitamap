/// <reference types="@webgpu/types" />

/** Browser/worker GPU upload. The caller owns the returned buffer. */
export function uploadBuffer(
  device: GPUDevice,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
): GPUBuffer {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength)
    device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

/** Returns an owned byte copy; the temporary staging buffer never escapes. */
export async function readBuffer(
  device: GPUDevice,
  source: GPUBuffer,
  bytes: number,
  offset = 0,
): Promise<Uint8Array<ArrayBuffer>> {
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();
    return result;
  } finally {
    staging.destroy();
  }
}
