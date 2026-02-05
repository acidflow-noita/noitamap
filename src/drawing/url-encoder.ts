/**
 * URL Encoder - Encode/decode drawings for URL sharing
 *
 * DISABLED: This module is no longer actively used.
 * Drawing sharing now uses catbox.moe image upload with lossless binary data
 * embedded in WebP NOIT RIFF chunks. See catbox.ts and screenshot.ts.
 *
 * Code is kept for reference but not imported anywhere.
 */

import simplify from 'simplify-js';
import type { Shape } from './doodle-integration';
import { overlayToShort, shortToOverlay, mapToShort } from '../data_sources/param-mappings';
import type { MapName } from '../data_sources/tile_data';
import type { OverlayKey } from '../data_sources/overlays';
import { encodeShapesBinary, decodeShapesBinary, base64urlEncode, base64urlDecode } from './binary-encoder';

// Maximum URL length (conservative limit for Discord/social media sharing)
const MAX_URL_LENGTH = 499;

/**
 * Result of encoding shapes for URL
 */
export interface EncodeResult {
  encoded: string;
  tolerance: number; // The simplification tolerance used (1 = original, higher = more simplified)
  simplified: boolean; // True if significant simplification was needed
}

/**
 * Try to encode shapes in binary format within the given character budget.
 * Returns the base64url-encoded string, or null if it doesn't fit.
 */
function tryEncode(shapes: Shape[], maxChars: number, mapName: string = '', strokeWidth: number = 5): string | null {
  const binary = encodeShapesBinary(shapes, mapName, strokeWidth);
  if (!binary) return null;
  const encoded = base64urlEncode(binary);
  return encoded.length <= maxChars ? encoded : null;
}

/**
 * Encode shapes for URL parameter.
 *
 * Uses progressive simplification to fit within URL length limits.
 * NEVER drops shapes - only reduces precision of paths.
 * Returns the encoded string plus info about simplification level.
 */
export function encodeShapesForUrl(shapes: Shape[], maxLength: number = MAX_URL_LENGTH, mapName: string = '', strokeWidth: number = 5): string | null {
  if (!shapes.length) return null;

  const result = encodeShapesWithInfo(shapes, maxLength, mapName, strokeWidth);
  return result?.encoded ?? null;
}

/**
 * Encode shapes with additional info about simplification.
 * Use this when you need to warn the user about precision loss.
 */
export function encodeShapesWithInfo(shapes: Shape[], maxLength: number = MAX_URL_LENGTH, mapName: string = '', strokeWidth: number = 5): EncodeResult | null {
  if (!shapes.length) return null;

  // Budget for the compressed string (reserve space for other URL parts)
  const budget = maxLength - 200;

  // Progressive path simplification - keep going until it fits
  // At very high tolerance, paths become just start+end points (2 coords)
  let tolerance = 1;
  while (tolerance <= 1048576) {
    // Go up to 2^20, should always be enough
    // const simplified = simplifyShapes(shapes, tolerance);
    // const result = tryEncode(simplified, budget);
    const result = tryEncode(shapes, budget, mapName, strokeWidth); // Skip simplification for now
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
  // const maxSimplified = simplifyShapes(shapes, 1048576);
  // const result = tryEncode(maxSimplified, budget);
  const result = tryEncode(shapes, budget, mapName, strokeWidth);
  if (result) {
    return {
      encoded: result,
      tolerance: 1048576,
      simplified: true,
    };
  }

  // This should practically never happen (would need thousands of shapes)
  // But if it does, return the best we can with binary encoding
  console.warn('[URL Encoder] Drawing extremely complex, URL may be truncated');
  const binary = encodeShapesBinary(shapes, mapName, strokeWidth);
  return {
    encoded: binary ? base64urlEncode(binary) : '',
    tolerance: 1048576,
    simplified: true,
  };
}

/**
 * Decode shapes from URL parameter (binary format only)
 * Returns shapes, strokeWidth, and mapName from the encoded data
 */
export function decodeShapesFromUrl(encoded: string): { shapes: Shape[]; strokeWidth: number; mapName?: string } | null {
  try {
    const binary = base64urlDecode(encoded);
    if (binary.length < 9) return null; // Minimum binary format size

    const result = decodeShapesBinary(binary);
    if (result && result.shapes.length > 0) {
      return result;
    }
    return null;
  } catch (e) {
    // Silence expected errors from invalid/corrupted URL data
    return null;
  }
}

/**
 * Simplify path-based shapes to reduce data size
 * Uses adaptive tolerance based on each shape's size
 */
function simplifyShapes(shapes: Shape[], toleranceFactor: number): Shape[] {
  return shapes.map(shape => {
    // Only simplify path-like shapes
    if (shape.type === 'path' || shape.type === 'closed_path' || shape.type === 'polygon') {
      const points = posToPoints(shape.pos);
      if (points.length < 3) return shape; // Need at least 3 points to simplify

      // Calculate shape's bounding box to determine adaptive tolerance
      const shapeSize = getShapeSize(points);
      // Tolerance is a fraction of the shape's size
      // toleranceFactor of 1 = no simplification, 2 = 0.5% of size, 4 = 1%, etc.
      const adaptiveTolerance = toleranceFactor <= 1 ? 0 : (shapeSize * (toleranceFactor - 1)) / 200;

      const simplified = simplify(points, adaptiveTolerance, true);
      return {
        ...shape,
        pos: pointsToPos(simplified),
      };
    }
    return shape;
  });
}

/**
 * Get the size (max dimension) of a shape's bounding box
 */
function getShapeSize(points: Array<{ x: number; y: number }>): number {
  if (points.length === 0) return 0;

  let minX = points[0].x,
    maxX = points[0].x;
  let minY = points[0].y,
    maxY = points[0].y;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return Math.max(maxX - minX, maxY - minY, 1); // At least 1 to avoid division by zero
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
    pos.push(Math.round(point.x), Math.round(point.y));
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
  strokeWidth: number;
  mapName?: string;
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

  const decoded = drawingParam ? decodeShapesFromUrl(drawingParam) : null;
  return {
    shapes: decoded?.shapes ?? null,
    strokeWidth: decoded?.strokeWidth ?? 5,
    mapName: decoded?.mapName,
    overlays,
  };
}
