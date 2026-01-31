/**
 * URL Encoder - Encode/decode drawings for URL sharing
 *
 * Uses LZ-string compression and progressive simplification
 * to keep URLs under the maximum length limit.
 */

import LZString from 'lz-string';
import simplify from 'simplify-js';
import type { Shape } from './doodle-integration';
import { overlayToShort, shortToOverlay, mapToShort } from '../data_sources/param-mappings';
import type { MapName } from '../data_sources/tile_data';
import type { OverlayKey } from '../data_sources/overlays';

// Maximum URL length (conservative limit for Discord/social media sharing)
const MAX_URL_LENGTH = 2000;

// Compact shape format for URL encoding
interface CompactShape {
  t: string; // type
  c: string; // color
  p: number[]; // positions (delta encoded for paths)
}

/**
 * Result of encoding shapes for URL
 */
export interface EncodeResult {
  encoded: string;
  tolerance: number; // The simplification tolerance used (1 = original, higher = more simplified)
  simplified: boolean; // True if significant simplification was needed
}

/**
 * Try to compress shapes within the given character budget.
 * Returns the compressed string, or null if it doesn't fit.
 */
function tryEncode(shapes: Shape[], maxChars: number): string | null {
  const compact = toCompactFormat(shapes);
  const json = JSON.stringify(compact);
  const compressed = LZString.compressToEncodedURIComponent(json);
  return compressed.length < maxChars ? compressed : null;
}

/**
 * Encode shapes for URL parameter.
 *
 * Uses progressive simplification to fit within URL length limits.
 * NEVER drops shapes - only reduces precision of paths.
 * Returns the encoded string plus info about simplification level.
 */
export function encodeShapesForUrl(shapes: Shape[], maxLength: number = MAX_URL_LENGTH): string | null {
  if (!shapes.length) return null;

  const result = encodeShapesWithInfo(shapes, maxLength);
  return result?.encoded ?? null;
}

/**
 * Encode shapes with additional info about simplification.
 * Use this when you need to warn the user about precision loss.
 */
export function encodeShapesWithInfo(shapes: Shape[], maxLength: number = MAX_URL_LENGTH): EncodeResult | null {
  if (!shapes.length) return null;

  // Budget for the compressed string (reserve space for other URL parts)
  const budget = maxLength - 200;

  // Progressive path simplification - keep going until it fits
  // At very high tolerance, paths become just start+end points (2 coords)
  let tolerance = 1;
  while (tolerance <= 1048576) {
    // Go up to 2^20, should always be enough
    const simplified = simplifyShapes(shapes, tolerance);
    const result = tryEncode(simplified, budget);
    if (result) {
      return {
        encoded: result,
        tolerance,
        simplified: tolerance > 1, // Warn on any simplification
      };
    }
    tolerance *= 2;
  }

  // Last resort: maximum simplification (paths become straight lines)
  const maxSimplified = simplifyShapes(shapes, 1048576);
  const result = tryEncode(maxSimplified, budget);
  if (result) {
    return {
      encoded: result,
      tolerance: 1048576,
      simplified: true,
    };
  }

  // This should practically never happen (would need thousands of shapes)
  // But if it does, return the best we can
  console.warn('[URL Encoder] Drawing extremely complex, URL may be truncated');
  const compact = toCompactFormat(maxSimplified);
  const json = JSON.stringify(compact);
  return {
    encoded: LZString.compressToEncodedURIComponent(json),
    tolerance: 1048576,
    simplified: true,
  };
}

/**
 * Decode shapes from URL parameter
 */
export function decodeShapesFromUrl(encoded: string): Shape[] | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;

    const compact: CompactShape[] = JSON.parse(json);
    return fromCompactFormat(compact);
  } catch (e) {
    console.error('Failed to decode drawing from URL:', e);
    return null;
  }
}

/**
 * Simplify path-based shapes to reduce data size
 */
function simplifyShapes(shapes: Shape[], tolerance: number): Shape[] {
  return shapes.map(shape => {
    // Only simplify path-like shapes
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      const points = posToPoints(shape.pos);
      const simplified = simplify(points, tolerance, true);
      return {
        ...shape,
        pos: pointsToPos(simplified),
      };
    }
    return shape;
  });
}

/**
 * Convert pos array to point objects for simplify-js
 */
function posToPoints(pos: number[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pos.length; i += 2) {
    points.push({ x: pos[i], y: pos[i + 1] });
  }
  return points;
}

/**
 * Convert point objects back to pos array
 */
function pointsToPos(points: Array<{ x: number; y: number }>): number[] {
  const pos: number[] = [];
  for (const point of points) {
    // Round to reduce decimal precision in JSON
    pos.push(Math.round(point.x), Math.round(point.y));
  }
  return pos;
}

/**
 * Convert shapes to compact format with delta encoding
 */
function toCompactFormat(shapes: Shape[]): CompactShape[] {
  return shapes.map(shape => {
    let pos = shape.pos;

    // Delta encode path coordinates for better compression
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      pos = deltaEncode(shape.pos);
    } else {
      // Round non-path coordinates
      pos = shape.pos.map(v => Math.round(v));
    }

    return {
      t: shape.type,
      c: shape.color,
      p: pos,
    };
  });
}

/**
 * Convert compact format back to shapes
 */
function fromCompactFormat(compact: CompactShape[]): Shape[] {
  return compact.map((c, index) => {
    let pos = c.p;

    // Delta decode path coordinates
    if (c.t === 'path' || c.t === 'closed_path' || c.t === 'polygon') {
      pos = deltaDecode(c.p);
    }

    return {
      id: crypto.randomUUID(),
      type: c.t as Shape['type'],
      color: c.c,
      pos,
    };
  });
}

/**
 * Delta encode coordinates: store first point absolute, rest as deltas
 */
function deltaEncode(pos: number[]): number[] {
  if (pos.length < 2) return pos;

  const encoded = [Math.round(pos[0]), Math.round(pos[1])];
  for (let i = 2; i < pos.length; i += 2) {
    encoded.push(Math.round(pos[i] - pos[i - 2]));
    encoded.push(Math.round(pos[i + 1] - pos[i - 1]));
  }
  return encoded;
}

/**
 * Delta decode coordinates
 */
function deltaDecode(encoded: number[]): number[] {
  if (encoded.length < 2) return encoded;

  const pos = [encoded[0], encoded[1]];
  for (let i = 2; i < encoded.length; i += 2) {
    pos.push(pos[pos.length - 2] + encoded[i]);
    pos.push(pos[pos.length - 2] + encoded[i + 1]);
  }
  return pos;
}

/**
 * Build a complete shareable URL with drawing data
 */
export function buildShareUrlWithDrawing(
  baseUrl: string,
  shapes: Shape[],
  viewport: { x: number; y: number; zoom: number },
  mapName: string,
  overlays?: string[]
): string {
  const url = new URL(baseUrl);

  // Use short param names
  url.searchParams.set('x', Math.round(viewport.x).toString());
  url.searchParams.set('y', Math.round(viewport.y).toString());
  url.searchParams.set('z', Math.round(viewport.zoom).toString());
  url.searchParams.set('m', mapToShort(mapName as MapName));

  // Add overlays with short values
  if (overlays && overlays.length > 0) {
    const shortOverlays = overlays.map(o => overlayToShort(o as OverlayKey));
    url.searchParams.set('o', shortOverlays.join(','));
  }

  // Calculate remaining space for drawing data
  const baseLength = url.toString().length;
  const availableLength = MAX_URL_LENGTH - baseLength - 4; // 4 chars buffer for "&d="

  // Add drawing if shapes exist and fit
  if (shapes.length > 0) {
    const encoded = encodeShapesForUrl(shapes, availableLength);
    if (encoded) {
      url.searchParams.set('d', encoded);
    }
  }

  return url.toString();
}

/**
 * Parse drawing from URL search params
 */
export function parseDrawingFromUrl(searchParams: URLSearchParams): {
  shapes: Shape[] | null;
  overlays: string[];
} {
  const drawingParam = searchParams.get('d') ?? searchParams.get('drawing');
  const overlaysParam = searchParams.get('o') ?? searchParams.get('overlays');

  // Decode overlay short codes back to full names
  const overlays: string[] = [];
  if (overlaysParam) {
    for (const code of overlaysParam.split(',').filter(Boolean)) {
      const full = shortToOverlay(code);
      overlays.push(full ?? code);
    }
  }

  return {
    shapes: drawingParam ? decodeShapesFromUrl(drawingParam) : null,
    overlays,
  };
}
