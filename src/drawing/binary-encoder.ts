/**
 * Binary Encoder/Decoder for Drawing Data
 *
 * Implements the compact binary format:
 * - 8-byte header (flags, scale, x_min, y_min)
 * - Packed stroke widths (2 bits per shape)
 * - Per-shape headers (type + color + fill in 1 byte)
 * - Compact coordinates (uint8 or uint16 with reference frame)
 * - Delta encoding for paths
 */

import type { Shape } from './doodle-integration';
import {
  TYPE_CODES,
  CODE_TO_TYPE,
  COLOR_PALETTE,
  COLOR_TO_INDEX,
  STROKE_WIDTHS,
} from './constants';

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
 */
function readInt24(buffer: Uint8Array, offset: number): number {
  let value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  if (value & 0x800000) value |= ~0xffffff; // sign extend negative
  return value;
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
export function encodeShapesBinary(shapes: Shape[], strokeWidth: number = 5): Uint8Array | null {
  if (shapes.length === 0 || shapes.length > 255) return null;

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
  let estimatedSize = 8; // header
  estimatedSize += 1; // shape count
  estimatedSize += Math.ceil(shapes.length / 4); // stroke widths packed

  for (const shape of shapes) {
    estimatedSize += 1; // shape header
    estimatedSize += shape.pos.length * coordSize; // coordinates
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      estimatedSize += 1; // point count byte
    }
  }

  const buffer = new Uint8Array(estimatedSize);
  let offset = 0;

  // === HEADER (8 bytes) ===
  // Byte 0: flags
  // bits 0-2: version (3 bits)
  // bit 3: lz_used
  // bits 4-5: coord_size (0=uint8, 1=uint16, 2=int32)
  const flags =
    (0 & 0x07) | // version (3 bits)
    (0 << 3) | // lz_used (set later if compressed)
    ((coordSizeFlag & 0x03) << 4); // coord_size (2 bits)
  buffer[offset++] = flags;

  // Byte 1: scale (always 1 for lossless)
  buffer[offset++] = scale;

  // Bytes 2-4: x_min (int24)
  writeInt24(buffer, offset, bbox.xMin);
  offset += 3;

  // Bytes 5-7: y_min (int24)
  writeInt24(buffer, offset, bbox.yMin);
  offset += 3;

  // === SHAPE DATA ===
  // Byte 8: shape count
  buffer[offset++] = shapes.length;

  // Packed stroke widths (2 bits each, 4 per byte)
  const strokeIdx = strokeToIndex(strokeWidth);
  const strokeBytes = Math.ceil(shapes.length / 4);
  for (let i = 0; i < strokeBytes; i++) {
    let packedByte = 0;
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapes.length) {
        // For now, all shapes use the same stroke width
        packedByte |= (strokeIdx & 0x03) << (j * 2);
      }
    }
    buffer[offset++] = packedByte;
  }

  // Per-shape data
  for (const shape of shapes) {
    const typeCode = TYPE_CODES[shape.type] ?? 6; // default to path
    const colorIdx = colorToIndex(shape.color);
    const fill = 0; // TODO: support fill

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
        // Point count with delta size flag
        const pointCount = pos.length / 2;
        if (pointCount > 127) {
          // Too many points, skip this shape
          continue;
        }

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

        // Point count byte: high bit = delta size flag
        buffer[offset++] = pointCount | (needInt16Deltas ? 0x80 : 0);

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
export function decodeShapesBinary(buffer: Uint8Array): { shapes: Shape[]; strokeWidth: number } | null {
  if (buffer.length < 9) return null; // minimum: 8 header + 1 count

  let offset = 0;

  // === HEADER ===
  const flags = buffer[offset++];
  const version = flags & 0x07;
  // const lzUsed = (flags >> 3) & 0x01;
  const useUint16 = ((flags >> 4) & 0x01) === 1;

  if (version !== 0) {
    console.warn('[Binary Decoder] Unknown version:', version);
    return null;
  }

  const scale = buffer[offset++];
  const xMin = readInt24(buffer, offset);
  offset += 3;
  const yMin = readInt24(buffer, offset);
  offset += 3;

  // === SHAPE DATA ===
  const shapeCount = buffer[offset++];
  if (shapeCount === 0) return { shapes: [], strokeWidth: 5 };

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

  // Use first shape's stroke width as global (for now)
  const strokeWidth = STROKE_WIDTHS[strokeIndices[0]] ?? 5;

  const readCoordX = (): number => {
    let value: number;
    if (useUint16) {
      value = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
    } else {
      value = buffer[offset++];
    }
    return value * scale + xMin;
  };

  const readCoordY = (): number => {
    let value: number;
    if (useUint16) {
      value = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
    } else {
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
    // const fill = (shapeHeader >> 7) & 0x01;

    const type = CODE_TO_TYPE[typeCode] ?? 'path';
    const color = COLOR_PALETTE[colorIdx] ?? '#ffffff';

    let pos: number[] = [];

    switch (type) {
      case 'point':
        pos = [readCoordX(), readCoordY()];
        break;

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
        const countByte = buffer[offset++];
        const pointCount = countByte & 0x7f;
        const needInt16Deltas = (countByte & 0x80) !== 0;

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

    shapes.push({
      id: crypto.randomUUID(),
      type: type as Shape['type'],
      color,
      pos,
    });
  }

  return { shapes, strokeWidth };
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
