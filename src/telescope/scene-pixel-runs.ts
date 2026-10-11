export interface ScenePixelRuns {
  width: number;
  height: number;
  clamped: boolean;
  encoding: 'rgba' | 'runs';
  bytes: Uint8Array;
}

/** Store material pixels after the fork's normal transparency/spawn cleanup.
 * Keep runs compressed in memory until this particular scene is requested. */
export function encodeScenePixelRuns(
  pixels: Uint8Array | Uint8ClampedArray, width: number, height: number,
): ScenePixelRuns {
  const size = pixelBytes(width, height);
  if (pixels.byteLength !== size) throw new Error('Scene pixel dimensions differ');
  const input = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const runs = new Uint8Array(size), output = new DataView(runs.buffer);
  let at = 0, start = 0;
  while (start < size) {
    const color = input.getUint32(start, true);
    let end = start + 4;
    while (end < size && input.getUint32(end, true) === color) end += 4;
    if (at + 8 >= size) return { width, height, clamped: pixels instanceof Uint8ClampedArray,
      encoding: 'rgba', bytes: new Uint8Array(pixels) };
    output.setUint32(at, (end - start) / 4, true);
    output.setUint32(at + 4, color, true);
    at += 8; start = end;
  }
  return { width, height, clamped: pixels instanceof Uint8ClampedArray,
    encoding: 'runs', bytes: runs.slice(0, at) };
}

function pixelBytes(width: number, height: number): number {
  const size = width * height * 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || !Number.isSafeInteger(size) || size > 128 * 1024 * 1024)
    throw new Error('Invalid scene pixel dimensions');
  return size;
}

export function decodeScenePixelRuns(record: ScenePixelRuns): Uint8Array | Uint8ClampedArray {
  const size = pixelBytes(record.width, record.height);
  if (!(record.bytes instanceof Uint8Array) || typeof record.clamped !== 'boolean')
    throw new Error('Invalid prepared scene pixels');
  const result = record.clamped ? new Uint8ClampedArray(size) : new Uint8Array(size);
  if (record.encoding === 'rgba') {
    if (record.bytes.byteLength !== size) throw new Error('Truncated scene pixels');
    result.set(record.bytes);
  } else if (record.encoding === 'runs') {
    if (record.bytes.byteLength % 8) throw new Error('Truncated scene pixel run');
    const input = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    const words = new Uint32Array(result.buffer);
    const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    let offset = 0;
    for (let i = 0; i < input.byteLength; i += 8) {
      const length = input.getUint32(i, true), color = input.getUint32(i + 4, littleEndian);
      if (!length || offset + length > words.length) throw new Error('Scene pixel run exceeds its image');
      words.fill(color, offset, offset + length);
      offset += length;
    }
    if (offset !== words.length) throw new Error('Incomplete scene pixels');
  } else throw new Error('Unknown scene pixel encoding');
  return result;
}
