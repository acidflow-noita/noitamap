#!/usr/bin/env npx tsx
/**
 * Vectorize Script — Convert raster images to Noitamap drawing shapes
 *
 * Usage: npx tsx scripts/vectorize.ts <input-image>
 *
 * Shells out to system-installed `vtracer` for raster→SVG conversion,
 * then parses the SVG into Shape objects and outputs:
 *   - <name>.svg  — raw vtracer SVG output
 *   - <name>.json — Shape array JSON (importable via drag-and-drop)
 *   - <name>.webp — WebP with binary-encoded shapes in a NOIT RIFF chunk
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

// ─── Map constants (same as the app) ─────────────────────────────────────────

const REGULAR_MAP_WIDTH = 107520;
const REGULAR_MAP_CENTER = { x: 0, y: 5120 };
const DEFAULT_TARGET_SCALE_PERCENT = 0.6;

// ─── Shape type (matches src/drawing/doodle-integration.ts) ──────────────────

interface Shape {
  id: string;
  type: string;
  pos: number[];
  color: string;
  filled?: boolean;
  fillAlpha?: number;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  width?: number;
}

// ─── Binary encoder constants (matches src/drawing/constants.ts) ─────────────

const COLOR_PALETTE = [
  '#ffffff', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6',
];

const COLOR_TO_INDEX: Record<string, number> = Object.fromEntries(
  COLOR_PALETTE.map((c, i) => [c.toLowerCase(), i])
);

const TYPE_CODES: Record<string, number> = {
  point: 0, circle: 1, line: 2, arrow_line: 3,
  rect: 4, ellipse: 5, path: 6, closed_path: 7,
  polygon: 8, text: 9,
};

const STROKE_WIDTHS = [2, 5, 10, 15];
const FILL_ALPHAS = [0.25, 0.5, 0.75, 1.0];

// ─── Binary encoder (matches src/drawing/binary-encoder.ts) ──────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 255, g: 255, b: 255 };
}

function strokeToIndex(width: number): number {
  let closest = 0;
  let minDiff = Math.abs(STROKE_WIDTHS[0] - width);
  for (let i = 1; i < STROKE_WIDTHS.length; i++) {
    const diff = Math.abs(STROKE_WIDTHS[i] - width);
    if (diff < minDiff) { minDiff = diff; closest = i; }
  }
  return closest;
}

function fillAlphaToIndex(alpha: number | undefined): number {
  if (!alpha || alpha <= 0) return 3;
  let closest = 0;
  let minDiff = Math.abs(FILL_ALPHAS[0] - alpha);
  for (let i = 1; i < FILL_ALPHAS.length; i++) {
    const diff = Math.abs(FILL_ALPHAS[i] - alpha);
    if (diff < minDiff) { minDiff = diff; closest = i; }
  }
  return closest;
}

function hasFill(shape: Shape): boolean {
  return (shape.fillAlpha !== undefined && shape.fillAlpha > 0) || shape.filled === true;
}

function colorToIndex(color: string): number {
  const lower = color.toLowerCase();
  if (lower in COLOR_TO_INDEX) return COLOR_TO_INDEX[lower];
  return -1;
}

function writeInt32(buffer: Uint8Array, offset: number, value: number): void {
  const intVal = Math.round(value);
  buffer[offset] = intVal & 0xff;
  buffer[offset + 1] = (intVal >> 8) & 0xff;
  buffer[offset + 2] = (intVal >> 16) & 0xff;
  buffer[offset + 3] = (intVal >> 24) & 0xff;
}

function encodeShapesBinary(shapes: Shape[], mapName: string): Uint8Array | null {
  if (shapes.length === 0) return null;

  const mapNameBytes = new TextEncoder().encode(mapName);
  if (mapNameBytes.length > 255) return null;

  // Estimate buffer size
  let estimatedSize = 2 + mapNameBytes.length + 4;
  estimatedSize += Math.ceil(shapes.length / 4) * 2; // stroke + fill packed bytes
  for (const shape of shapes) {
    estimatedSize += 1; // header
    const colorIdx = colorToIndex(shape.color);
    if (colorIdx === -1) estimatedSize += 4;
    else if (colorIdx === 7) estimatedSize += 1;
    estimatedSize += shape.pos.length * 4;
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') estimatedSize += 2;
    if (shape.type === 'text') estimatedSize += 1 + (shape.text ? new TextEncoder().encode(shape.text).length : 0) + 4;
  }

  const buffer = new Uint8Array(estimatedSize);
  let offset = 0;

  // Header: version 5
  buffer[offset++] = 5;
  buffer[offset++] = mapNameBytes.length;
  buffer.set(mapNameBytes, offset);
  offset += mapNameBytes.length;

  writeInt32(buffer, offset, shapes.length);
  offset += 4;

  // Packed stroke widths
  const strokeBytes = Math.ceil(shapes.length / 4);
  for (let i = 0; i < strokeBytes; i++) {
    let packedByte = 0;
    for (let j = 0; j < 4; j++) {
      const shapeIdx = i * 4 + j;
      if (shapeIdx < shapes.length) {
        const sIdx = strokeToIndex(shapes[shapeIdx].strokeWidth ?? 5);
        packedByte |= (sIdx & 0x03) << (j * 2);
      }
    }
    buffer[offset++] = packedByte;
  }

  // Packed fill alphas
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
      }
    }
    buffer[offset++] = packedByte;
  }

  // Per-shape data
  for (const shape of shapes) {
    const typeCode = TYPE_CODES[shape.type] ?? 6;
    const colorIdx = colorToIndex(shape.color);
    const fill = hasFill(shape) ? 1 : 0;
    const headerColorIdx = colorIdx === -1 || colorIdx === 7 ? 7 : colorIdx;
    buffer[offset++] = (typeCode & 0x0f) | ((headerColorIdx & 0x07) << 4) | ((fill & 0x01) << 7);

    if (headerColorIdx === 7) {
      if (colorIdx === 7) {
        buffer[offset++] = 0x00;
      } else {
        buffer[offset++] = 0x01;
        const rgb = hexToRgb(shape.color);
        buffer[offset++] = rgb.r;
        buffer[offset++] = rgb.g;
        buffer[offset++] = rgb.b;
      }
    }

    const pos = shape.pos;
    switch (shape.type) {
      case 'point':
        writeInt32(buffer, offset, pos[0]); offset += 4;
        writeInt32(buffer, offset, pos[1]); offset += 4;
        break;
      case 'circle':
        writeInt32(buffer, offset, pos[0]); offset += 4;
        writeInt32(buffer, offset, pos[1]); offset += 4;
        writeInt32(buffer, offset, pos[2]); offset += 4;
        break;
      case 'line':
      case 'arrow_line':
      case 'rect':
      case 'ellipse':
        writeInt32(buffer, offset, pos[0]); offset += 4;
        writeInt32(buffer, offset, pos[1]); offset += 4;
        writeInt32(buffer, offset, pos[2]); offset += 4;
        writeInt32(buffer, offset, pos[3]); offset += 4;
        break;
      case 'path':
      case 'closed_path':
      case 'polygon': {
        const pointCount = pos.length / 2;
        buffer[offset++] = pointCount & 0xff;
        buffer[offset++] = (pointCount >> 8) & 0xff;
        for (let i = 0; i < pos.length; i++) {
          writeInt32(buffer, offset, pos[i]);
          offset += 4;
        }
        break;
      }
      default:
        if (pos.length >= 2) {
          writeInt32(buffer, offset, pos[0]); offset += 4;
          writeInt32(buffer, offset, pos[1]); offset += 4;
        }
    }
  }

  return buffer.slice(0, offset);
}

// ─── RIFF / WebP construction ────────────────────────────────────────────────

function createRiffChunk(chunkId: string, data: Uint8Array): Uint8Array {
  const paddedSize = data.length + (data.length % 2);
  const chunk = new Uint8Array(8 + paddedSize);
  chunk[0] = chunkId.charCodeAt(0);
  chunk[1] = chunkId.charCodeAt(1);
  chunk[2] = chunkId.charCodeAt(2);
  chunk[3] = chunkId.charCodeAt(3);
  chunk[4] = data.length & 0xff;
  chunk[5] = (data.length >> 8) & 0xff;
  chunk[6] = (data.length >> 16) & 0xff;
  chunk[7] = (data.length >> 24) & 0xff;
  chunk.set(data, 8);
  return chunk;
}

/**
 * Build a minimal valid WebP file (1x1 green pixel, lossy) with NOIT + NMAP chunks appended.
 */
function buildWebpWithDrawingData(shapes: Shape[], mapName: string): Buffer {
  const binary = encodeShapesBinary(shapes, mapName);
  if (!binary) throw new Error('Failed to encode shapes');

  // Minimal 1x1 lossy WebP (VP8 bitstream for a 1x1 green pixel)
  // This is the smallest valid WebP: RIFF header + WEBP + VP8 chunk
  const vp8Data = Buffer.from([
    // VP8 bitstream for 1x1 pixel
    0x9d, 0x01, 0x2a, // VP8 signature
    0x01, 0x00, 0x01, 0x00, // width=1, height=1
    0x01, 0x40, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00,
    0xfe, 0xfb, 0x94, 0x00, 0x00,
  ]);

  const vp8Chunk = createRiffChunk('VP8 ', vp8Data);
  const drawChunk = createRiffChunk('NOIT', binary);
  const mapChunk = createRiffChunk('NMAP', new TextEncoder().encode(mapName));

  // Total RIFF payload: "WEBP" (4) + VP8 chunk + NOIT chunk + NMAP chunk
  const riffPayloadSize = 4 + vp8Chunk.length + drawChunk.length + mapChunk.length;
  const totalSize = 8 + riffPayloadSize; // "RIFF" + size(4) + payload

  const result = Buffer.alloc(totalSize);
  let offset = 0;

  // RIFF header
  result.write('RIFF', offset); offset += 4;
  result.writeUInt32LE(riffPayloadSize, offset); offset += 4;
  result.write('WEBP', offset); offset += 4;

  // VP8 chunk
  Buffer.from(vp8Chunk).copy(result, offset); offset += vp8Chunk.length;

  // NOIT chunk (drawing data)
  Buffer.from(drawChunk).copy(result, offset); offset += drawChunk.length;

  // NMAP chunk (map name)
  Buffer.from(mapChunk).copy(result, offset);

  return result;
}

// ─── SVG parsing (ported from deleted src/drawing/vectorize.ts) ──────────────

function sampleBezier(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  segments = 20
): number[] {
  const points: number[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    const x = uuu * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + ttt * x3;
    const y = uuu * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + ttt * y3;
    points.push(x, y);
  }
  return points;
}

function isRectangle(pos: number[]): { x: number; y: number; w: number; h: number } | null {
  if (pos.length !== 8 && pos.length !== 10) return null;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < pos.length; i += 2) {
    points.push({ x: pos[i], y: pos[i + 1] });
  }

  if (points.length === 5) {
    if (Math.abs(points[0].x - points[4].x) < 0.001 && Math.abs(points[0].y - points[4].y) < 0.001) {
      points.pop();
    } else {
      return null;
    }
  }
  if (points.length !== 4) return null;

  const xs = points.map(p => p.x).sort((a, b) => a - b);
  const ys = points.map(p => p.y).sort((a, b) => a - b);
  const tolerance = 1.0;

  if (Math.abs(xs[0] - xs[1]) > tolerance) return null;
  if (Math.abs(xs[2] - xs[3]) > tolerance) return null;
  if (Math.abs(ys[0] - ys[1]) > tolerance) return null;
  if (Math.abs(ys[2] - ys[3]) > tolerance) return null;

  const isH = (p1: { x: number; y: number }, p2: { x: number; y: number }) => Math.abs(p1.y - p2.y) <= tolerance;
  const isV = (p1: { x: number; y: number }, p2: { x: number; y: number }) => Math.abs(p1.x - p2.x) <= tolerance;

  let valid = false;
  if (isH(points[0], points[1]) && isV(points[1], points[2]) && isH(points[2], points[3]) && isV(points[3], points[0])) valid = true;
  else if (isV(points[0], points[1]) && isH(points[1], points[2]) && isV(points[2], points[3]) && isH(points[3], points[0])) valid = true;
  if (!valid) return null;

  return { x: xs[0], y: ys[0], w: xs[2] - xs[0], h: ys[2] - ys[0] };
}

function parseSvgToShapes(
  svgContent: string,
  mapWidth: number,
  mapCenter: { x: number; y: number },
  targetScalePercent: number,
  originalWidth: number,
  originalHeight: number
): Shape[] {
  const dom = new JSDOM(svgContent, { contentType: 'image/svg+xml' });
  const doc = dom.window.document;

  const svgWidth = originalWidth;
  const svgHeight = originalHeight;

  const targetWidth = mapWidth * targetScalePercent;
  const scale = targetWidth / svgWidth;
  const offsetX = mapCenter.x - (svgWidth * scale) / 2;
  const offsetY = mapCenter.y - (svgHeight * scale) / 2;

  console.log(`[Vectorize] Dimensions: ${svgWidth}x${svgHeight}, scale: ${scale.toFixed(4)}, offset: (${offsetX.toFixed(0)}, ${offsetY.toFixed(0)})`);

  const paths = doc.querySelectorAll('path');
  const shapes: Shape[] = [];
  let shapeCounter = 0;

  paths.forEach((pathEl: Element) => {
    const d = pathEl.getAttribute('d');
    if (!d) return;

    // Color extraction
    let fill = '';
    const pathFill = pathEl.getAttribute('fill');
    if (pathFill && pathFill !== 'none') {
      fill = pathFill;
    } else {
      const style = pathEl.getAttribute('style') || '';
      const fillMatch = style.match(/fill:\s*([^;]+)/);
      if (fillMatch && fillMatch[1] !== 'none') {
        fill = fillMatch[1].trim();
      } else {
        let parent = pathEl.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'svg') {
          const parentFill = parent.getAttribute('fill');
          if (parentFill && parentFill !== 'none') { fill = parentFill; break; }
          const parentStyle = parent.getAttribute('style') || '';
          const parentFillMatch = parentStyle.match(/fill:\s*([^;]+)/);
          if (parentFillMatch && parentFillMatch[1] !== 'none') { fill = parentFillMatch[1].trim(); break; }
          parent = parent.parentElement;
        }
      }
    }

    if (!fill || fill === 'none' || fill === 'transparent') fill = '#000000';

    // Transform
    let transformX = 0;
    let transformY = 0;
    const transformAttr = pathEl.getAttribute('transform');
    if (transformAttr) {
      const translateMatch = transformAttr.match(/translate\(\s*([-+]?\d*\.?\d+)\s*[\s,]\s*([-+]?\d*\.?\d+)\s*\)/i);
      if (translateMatch) {
        transformX = parseFloat(translateMatch[1]);
        transformY = parseFloat(translateMatch[2]);
      }
    }

    // Parse path data
    const tokens = d.match(/([a-zA-Z])|([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/g);
    if (!tokens) return;

    let currentX = 0;
    let currentY = 0;
    let lastCommand = '';
    let currentSubPath: number[] = [];
    const subPaths: number[][] = [];

    function finishSubPath() {
      if (currentSubPath.length >= 4) subPaths.push(currentSubPath);
      currentSubPath = [];
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (/^[a-zA-Z]$/.test(token)) {
        if ((token === 'M' || token === 'm') && currentSubPath.length > 0) finishSubPath();
        lastCommand = token;
        continue;
      }

      switch (lastCommand) {
        case 'M': {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX = x; currentY = y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          lastCommand = 'L';
          break;
        }
        case 'm': {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX += x; currentY += y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          lastCommand = 'l';
          break;
        }
        case 'L': {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX = x; currentY = y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        }
        case 'l': {
          const x = parseFloat(token);
          const y = parseFloat(tokens[++i]);
          currentX += x; currentY += y;
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        }
        case 'H':
          currentX = parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'h':
          currentX += parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'V':
          currentY = parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'v':
          currentY += parseFloat(token);
          currentSubPath.push((currentX + transformX) * scale + offsetX, (currentY + transformY) * scale + offsetY);
          break;
        case 'C': {
          const x1 = parseFloat(token);
          const y1 = parseFloat(tokens[++i]);
          const x2 = parseFloat(tokens[++i]);
          const y2 = parseFloat(tokens[++i]);
          const xf = parseFloat(tokens[++i]);
          const yf = parseFloat(tokens[++i]);
          const sampled = sampleBezier(currentX, currentY, x1, y1, x2, y2, xf, yf, 20);
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push((sampled[j] + transformX) * scale + offsetX, (sampled[j + 1] + transformY) * scale + offsetY);
          }
          currentX = xf; currentY = yf;
          break;
        }
        case 'c': {
          const x1 = currentX + parseFloat(token);
          const y1 = currentY + parseFloat(tokens[++i]);
          const x2 = currentX + parseFloat(tokens[++i]);
          const y2 = currentY + parseFloat(tokens[++i]);
          const xf = currentX + parseFloat(tokens[++i]);
          const yf = currentY + parseFloat(tokens[++i]);
          const sampled = sampleBezier(currentX, currentY, x1, y1, x2, y2, xf, yf, 20);
          for (let j = 0; j < sampled.length; j += 2) {
            currentSubPath.push((sampled[j] + transformX) * scale + offsetX, (sampled[j + 1] + transformY) * scale + offsetY);
          }
          currentX = xf; currentY = yf;
          break;
        }
      }
    }
    finishSubPath();

    // Group subpaths: identify holes vs islands
    interface PathInfo {
      path: number[];
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
      area: number;
      children: PathInfo[];
    }

    const pathInfos: PathInfo[] = subPaths.map(p => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let k = 0; k < p.length; k += 2) {
        if (p[k] < minX) minX = p[k];
        if (p[k] > maxX) maxX = p[k];
        if (p[k + 1] < minY) minY = p[k + 1];
        if (p[k + 1] > maxY) maxY = p[k + 1];
      }
      return { path: p, bounds: { minX, maxX, minY, maxY }, area: (maxX - minX) * (maxY - minY), children: [] };
    });

    pathInfos.sort((a, b) => b.area - a.area);
    const roots: PathInfo[] = [];

    for (const info of pathInfos) {
      let foundGroup = false;
      for (const root of roots) {
        if (
          info.bounds.minX >= root.bounds.minX && info.bounds.maxX <= root.bounds.maxX &&
          info.bounds.minY >= root.bounds.minY && info.bounds.maxY <= root.bounds.maxY
        ) {
          root.children.push(info);
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) roots.push(info);
    }

    for (const root of roots) {
      let combinedPos = [...root.path];
      for (const child of root.children) combinedPos.push(...child.path);

      if (root.children.length === 0) {
        const rect = isRectangle(combinedPos);
        if (rect) {
          shapes.push({
            id: `shape_${shapeCounter++}`,
            type: 'rect',
            pos: [rect.x, rect.y, rect.w, rect.h],
            color: fill,
            filled: true,
            fillAlpha: 1.0,
            strokeWidth: 0,
          });
          return; // continue forEach
        }
      }

      shapes.push({
        id: `shape_${shapeCounter++}`,
        type: 'polygon',
        pos: combinedPos,
        color: fill,
        filled: true,
        fillAlpha: 1.0,
        strokeWidth: 0,
      });
    }
  });

  return shapes;
}

// ─── Get image dimensions via vtracer SVG viewBox or identify ────────────────

function getImageDimensions(inputPath: string): { width: number; height: number } {
  // Try to use `identify` (ImageMagick) or parse from vtracer SVG viewBox
  // We'll get dimensions from the SVG output's viewBox instead
  // As a fallback, try to read PNG/image header
  try {
    const data = fs.readFileSync(inputPath);
    // PNG: bytes 16-23 contain width and height as 4-byte big-endian integers
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      const width = data.readUInt32BE(16);
      const height = data.readUInt32BE(20);
      return { width, height };
    }
    // BMP: bytes 18-21 width, 22-25 height (little-endian)
    if (data[0] === 0x42 && data[1] === 0x4d) {
      const width = data.readUInt32LE(18);
      const height = Math.abs(data.readInt32LE(22));
      return { width, height };
    }
    // JPEG: need to parse markers for SOF
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2;
      while (offset < data.length - 1) {
        if (data[offset] !== 0xff) break;
        const marker = data[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          const height = data.readUInt16BE(offset + 5);
          const width = data.readUInt16BE(offset + 7);
          return { width, height };
        }
        const segLen = data.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
  } catch { /* fall through */ }
  // Fallback: will get from SVG
  return { width: 0, height: 0 };
}

function getDimensionsFromSvg(svgContent: string): { width: number; height: number } {
  const dom = new JSDOM(svgContent, { contentType: 'image/svg+xml' });
  const svgEl = dom.window.document.querySelector('svg');
  if (svgEl) {
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/\s+|,/).map(parseFloat);
      if (parts.length === 4) return { width: parts[2], height: parts[3] };
    }
    const w = parseFloat(svgEl.getAttribute('width') || '0');
    const h = parseFloat(svgEl.getAttribute('height') || '0');
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return { width: 1000, height: 1000 };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/vectorize.ts <input-image>');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const inputDir = path.dirname(inputPath);
  const inputName = path.basename(inputPath, path.extname(inputPath));
  const svgPath = path.join(inputDir, `${inputName}.svg`);
  const jsonPath = path.join(inputDir, `${inputName}.json`);
  const webpPath = path.join(inputDir, `${inputName}.webp`);

  // Step 1: Run vtracer
  console.log(`[Vectorize] Running vtracer on ${inputPath}...`);
  try {
    execSync(
      `vtracer --input "${inputPath}" --output "${svgPath}"` +
      ` --colormode color` +
      ` --hierarchical stacked` +
      ` --filter_speckle 0` +
      ` --color_precision 6` +
      ` --gradient_step 16` +
      ` --mode pixel`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('[Vectorize] vtracer failed. Make sure vtracer is installed and available on PATH.');
    console.error('  Install: cargo install vtracer');
    process.exit(1);
  }

  if (!fs.existsSync(svgPath)) {
    console.error(`[Vectorize] Expected SVG output not found: ${svgPath}`);
    process.exit(1);
  }
  console.log(`[Vectorize] SVG written: ${svgPath}`);

  // Step 2: Get image dimensions
  let dims = getImageDimensions(inputPath);
  const svgContent = fs.readFileSync(svgPath, 'utf-8');
  if (dims.width === 0 || dims.height === 0) {
    dims = getDimensionsFromSvg(svgContent);
  }
  console.log(`[Vectorize] Image dimensions: ${dims.width}x${dims.height}`);

  // Step 3: Parse SVG to shapes
  const shapes = parseSvgToShapes(
    svgContent,
    REGULAR_MAP_WIDTH,
    REGULAR_MAP_CENTER,
    DEFAULT_TARGET_SCALE_PERCENT,
    dims.width,
    dims.height
  );
  console.log(`[Vectorize] Parsed ${shapes.length} shapes`);

  // Step 4: Write JSON
  fs.writeFileSync(jsonPath, JSON.stringify(shapes, null, 2));
  console.log(`[Vectorize] JSON written: ${jsonPath}`);

  // Step 5: Write WebP with embedded drawing data
  const mapName = 'regular';
  const webpBuffer = buildWebpWithDrawingData(shapes, mapName);
  fs.writeFileSync(webpPath, webpBuffer);
  console.log(`[Vectorize] WebP written: ${webpPath} (${webpBuffer.length} bytes, ${shapes.length} shapes embedded)`);

  console.log('[Vectorize] Done!');
}

main();
