import { describe, it, expect } from 'vitest';
import { encodeShapesForUrl, encodeShapesWithInfo, decodeShapesFromUrl, parseDrawingFromUrl } from '../../src/drawing/url-encoder';
import type { Shape } from '../../src/drawing/doodle-integration';

describe('URL Encoder', () => {
  describe('encodeShapesForUrl / decodeShapesFromUrl', () => {
    it('should round-trip simple shapes', () => {
      const shapes: Shape[] = [
        { id: 's1', type: 'point', pos: [100, 200], color: '#ffffff' },
        { id: 's2', type: 'line', pos: [0, 0, 50, 50], color: '#ff0000' },
      ];

      const encoded = encodeShapesForUrl(shapes, 500, 'test_map');
      expect(encoded).not.toBeNull();

      const decoded = decodeShapesFromUrl(encoded!);
      expect(decoded).not.toBeNull();
      expect(decoded!.shapes).toHaveLength(2);
      expect(decoded!.shapes[0].type).toBe('point');
      expect(decoded!.shapes[0].pos).toEqual([100, 200]);
      expect(decoded!.shapes[1].type).toBe('line');
      expect(decoded!.shapes[1].pos).toEqual([0, 0, 50, 50]);
    });

    it('should return null for empty shapes array', () => {
      const encoded = encodeShapesForUrl([], 500);
      expect(encoded).toBeNull();
    });

    it('should preserve map name', () => {
      const shapes: Shape[] = [{ id: 's1', type: 'point', pos: [10, 20], color: '#ffffff' }];
      const encoded = encodeShapesForUrl(shapes, 500, 'my_special_map');
      const decoded = decodeShapesFromUrl(encoded!);
      expect(decoded!.mapName).toBe('my_special_map');
    });
  });

  describe('encodeShapesWithInfo', () => {
    it('should return encoding result with info', () => {
      const shapes: Shape[] = [{ id: 's1', type: 'point', pos: [100, 200], color: '#ffffff' }];

      const result = encodeShapesWithInfo(shapes, 500, 'test');
      expect(result).not.toBeNull();
      expect(result!.encoded).toBeTruthy();
      expect(typeof result!.tolerance).toBe('number');
      expect(typeof result!.simplified).toBe('boolean');
    });

    it('should return null for empty shapes', () => {
      const result = encodeShapesWithInfo([], 500);
      expect(result).toBeNull();
    });
  });

  describe('parseDrawingFromUrl', () => {
    it('should parse drawing from d parameter', () => {
      const shapes: Shape[] = [{ id: 's1', type: 'circle', pos: [100, 100, 50], color: '#22c55e' }];
      const encoded = encodeShapesForUrl(shapes, 500, 'test_map')!;

      const params = new URLSearchParams();
      params.set('d', encoded);

      const result = parseDrawingFromUrl(params);
      expect(result.shapes).not.toBeNull();
      expect(result.shapes!).toHaveLength(1);
      expect(result.shapes![0].type).toBe('circle');
    });

    it('should parse drawing from legacy drawing parameter', () => {
      const shapes: Shape[] = [{ id: 's1', type: 'rect', pos: [50, 50, 100, 100], color: '#3b82f6' }];
      const encoded = encodeShapesForUrl(shapes, 500)!;

      const params = new URLSearchParams();
      params.set('drawing', encoded);

      const result = parseDrawingFromUrl(params);
      expect(result.shapes).not.toBeNull();
      expect(result.shapes![0].type).toBe('rect');
    });

    it('should return null shapes if no drawing param', () => {
      const params = new URLSearchParams();
      const result = parseDrawingFromUrl(params);
      expect(result.shapes).toBeNull();
    });

    it('should parse overlays from o parameter', () => {
      const params = new URLSearchParams();
      params.set('o', 'pw,bi');

      const result = parseDrawingFromUrl(params);
      expect(result.overlays.length).toBeGreaterThan(0);
    });

    it('should return default stroke width if not present', () => {
      const params = new URLSearchParams();
      const result = parseDrawingFromUrl(params);
      expect(result.strokeWidth).toBe(5);
    });
  });

  describe('decodeShapesFromUrl edge cases', () => {
    it('should return null for invalid base64', () => {
      const result = decodeShapesFromUrl('!!!invalid base64!!!');
      expect(result).toBeNull();
    });

    it('should return null for too-short data', () => {
      const result = decodeShapesFromUrl('AAAA'); // 3 bytes when decoded, too short
      expect(result).toBeNull();
    });
  });
});
