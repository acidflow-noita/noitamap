/**
 * Binary Encoder/Decoder for Drawing Data (V5)
 *
 * V5 adds:
 * - Fill alpha support (2 bits per shape, 4 levels: 0.25, 0.5, 0.75, 1.0)
 * - fillAlpha=0 means no fill
 *
 * V4 adds:
 * - Custom RGB color support
 * - Fixes color resetting to white
 */

import type { Shape } from './doodle-integration';
import { TYPE_CODES, CODE_TO_TYPE, COLOR_PALETTE, COLOR_TO_INDEX, STROKE_WIDTHS, FILL_ALPHAS, FONT_SIZES } from './constants';

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 255, g: 255, b: 255 };
}

/**
 * Convert RGB to hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

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
 * Convert fillAlpha to index for FILL_ALPHAS array
 * FILL_ALPHAS = [0.25, 0.5, 0.75, 1.0]
 * Returns 0-3 for the closest match
 */
function fillAlphaToIndex(alpha: number | undefined): number {
  if (!alpha || alpha <= 0) return 3; // default to 1.0 (solid) if no fill but filled flag is set
  // Find closest match in FILL_ALPHAS
  let closest = 0;
  let minDiff = Math.abs(FILL_ALPHAS[0] - alpha);
  for (let i = 1; i < FILL_ALPHAS.length; i++) {
    const diff = Math.abs(FILL_ALPHAS[i] - alpha);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

/**
 * Check if shape has fill
 */
function hasFill(shape: Shape): boolean {
  return (shape.fillAlpha !== undefined && shape.fillAlpha > 0) || shape.filled === true;
}

/**
 * Find color index (0-7 for palette, -1 for custom)
 */
function colorToIndex(color: string): number {
  const lower = color.toLowerCase();
  if (lower in COLOR_TO_INDEX) {
    return COLOR_TO_INDEX[lower];
  }
  return -1; // Custom color
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
 * Encode shapes to binary format (V5)
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
  estimatedSize += Math.ceil(shapes.length / 4); // fill alphas packed (V5)

  for (const shape of shapes) {
    estimatedSize += 1; // shape header
    const colorIdx = colorToIndex(shape.color);
    if (colorIdx === -1) {
      estimatedSize += 4; // extended type (1) + 3 bytes RGB
    } else if (colorIdx === 7) {
      estimatedSize += 1; // extended type (0)
    }

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
  // Byte 0: version = 5
  buffer[offset++] = 5;

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

  // Packed fill alphas (2 bits each, 4 per byte) - V5
  const fillBytes = Math.ceil(shapes.length / 4);
  for (let i = 0; i < fillBytes; i++) {
    let packedByte = 0;
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapes.length) {
        const s = shapes[shapeIdx];
        if (hasFill(s)) {
          const fIdx = fillAlphaToIndex(s.fillAlpha);
          packedByte |= (fIdx & 0x03) << (j * 2);
        }
        // If no fill, leave as 0 (will use default 1.0 if filled flag is set)
      }
    }
    buffer[offset++] = packedByte;
  }

  // Per-shape data
  for (const shape of shapes) {
    const typeCode = TYPE_CODES[shape.type] ?? 6;
    const colorIdx = colorToIndex(shape.color);
    const fill = hasFill(shape) ? 1 : 0;

    // Shape header: bits 0-3=type, bits 4-6=color, bit 7=fill
    const headerColorIdx = colorIdx === -1 || colorIdx === 7 ? 7 : colorIdx;
    buffer[offset++] = (typeCode & 0x0f) | ((headerColorIdx & 0x07) << 4) | ((fill & 0x01) << 7);

    // Extended color info for Violet and Custom colors
    if (headerColorIdx === 7) {
      if (colorIdx === 7) {
        buffer[offset++] = 0x00; // Violet
      } else {
        buffer[offset++] = 0x01; // Custom RGB
        const rgb = hexToRgb(shape.color);
        buffer[offset++] = rgb.r;
        buffer[offset++] = rgb.g;
        buffer[offset++] = rgb.b;
      }
    }

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
 */
export function decodeShapesBinary(buffer: Uint8Array): {
  shapes: Shape[];
  strokeWidth?: number;
  mapName?: string;
} | null {
  if (buffer.length < 3) return null;

  let offset = 0;
  const version = buffer[offset++];

  if (version === 5) {
    return decodeV5(buffer, offset);
  } else {
    console.warn(`[BinaryEncoder] Unsupported drawing version: ${version}. Only version 5 is supported.`);
    return null;
  }
}

/**
 * Decode V5 format (adds fill alpha support)
 */
function decodeV5(
  buffer: Uint8Array,
  offset: number
): { shapes: Shape[]; strokeWidth?: number; mapName?: string } | null {
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

  // Packed fill alphas (V5)
  const fillBytes = Math.ceil(shapeCount / 4);
  const fillIndices: number[] = [];
  for (let i = 0; i < fillBytes; i++) {
    const packedByte = buffer[offset++];
    for (let j = 0; j < 4; j++) {
      if (i * 4 + j < shapeCount) {
        fillIndices.push((packedByte >> (j * 2)) & 0x03);
      }
    }
  }

  const shapes: Shape[] = [];

  for (let i = 0; i < shapeCount; i++) {
    if (offset >= buffer.length) break;

    const shapeHeader = buffer[offset++];
    const typeCode = shapeHeader & 0x0f;
    let colorIdx = (shapeHeader >> 4) & 0x07;
    const filled = (shapeHeader & 0x80) !== 0;

    let color: string;
    if (colorIdx === 7) {
      const extendedType = buffer[offset++];
      if (extendedType === 0x00) {
        color = COLOR_PALETTE[7];
      } else if (extendedType === 0x01) {
        const r = buffer[offset++];
        const g = buffer[offset++];
        const b = buffer[offset++];
        color = rgbToHex(r, g, b);
      } else {
        color = COLOR_PALETTE[7]; // Fallback to Violet
      }
    } else {
      color = COLOR_PALETTE[colorIdx] ?? '#ffffff';
    }

    const type = CODE_TO_TYPE[typeCode] ?? 'path';

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
      pos,
    };

    // Set fillAlpha from V5 data
    if (filled) {
      shapeObj.filled = true;
      shapeObj.fillAlpha = FILL_ALPHAS[fillIndices[i]] ?? 1.0;
    }

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

  return { shapes, mapName };
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