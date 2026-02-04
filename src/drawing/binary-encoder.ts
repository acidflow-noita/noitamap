/**
 * Binary Encoder/Decoder for Drawing Data (V3)
 *
 * V3 adds:
 * - Text width support for resizable bounding boxes
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
  return 0; // Default to white
}

/**
 * Write int32 little-endian
 */
function writeInt32(buffer: Uint8Array, offset: number, value: number): void {
  const intVal = Math.round(value);
  buffer[offset] = intVal & 0xff;
  buffer[offset + 1] = (intVal >> 8) & 0xff;
  buffer[offset + 2] = (intVal >> 16) & 0xff;
  buffer[offset + 3] = (intVal >> 24) & 0xff;
}

/**
 * Read int32 little-endian
 */
function readInt32(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);
}

/**
 * Encode shapes to binary format (V3)
 */
export function encodeShapesBinary(shapes: Shape[], mapName: string, _strokeWidth: number = 5): Uint8Array | null {
  if (shapes.length === 0 || shapes.length > 255) return null;

  const mapNameBytes = new TextEncoder().encode(mapName);
  if (mapNameBytes.length > 255) {
    console.warn('Map name too long for binary format', mapName);
    return null;
  }

  // Estimate buffer size (generous)
  let estimatedSize = 2; // version + map name length
  estimatedSize += mapNameBytes.length;
  estimatedSize += 1; // shape count
  estimatedSize += Math.ceil(shapes.length / 4); // stroke widths packed

  for (const shape of shapes) {
    estimatedSize += 1; // shape header
    estimatedSize += shape.pos.length * 4; // all coordinates as int32
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      estimatedSize += 2; // point count (uint16)
    }
    if (shape.type === 'text') {
      estimatedSize += 1 + (shape.text ? new TextEncoder().encode(shape.text).length : 0);
      estimatedSize += 4; // width as int32
    }
  }

  const buffer = new Uint8Array(estimatedSize);
  let offset = 0;

  // === HEADER ===
  // Byte 0: version = 3
  buffer[offset++] = 3;

  // Map name
  buffer[offset++] = mapNameBytes.length;
  buffer.set(mapNameBytes, offset);
  offset += mapNameBytes.length;

  // Shape count
  buffer[offset++] = shapes.length;

  // Packed stroke widths (2 bits each, 4 per byte)
  const strokeBytes = Math.ceil(shapes.length / 4);
  for (let i = 0; i < strokeBytes; i++) {
    let packedByte = 0;
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapes.length) {
        const s = shapes[shapeIdx];
        if (s.type === 'text') {
          const sIdx = fontToIndex(s.fontSize ?? 16);
          packedByte |= (sIdx & 0x03) << (j * 2);
        } else {
          const sIdx = strokeToIndex(s.strokeWidth ?? 5);
          packedByte |= (sIdx & 0x03) << (j * 2);
        }
      }
    }
    buffer[offset++] = packedByte;
  }

  // Per-shape data
  for (const shape of shapes) {
    const typeCode = TYPE_CODES[shape.type] ?? 6;
    const colorIdx = colorToIndex(shape.color);
    const fill = shape.filled ? 1 : 0;

    // Shape header: bits 0-3=type, bits 4-6=color, bit 7=fill
    buffer[offset++] = (typeCode & 0x0f) | ((colorIdx & 0x07) << 4) | ((fill & 0x01) << 7);

    const pos = shape.pos;

    switch (shape.type) {
      case 'point':
        writeInt32(buffer, offset, pos[0]);
        offset += 4;
        writeInt32(buffer, offset, pos[1]);
        offset += 4;
        break;

      case 'text':
        writeInt32(buffer, offset, pos[0]);
        offset += 4;
        writeInt32(buffer, offset, pos[1]);
        offset += 4;
        {
          const textBytes = new TextEncoder().encode(shape.text || '');
          const len = Math.min(255, textBytes.length);
          buffer[offset++] = len;
          buffer.set(textBytes.subarray(0, len), offset);
          offset += len;
          writeInt32(buffer, offset, shape.width ?? 0);
          offset += 4;
        }
        break;

      case 'circle':
        writeInt32(buffer, offset, pos[0]);
        offset += 4;
        writeInt32(buffer, offset, pos[1]);
        offset += 4;
        writeInt32(buffer, offset, pos[2]); // radius directly
        offset += 4;
        break;

      case 'line':
      case 'arrow_line':
        writeInt32(buffer, offset, pos[0]);
        offset += 4;
        writeInt32(buffer, offset, pos[1]);
        offset += 4;
        writeInt32(buffer, offset, pos[2]);
        offset += 4;
        writeInt32(buffer, offset, pos[3]);
        offset += 4;
        break;

      case 'rect':
      case 'ellipse':
        writeInt32(buffer, offset, pos[0]);
        offset += 4;
        writeInt32(buffer, offset, pos[1]);
        offset += 4;
        writeInt32(buffer, offset, pos[2]); // width directly
        offset += 4;
        writeInt32(buffer, offset, pos[3]); // height directly
        offset += 4;
        break;

      case 'path':
      case 'closed_path':
      case 'polygon': {
        const pointCount = pos.length / 2;
        // Point count as uint16
        buffer[offset++] = pointCount & 0xff;
        buffer[offset++] = (pointCount >> 8) & 0xff;
        // All points as absolute int32
        for (let i = 0; i < pos.length; i++) {
          writeInt32(buffer, offset, pos[i]);
          offset += 4;
        }
        break;
      }

      default:
        if (pos.length >= 2) {
          writeInt32(buffer, offset, pos[0]);
          offset += 4;
          writeInt32(buffer, offset, pos[1]);
          offset += 4;
        }
    }
  }

  return buffer.slice(0, offset);
}

/**
 * Decode binary format back to shapes
 * Supports both V1 (legacy) and V2 (simplified) formats
 */
export function decodeShapesBinary(buffer: Uint8Array): {
  shapes: Shape[];
  strokeWidth: number;
  mapName?: string;
} | null {
  if (buffer.length < 3) return null;

  let offset = 0;
  const version = buffer[offset++];

  if (version === 3) {
    return decodeV3(buffer, offset);
  } else if (version === 2) {
    return decodeV2(buffer, offset);
  } else if (version === 0 || version === 1) {
    return decodeV1(buffer);
  } else {
    console.warn('[Binary Decoder] Unsupported version:', version);
    return null;
  }
}

/**
 * Decode V2 format (simplified, int32 everywhere)
 */
function decodeV2(
  buffer: Uint8Array,
  offset: number
): { shapes: Shape[]; strokeWidth: number; mapName?: string } | null {
  // Map name
  const mapNameLen = buffer[offset++];
  const mapName = new TextDecoder().decode(buffer.subarray(offset, offset + mapNameLen));
  offset += mapNameLen;

  // Shape count
  const shapeCount = buffer[offset++];

  // Packed stroke widths
  const strokeBytes = Math.ceil(shapeCount / 4);
  const strokeIndices: number[] = [];
  for (let i = 0; i < strokeBytes; i++) {
    const packedByte = buffer[offset++];
    for (let j = 0; j < 4; j++) {
      if (i * 4 + j < shapeCount) {
        strokeIndices.push((packedByte >> (j * 2)) & 0x03);
      }
    }
  }

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
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4)];
        offset += 8;
        break;

      case 'text':
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4)];
        offset += 8;
        {
          const len = buffer[offset++];
          currentText = new TextDecoder().decode(buffer.subarray(offset, offset + len));
          offset += len;
        }
        break;

      case 'circle':
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4), readInt32(buffer, offset + 8)];
        offset += 12;
        break;

      case 'line':
      case 'arrow_line':
        pos = [
          readInt32(buffer, offset),
          readInt32(buffer, offset + 4),
          readInt32(buffer, offset + 8),
          readInt32(buffer, offset + 12),
        ];
        offset += 16;
        break;

      case 'rect':
      case 'ellipse':
        pos = [
          readInt32(buffer, offset),
          readInt32(buffer, offset + 4),
          readInt32(buffer, offset + 8),
          readInt32(buffer, offset + 12),
        ];
        offset += 16;
        break;

      case 'path':
      case 'closed_path':
      case 'polygon': {
        const pointCount = buffer[offset] | (buffer[offset + 1] << 8);
        offset += 2;
        for (let j = 0; j < pointCount * 2; j++) {
          pos.push(readInt32(buffer, offset));
          offset += 4;
        }
        break;
      }

      default:
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

  return { shapes, strokeWidth: 5, mapName };
}

/**
 * Decode V3 format (adds text width)
 */
function decodeV3(
  buffer: Uint8Array,
  offset: number
): { shapes: Shape[]; strokeWidth: number; mapName?: string } | null {
  // Map name
  const mapNameLen = buffer[offset++];
  const mapName = new TextDecoder().decode(buffer.subarray(offset, offset + mapNameLen));
  offset += mapNameLen;

  // Shape count
  const shapeCount = buffer[offset++];

  // Packed stroke widths
  const strokeBytes = Math.ceil(shapeCount / 4);
  const strokeIndices: number[] = [];
  for (let i = 0; i < strokeBytes; i++) {
    const packedByte = buffer[offset++];
    for (let j = 0; j < 4; j++) {
      if (i * 4 + j < shapeCount) {
        strokeIndices.push((packedByte >> (j * 2)) & 0x03);
      }
    }
  }

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
    let currentWidth: number | undefined;

    switch (type) {
      case 'point':
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4)];
        offset += 8;
        break;

      case 'text':
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4)];
        offset += 8;
        {
          const len = buffer[offset++];
          currentText = new TextDecoder().decode(buffer.subarray(offset, offset + len));
          offset += len;
          currentWidth = readInt32(buffer, offset);
          offset += 4;
        }
        break;

      case 'circle':
        pos = [readInt32(buffer, offset), readInt32(buffer, offset + 4), readInt32(buffer, offset + 8)];
        offset += 12;
        break;

      case 'line':
      case 'arrow_line':
        pos = [
          readInt32(buffer, offset),
          readInt32(buffer, offset + 4),
          readInt32(buffer, offset + 8),
          readInt32(buffer, offset + 12),
        ];
        offset += 16;
        break;

      case 'rect':
      case 'ellipse':
        pos = [
          readInt32(buffer, offset),
          readInt32(buffer, offset + 4),
          readInt32(buffer, offset + 8),
          readInt32(buffer, offset + 12),
        ];
        offset += 16;
        break;

      case 'path':
      case 'closed_path':
      case 'polygon': {
        const pointCount = buffer[offset] | (buffer[offset + 1] << 8);
        offset += 2;
        for (let j = 0; j < pointCount * 2; j++) {
          pos.push(readInt32(buffer, offset));
          offset += 4;
        }
        break;
      }

      default:
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
      if (currentWidth && currentWidth > 0) {
        shapeObj.width = currentWidth;
      }
    } else {
      shapeObj.strokeWidth = STROKE_WIDTHS[strokeIndices[i]] ?? 5;
    }

    shapes.push(shapeObj);
  }

  return { shapes, strokeWidth: 5, mapName };
}

/**
 * Decode V0/V1 format (legacy with delta encoding)
 */
function decodeV1(buffer: Uint8Array): { shapes: Shape[]; strokeWidth: number; mapName?: string } | null {
  if (buffer.length < 11) return null;

  let offset = 0;

  const flags = buffer[offset++];
  const version = flags & 0x07;
  const coordSizeFlag = (flags >> 4) & 0x03;

  const scale = buffer[offset++];
  const xMin = readInt32(buffer, offset);
  offset += 4;
  const yMin = readInt32(buffer, offset);
  offset += 4;

  const mapNameLen = buffer[offset++];
  const mapName = new TextDecoder().decode(buffer.subarray(offset, offset + mapNameLen));
  offset += mapNameLen;

  const shapeCount = buffer[offset++];

  const strokeBytes = Math.ceil(shapeCount / 4);
  const strokeIndices: number[] = [];
  for (let i = 0; i < strokeBytes; i++) {
    const packedByte = buffer[offset++];
    for (let j = 0; j < 4; j++) {
      if (i * 4 + j < shapeCount) {
        strokeIndices.push((packedByte >> (j * 2)) & 0x03);
      }
    }
  }

  const readCoordX = (): number => {
    let value: number;
    if (coordSizeFlag === 2) {
      value = readInt32(buffer, offset);
      offset += 4;
    } else if (coordSizeFlag === 1) {
      value = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;
    } else {
      value = buffer[offset++];
    }
    return value * scale + xMin;
  };

  const readCoordY = (): number => {
    let value: number;
    if (coordSizeFlag === 2) {
      value = readInt32(buffer, offset);
      offset += 4;
    } else if (coordSizeFlag === 1) {
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
    const filled = (shapeHeader & 0x80) !== 0;

    const type = CODE_TO_TYPE[typeCode] ?? 'path';
    const color = COLOR_PALETTE[colorIdx] ?? '#ffffff';

    let pos: number[] = [];
    let currentText: string | undefined;

    switch (type) {
      case 'point':
        pos = [readCoordX(), readCoordY()];
        break;

      case 'text':
        pos = [readCoordX(), readCoordY()];
        {
          const len = buffer[offset++];
          currentText = new TextDecoder().decode(buffer.subarray(offset, offset + len));
          offset += len;
        }
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
        let pointCount: number;
        let deltaMode: number; // 0=int8, 1=int16, 2=absolute

        if (version === 0) {
          const countByte = buffer[offset++];
          pointCount = countByte & 0x7f;
          deltaMode = (countByte & 0x80) !== 0 ? 1 : 0;
        } else {
          const flagsByte = buffer[offset++];
          deltaMode = (flagsByte & 0x02) !== 0 ? 2 : (flagsByte & 0x01) !== 0 ? 1 : 0;
          pointCount = buffer[offset++] | (buffer[offset++] << 8);
        }

        if (pointCount === 0) break;

        if (deltaMode === 2) {
          // Absolute mode
          for (let j = 0; j < pointCount; j++) {
            pos.push(readCoordX(), readCoordY());
          }
        } else {
          // Delta mode
          let x = readCoordX();
          let y = readCoordY();
          pos = [x, y];

          for (let j = 1; j < pointCount; j++) {
            let dx: number, dy: number;
            if (deltaMode === 1) {
              dx = buffer[offset] | (buffer[offset + 1] << 8);
              if (dx & 0x8000) dx |= ~0xffff;
              offset += 2;
              dy = buffer[offset] | (buffer[offset + 1] << 8);
              if (dy & 0x8000) dy |= ~0xffff;
              offset += 2;
            } else {
              dx = buffer[offset++];
              if (dx & 0x80) dx |= ~0xff;
              dy = buffer[offset++];
              if (dy & 0x80) dy |= ~0xff;
            }
            x += dx;
            y += dy;
            pos.push(x, y);
          }
        }
        break;
      }

      default:
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

  return { shapes, strokeWidth: 5, mapName };
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
