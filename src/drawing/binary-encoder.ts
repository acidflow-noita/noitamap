/**
 * Binary Encoder/Decoder for Drawing Data
 *
 * Implements the compact binary format:
 * - 10-byte header (flags, scale, x_min as int32, y_min as int32)
 * - Packed stroke widths (2 bits per shape)
 * - Per-shape headers (type + color + fill in 1 byte)
 * - Compact coordinates (uint8 or uint16 with reference frame)
 * - Delta encoding for paths
 */

import type { Shape } from './doodle-integration';
import { TYPE_CODES, CODE_TO_TYPE, COLOR_PALETTE, COLOR_TO_INDEX, STROKE_WIDTHS, FONT_SIZES } from './constants';

/**
 * Find closest stroke width index
 */
function strokeToIndex(width: number): number {
  let closest = 0;
  let minDiff = Math.abs(STROKE_WIDTHS[0] - width);
  for (let i = 1; i < STROKE_WIDTHS.length; i++) {
    const diff = Math.abs(STROKE_WIDTHS[i] - width);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

/**
 * Find closest font size index
 */
function fontToIndex(size: number): number {
  let closest = 0;
  let minDiff = Math.abs(FONT_SIZES[0] - size);
  for (let i = 1; i < FONT_SIZES.length; i++) {
    const diff = Math.abs(FONT_SIZES[i] - size);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

/**
 * Find closest color index
 */
function colorToIndex(color: string): number {
  const lower = color.toLowerCase();
  if (lower in COLOR_TO_INDEX) {
    return COLOR_TO_INDEX[lower];
  }
  // Default to white if unknown color
  return 0;
}

/**
 * Write int24 little-endian
 */
function writeInt24(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}

/**
 * Read int24 little-endian with sign extension
 * @deprecated Use readInt32 for lossless coordinate storage
 */
function readInt24(buffer: Uint8Array, offset: number): number {
  let value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  if (value & 0x800000) value |= ~0xffffff; // sign extend negative
  return value;
}

/**
 * Write int32 little-endian (lossless for all Noita map coordinates)
 */
function writeInt32(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Read int32 little-endian
 */
function readInt32(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);
}

/**
 * Calculate bounding box of all shapes
 */
function getBoundingBox(shapes: Shape[]): { xMin: number; yMin: number; xMax: number; yMax: number } {
  let xMin = Infinity,
    yMin = Infinity,
    xMax = -Infinity,
    yMax = -Infinity;

  for (const shape of shapes) {
    const pos = shape.pos;
    for (let i = 0; i < pos.length; i += 2) {
      const x = pos[i];
      const y = pos[i + 1];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  // Handle empty/single point
  if (!isFinite(xMin)) {
    return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  }

  return { xMin: Math.floor(xMin), yMin: Math.floor(yMin), xMax: Math.ceil(xMax), yMax: Math.ceil(yMax) };
}

/**
 * Determine if we need uint16 coordinates
 */
function needsUint16(span: number, scale: number): boolean {
  return Math.ceil(span / scale) > 255;
}

/**
 * Encode shapes to binary format
 */
export function encodeShapesBinary(shapes: Shape[], mapName: string, strokeWidth: number = 5): Uint8Array | null {
  if (shapes.length === 0 || shapes.length > 255) return null;

  const mapNameBytes = new TextEncoder().encode(mapName);
  if (mapNameBytes.length > 255) {
    console.warn('Map name too long for binary format', mapName);
    return null;
  }

  const bbox = getBoundingBox(shapes);
  const spanX = bbox.xMax - bbox.xMin;
  const spanY = bbox.yMax - bbox.yMin;
  const span = Math.max(spanX, spanY, 1);

  // Determine coordinate size and scale
  // coord_size: 0=uint8, 1=uint16, 2=int32 (lossless)
  let scale = 1;
  let coordSize = 1; // bytes per coordinate
  let coordSizeFlag = 0;

  if (span <= 255) {
    // Fits in uint8 with scale=1 (lossless)
    coordSize = 1;
    coordSizeFlag = 0;
  } else if (span <= 65535) {
    // Fits in uint16 with scale=1 (lossless)
    coordSize = 2;
    coordSizeFlag = 1;
  } else {
    // Need int32 for lossless, or scale down for URL encoding
    // Use int32 with scale=1 for lossless
    coordSize = 4;
    coordSizeFlag = 2;
  }

  // Estimate buffer size (generous)
  let estimatedSize = 10; // header (10 bytes: flags, scale, xMin as int32, yMin as int32)
  estimatedSize += 1 + mapNameBytes.length; // map name length + bytes
  estimatedSize += 1; // shape count
  estimatedSize += Math.ceil(shapes.length / 4); // stroke widths packed

  for (const shape of shapes) {
    estimatedSize += 1; // shape header
    estimatedSize += shape.pos.length * coordSize; // coordinates
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      estimatedSize += 1; // point count byte
    }
    if (shape.type === 'text' && shape.text) {
      // Text length (1 byte) + text bytes
      // Note: We use TextEncoder to get byte length, which might be expensive in a loop.
      // Optimization: assume < 255 length and just add length * 3 (worst case) + 1 for estimation?
      // Or just measure properly.
      estimatedSize += 1 + new TextEncoder().encode(shape.text).length;
    }
  }

  const buffer = new Uint8Array(estimatedSize);
  let offset = 0;

  // === HEADER (8 bytes) ===
  // Byte 0: flags
  // bits 0-2: version (3 bits) - NOW VERSION 1
  // bit 3: lz_used
  // bits 4-5: coord_size (0=uint8, 1=uint16, 2=int32)
  const version = 1;
  const flags =
    (version & 0x07) | // version 1
    (0 << 3) | // lz_used
    ((coordSizeFlag & 0x03) << 4); // coord_size (2 bits)
  buffer[offset++] = flags;

  // Byte 1: scale (always 1 for lossless)
  buffer[offset++] = scale;

  // Bytes 2-5: x_min (int32) - lossless for all Noita map coordinates
  writeInt32(buffer, offset, bbox.xMin);
  offset += 4;

  writeInt32(buffer, offset, bbox.yMin);
  offset += 4;

  // Byte 10: Map Name Length
  buffer[offset++] = mapNameBytes.length;

  // Map Name Bytes
  buffer.set(mapNameBytes, offset);
  offset += mapNameBytes.length;

  // === SHAPE DATA ===
  // Byte 8: shape count
  buffer[offset++] = shapes.length;

  // Packed stroke widths (2 bits each, 4 per byte)
  const strokeBytes = Math.ceil(shapes.length / 4);
  for (let i = 0; i < strokeBytes; i++) {
    let packedByte = 0;
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapes.length) {
        const s = shapes[shapeIdx];
        // For text, pack the font size index. For all other shapes, pack the global stroke width index.
        if (s.type === 'text') {
          const size = s.fontSize ?? 16;
          const sIdx = fontToIndex(size);
          packedByte |= (sIdx & 0x03) << (j * 2);
        } else {
          const width = s.strokeWidth ?? strokeWidth;
          const sIdx = strokeToIndex(width);
          packedByte |= (sIdx & 0x03) << (j * 2);
        }
      }
    }
    buffer[offset++] = packedByte;
  }

  // Per-shape data
  for (const shape of shapes) {
    const typeCode = TYPE_CODES[shape.type] ?? 6; // default to path
    const colorIdx = colorToIndex(shape.color);
    const fill = shape.filled ? 1 : 0;

    // Shape header (1 byte): bits 0-3=type, bits 4-6=color, bit 7=fill
    const shapeHeader = (typeCode & 0x0f) | ((colorIdx & 0x07) << 4) | ((fill & 0x01) << 7);
    buffer[offset++] = shapeHeader;

    // Encode coordinates based on shape type
    const pos = shape.pos;

    const writeCoordX = (value: number) => {
      const stored = Math.floor((value - bbox.xMin) / scale);
      writeCoordValue(stored);
    };

    const writeCoordY = (value: number) => {
      const stored = Math.floor((value - bbox.yMin) / scale);
      writeCoordValue(stored);
    };

    const writeCoordValue = (stored: number) => {
      if (coordSizeFlag === 2) {
        // int32 little-endian
        buffer[offset++] = stored & 0xff;
        buffer[offset++] = (stored >> 8) & 0xff;
        buffer[offset++] = (stored >> 16) & 0xff;
        buffer[offset++] = (stored >> 24) & 0xff;
      } else if (coordSizeFlag === 1) {
        // uint16 little-endian
        const clamped = Math.max(0, Math.min(65535, stored));
        buffer[offset++] = clamped & 0xff;
        buffer[offset++] = (clamped >> 8) & 0xff;
      } else {
        // uint8
        buffer[offset++] = Math.max(0, Math.min(255, stored));
      }
    };

    switch (shape.type) {
      case 'point':
        // [coord] x, [coord] y
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);
        break;

      case 'text':
        // [coord] x, [coord] y, [len] text
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);
        {
          const textBytes = new TextEncoder().encode(shape.text || '');
          const len = Math.min(255, textBytes.length);
          buffer[offset++] = len;
          buffer.set(textBytes.subarray(0, len), offset);
          offset += len;
        }
        break;

      case 'circle':
        // [coord] cx, cy, radius
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);
        // Radius is relative, use x scale
        writeCoordX(pos[0] + pos[2]); // encode as absolute, decode will subtract
        break;

      case 'line':
      case 'arrow_line':
        // [coord] x1, y1, x2, y2
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);
        writeCoordX(pos[2]);
        writeCoordY(pos[3]);
        break;

      case 'rect':
      case 'ellipse':
        // [coord] x, y, width, height
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);
        writeCoordX(pos[0] + pos[2]); // encode corner as absolute
        writeCoordY(pos[1] + pos[3]);
        break;

      case 'path':
      case 'closed_path':
      case 'polygon': {
        const pointCount = pos.length / 2;
        // Check if deltas fit in int8
        let needInt16Deltas = false;
        for (let i = 2; i < pos.length; i += 2) {
          const dx = Math.round(pos[i] - pos[i - 2]);
          const dy = Math.round(pos[i + 1] - pos[i - 1]);
          if (dx < -128 || dx > 127 || dy < -128 || dy > 127) {
            needInt16Deltas = true;
            break;
          }
        }

        // V1 Format: [flags] [count_low] [count_high]
        // flags: bit 0 = needInt16Deltas
        buffer[offset++] = needInt16Deltas ? 0x01 : 0x00;
        buffer[offset++] = pointCount & 0xff;
        buffer[offset++] = (pointCount >> 8) & 0xff;

        // First point (absolute)
        writeCoordX(pos[0]);
        writeCoordY(pos[1]);

        // Remaining points as deltas
        for (let i = 2; i < pos.length; i += 2) {
          const dx = Math.round(pos[i] - pos[i - 2]);
          const dy = Math.round(pos[i + 1] - pos[i - 1]);

          if (needInt16Deltas) {
            // int16 little-endian
            const clampedDx = Math.max(-32768, Math.min(32767, dx));
            const clampedDy = Math.max(-32768, Math.min(32767, dy));
            buffer[offset++] = clampedDx & 0xff;
            buffer[offset++] = (clampedDx >> 8) & 0xff;
            buffer[offset++] = clampedDy & 0xff;
            buffer[offset++] = (clampedDy >> 8) & 0xff;
          } else {
            // int8
            buffer[offset++] = dx & 0xff;
            buffer[offset++] = dy & 0xff;
          }
        }
        break;
      }

      default:
        // Unknown type, encode as point at first coord
        if (pos.length >= 2) {
          writeCoordX(pos[0]);
          writeCoordY(pos[1]);
        }
    }
  }

  // Trim buffer to actual size
  return buffer.slice(0, offset);
}

/**
 * Decode binary format back to shapes
 */
export function decodeShapesBinary(buffer: Uint8Array): {
  shapes: Shape[];
  strokeWidth: number;
  mapName?: string;
} | null {
  if (buffer.length < 11) return null; // minimum: 10 header + 1 count

  let offset = 0;

  // === HEADER ===
  const flags = buffer[offset++];
  const version = flags & 0x07;
  // const lzUsed = (flags >> 3) & 0x01;
  const coordSizeFlag = (flags >> 4) & 0x03; // 0=uint8, 1=uint16, 2=int32

  if (version > 1) {
    console.warn('[Binary Decoder] Unsupported version:', version);
    return null;
  }

  const scale = buffer[offset++];
  const xMin = readInt32(buffer, offset);
  offset += 4;
  const yMin = readInt32(buffer, offset);
  offset += 4;

  let mapName = '';
  const mapNameLen = buffer[offset++];
  const mapNameBytes = buffer.subarray(offset, offset + mapNameLen);
  mapName = new TextDecoder().decode(mapNameBytes);
  offset += mapNameLen;

  const shapeCount = buffer[offset++];

  // Read packed stroke widths
  const strokeBytes = Math.ceil(shapeCount / 4);
  const strokeIndices: number[] = [];
  for (let i = 0; i < strokeBytes; i++) {
    const packedByte = buffer[offset++];
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapeCount) {
        strokeIndices.push((packedByte >> (j * 2)) & 0x03);
      }
    }
  }

  // Default fallback
  const globalStrokeWidth = 5;

  const readCoordX = (): number => {
    let value: number;
    if (coordSizeFlag === 2) {
      // int32 little-endian
      value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);
      offset += 4;
    } else if (coordSizeFlag === 1) {
      // uint16 little-endian
      value = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
    } else {
      // uint8
      value = buffer[offset++];
    }
    return value * scale + xMin;
  };

  const readCoordY = (): number => {
    let value: number;
    if (coordSizeFlag === 2) {
      // int32 little-endian
      value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);
      offset += 4;
    } else if (coordSizeFlag === 1) {
      // uint16 little-endian
      value = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
    } else {
      // uint8
      value = buffer[offset++];
    }
    return value * scale + yMin;
  };

  const shapes: Shape[] = [];

  for (let i = 0; i < shapeCount; i++) {
    if (offset >= buffer.length) break;

    const shapeHeader = buffer[offset++];
    const typeCode = shapeHeader & 0x0f;
    const colorIdx = (shapeHeader >> 4) & 0x07;
    const filled = (shapeHeader & 0x80) !== 0;

    const type = CODE_TO_TYPE[typeCode] ?? 'path';
    const color = COLOR_PALETTE[colorIdx] ?? '#ffffff';

    let pos: number[] = [];
    let currentText: string | undefined;

    switch (type) {
      case 'point':
        pos = [readCoordX(), readCoordY()];
        break;

      case 'text': {
        pos = [readCoordX(), readCoordY()];
        const len = buffer[offset++];
        const textBytes = buffer.subarray(offset, offset + len);
        currentText = new TextDecoder().decode(textBytes);
        offset += len;
        break;
      }

      case 'circle': {
        const cx = readCoordX();
        const cy = readCoordY();
        const rx = readCoordX();
        pos = [cx, cy, rx - cx];
        break;
      }

      case 'line':
      case 'arrow_line':
        pos = [readCoordX(), readCoordY(), readCoordX(), readCoordY()];
        break;

      case 'rect':
      case 'ellipse': {
        const x1 = readCoordX();
        const y1 = readCoordY();
        const x2 = readCoordX();
        const y2 = readCoordY();
        pos = [x1, y1, x2 - x1, y2 - y1];
        break;
      }

      case 'path':
      case 'closed_path':
      case 'polygon': {
        let pointCount: number;
        let needInt16Deltas: boolean;

        if (version === 0) {
          // V0: [count | flags]
          const countByte = buffer[offset++];
          pointCount = countByte & 0x7f;
          needInt16Deltas = (countByte & 0x80) !== 0;
        } else {
          // V1: [flags] [count_low] [count_high]
          const flagsByte = buffer[offset++];
          needInt16Deltas = (flagsByte & 0x01) !== 0;
          pointCount = buffer[offset++] | (buffer[offset++] << 8);
        }

        if (pointCount === 0) break;

        // First point (absolute)
        let x = readCoordX();
        let y = readCoordY();
        pos = [x, y];

        // Remaining points as deltas
        for (let j = 1; j < pointCount; j++) {
          let dx: number, dy: number;
          if (needInt16Deltas) {
            dx = buffer[offset] | (buffer[offset + 1] << 8);
            if (dx & 0x8000) dx |= ~0xffff; // sign extend
            offset += 2;
            dy = buffer[offset] | (buffer[offset + 1] << 8);
            if (dy & 0x8000) dy |= ~0xffff;
            offset += 2;
          } else {
            dx = buffer[offset++];
            if (dx & 0x80) dx |= ~0xff; // sign extend int8
            dy = buffer[offset++];
            if (dy & 0x80) dy |= ~0xff;
          }
          x += dx;
          y += dy;
          pos.push(x, y);
        }
        break;
      }

      default:
        // Skip unknown types
        continue;
    }

    const shapeObj: Shape = {
      id: crypto.randomUUID(),
      type: type as Shape['type'],
      color,
      filled,
      pos,
    };

    if (type === 'text') {
      shapeObj.fontSize = FONT_SIZES[strokeIndices[i]] ?? 16;
      shapeObj.text = currentText;
    } else {
      shapeObj.strokeWidth = STROKE_WIDTHS[strokeIndices[i]] ?? 5;
    }

    shapes.push(shapeObj);
  }

  return { shapes, strokeWidth: globalStrokeWidth, mapName };
}

/**
 * Base64url encode (no padding)
 */
export function base64urlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Base64url decode
 */
export function base64urlDecode(str: string): Uint8Array {
  // Add padding back
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) {
    padded += '=';
  }
  const binary = atob(padded);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer;
}
