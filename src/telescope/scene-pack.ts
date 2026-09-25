import type { WorkerScenes } from "./worker-scenes";

const MAGIC = 0x3250534e; // NSP2, little endian
type Bytes = Uint8Array | Uint8ClampedArray;

/** JSON preserves metadata; byte arrays occupy one contiguous slab with no
 * base64 expansion or per-pixel JSON. This format contains no seed data. */
export function encodeScenePack(
  scenes: WorkerScenes,
  provenance: string,
): Uint8Array {
  const arrays: Bytes[] = [];
  const blocks = new Map<string, { bytes: Bytes; offset: number }[]>();
  let length = 0;
  const metadata = JSON.stringify({ provenance, scenes }, (_key, value) => {
    if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
      let bytes: Bytes = value,
        encoding = "raw";
      // Material masks are mostly enormous flat RGBA runs. RLE keeps the
      // decompressor's output small; native Uint32Array.fill expands each run.
      if (value.byteLength >= 8 && value.byteLength % 4 === 0) {
        const input = new DataView(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        const pairs = new Uint8Array(value.byteLength),
          output = new DataView(pairs.buffer);
        let at = 0,
          count = 0,
          color = input.getUint32(0, true),
          fits = true;
        const flush = () => {
          if (at + 8 > pairs.length) {
            fits = false;
            return;
          }
          output.setUint32(at, count, true);
          output.setUint32(at + 4, color, true);
          at += 8;
        };
        for (let i = 0; i < value.byteLength && fits; i += 4) {
          const pixel = input.getUint32(i, true);
          if (pixel === color) count++;
          else {
            flush();
            color = pixel;
            count = 1;
          }
        }
        if (fits) flush();
        if (fits && at < value.byteLength) {
          bytes = pairs.subarray(0, at);
          encoding = "rle32";
        }
      }
      let hash = 2166136261;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
      const key = `${encoding}/${value.byteLength}/${bytes.byteLength}/${hash >>> 0}`;
      const candidates = blocks.get(key) ?? [];
      const same = candidates.find((candidate) =>
        candidate.bytes.every((byte, i) => byte === bytes[i]),
      );
      const start = same?.offset ?? length;
      const descriptor = {
        $bytes: [start, bytes.byteLength],
        encoding,
        rawLength: value.byteLength,
        clamped: value instanceof Uint8ClampedArray,
      };
      if (!same) {
        const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
        padded.set(bytes);
        arrays.push(padded);
        candidates.push({ bytes, offset: start });
        blocks.set(key, candidates);
        length += padded.byteLength;
      }
      return descriptor;
    }
    if (ArrayBuffer.isView(value))
      throw new Error("Unsupported scene array type");
    return value;
  });
  const encoded = new TextEncoder().encode(metadata),
    json = new Uint8Array(Math.ceil(encoded.length / 4) * 4);
  json.fill(32);
  json.set(encoded);
  const offset = 12 + json.length;
  const out = new Uint8Array(offset + length),
    header = new DataView(out.buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, json.length, true);
  header.setUint32(8, length, true);
  out.set(json, 12);
  let at = offset;
  for (const bytes of arrays) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

export function decodeScenePack(
  buffer: ArrayBuffer,
  provenance: string,
): WorkerScenes {
  if (buffer.byteLength < 12) throw new Error("Truncated scene pack");
  const header = new DataView(buffer),
    jsonLength = header.getUint32(4, true),
    bytes = header.getUint32(8, true);
  if (
    header.getUint32(0, true) !== MAGIC ||
    12 + jsonLength + bytes !== buffer.byteLength
  )
    throw new Error("Invalid scene pack header");
  const offset = 12 + jsonLength;
  const decodedBlocks = new Map<string, Bytes>();
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const payload = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 12, jsonLength)),
    (_key, value) => {
      if (value && typeof value === "object" && "$bytes" in value) {
        const [start, size] = value.$bytes;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(size) ||
          start < 0 ||
          size < 0 ||
          start + size > bytes
        )
          throw new Error("Scene byte range exceeds packed data");
        const key = `${start}/${size}/${value.encoding}/${value.rawLength}/${!!value.clamped}`;
        const cached = decodedBlocks.get(key);
        if (cached) return cached;
        let result: Bytes;
        if (value.encoding === "rle32") {
          if (
            !Number.isSafeInteger(value.rawLength) ||
            value.rawLength < 0 ||
            value.rawLength % 4 ||
            size % 8
          )
            throw new Error("Invalid scene RLE length");
          result = value.clamped
            ? new Uint8ClampedArray(value.rawLength)
            : new Uint8Array(value.rawLength);
          const target = new Uint32Array(result.buffer),
            source = new DataView(buffer, offset + start, size);
          let at = 0;
          for (let i = 0; i < size; i += 8) {
            const count = source.getUint32(i, true),
              pixel = source.getUint32(i + 4, littleEndian);
            if (!count || at + count > target.length)
              throw new Error("Scene RLE exceeds declared pixel count");
            target.fill(pixel, at, at + count);
            at += count;
          }
          if (at !== target.length)
            throw new Error("Incomplete scene RLE pixels");
        } else if (value.encoding === "raw" && value.rawLength === size) {
          result = value.clamped
            ? new Uint8ClampedArray(buffer, offset + start, size)
            : new Uint8Array(buffer, offset + start, size);
        } else throw new Error("Unsupported scene block encoding");
        decodedBlocks.set(key, result);
        return result;
      }
      return value;
    },
  );
  if (payload.provenance !== provenance)
    throw new Error("Scene pack provenance mismatch");
  if (
    payload.scenes?.version !== 1 ||
    typeof payload.scenes.fullPixels !== "boolean"
  )
    throw new Error("Unsupported scene pack schema");
  return payload.scenes;
}
