/** Lossless, directly sampled palette fields. No decoded per-pixel array is
 * needed after restore. The C consumer uses the same little-endian format. */
const MAGIC = 0x31505345; // ESP1
const HEADER = 16;
const padding = 3;

export function encodeStencilField(values: Uint16Array): Uint8Array {
  if (!values.length) throw new RangeError('Empty stencil field');
  const palette = [...new Set(values)].sort((a, b) => a - b);
  const bits = Math.ceil(Math.log2(palette.length));
  const payload = HEADER + palette.length * 2;
  const out = new Uint8Array(payload + Math.ceil(values.length * bits / 8) + padding);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true); view.setUint32(4, values.length, true);
  view.setUint32(8, palette.length, true); view.setUint32(12, bits, true);
  const indices = new Map(palette.map((value, index) => [value, index]));
  palette.forEach((value, i) => view.setUint16(HEADER + i * 2, value, true));
  for (let i = 0; i < values.length; i++) {
    const bit = i * bits, byte = payload + Math.floor(bit / 8);
    const code = indices.get(values[i])! << (bit % 8);
    out[byte] |= code & 255; out[byte + 1] |= (code >>> 8) & 255; out[byte + 2] |= (code >>> 16) & 255;
  }
  return out;
}

export function openStencilField(bytes: Uint8Array, expectedLength?: number) {
  if (bytes.byteLength < HEADER + 2 + padding) throw new RangeError('Truncated stencil field');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true), count = view.getUint32(8, true), bits = view.getUint32(12, true);
  if (view.getUint32(0, true) !== MAGIC || !length || count < 1 || count > 65536
      || bits !== Math.ceil(Math.log2(count)) || (expectedLength !== undefined && length !== expectedLength))
    throw new Error('Invalid stencil field header');
  const payload = HEADER + count * 2;
  if (payload + Math.ceil(length * bits / 8) + padding !== bytes.length)
    throw new RangeError('Stencil field size mismatch');
  const mask = (1 << bits) - 1;
  return { length, paletteSize: count, bits, bytes,
    at(index: number): number {
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError('Stencil field index');
      const bit = index * bits, at = payload + Math.floor(bit / 8);
      const symbol = ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) >>> (bit % 8)) & mask;
      if (symbol >= count) throw new RangeError('Invalid stencil palette index');
      return view.getUint16(HEADER + symbol * 2, true);
    },
  };
}
