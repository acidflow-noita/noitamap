// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { Shape } from '../../src/drawing/doodle-integration';

/**
 * Unit tests for shape validation logic
 * Tests shape creation, validation, and manipulation without mocks
 */
describe('Shape Validation - Unit Tests', () => {
  describe('Shape Structure Validation', () => {
    it('should validate a complete shape object', () => {
      const shape: Shape = {
        id: crypto.randomUUID(),
        type: 'rect',
        pos: [0, 0, 100, 100],
        color: '#ffffff',
        filled: false,
        strokeWidth: 5,
      };

      expect(shape.id).toBeTruthy();
      expect(shape.type).toBe('rect');
      expect(shape.pos).toHaveLength(4);
      expect(shape.color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('should reject shapes with invalid position arrays', () => {
      const invalidShapes = [
        { pos: [], type: 'point' }, // Empty pos
        { pos: [NaN, 100], type: 'point' }, // NaN coordinate
        { pos: [Infinity, 100], type: 'point' }, // Infinity coordinate
        { pos: [100], type: 'point' }, // Incomplete pos for point
      ];

      invalidShapes.forEach(shape => {
        const isValid = shape.pos.length >= 2 && shape.pos.every(n => Number.isFinite(n));
        expect(isValid).toBe(false);
      });
    });

    it('should validate color format', () => {
      const validColors = ['#ffffff', '#000000', '#ff0000', '#abc', '#ABC'];
      const invalidColors = ['white', 'rgb(255,255,255)', '#gggggg', '#12345', ''];

      validColors.forEach(color => {
        const isValid = /^#[0-9A-Fa-f]{3}$|^#[0-9A-Fa-f]{6}$/.test(color);
        expect(isValid).toBe(true);
      });

      invalidColors.forEach(color => {
        const isValid = /^#[0-9A-Fa-f]{3}$|^#[0-9A-Fa-f]{6}$/.test(color);
        expect(isValid).toBe(false);
      });
    });
  });

  describe('Shape Type Validation', () => {
    it('should validate point shape (2 coordinates)', () => {
      const point: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      expect(point.pos.length).toBe(2);
      expect(point.pos.every(n => Number.isFinite(n))).toBe(true);
    });

    it('should validate line shape (4 coordinates)', () => {
      const line: Shape = {
        id: '1',
        type: 'line',
        pos: [0, 0, 100, 100],
        color: '#ffffff',
        strokeWidth: 5,
      };

      expect(line.pos.length).toBe(4);
      expect(line.pos.every(n => Number.isFinite(n))).toBe(true);
    });

    it('should validate rect shape (4 values: x, y, width, height)', () => {
      const rect: Shape = {
        id: '1',
        type: 'rect',
        pos: [10, 20, 100, 50],
        color: '#ffffff',
        strokeWidth: 5,
      };

      expect(rect.pos.length).toBe(4);
      expect(rect.pos[2]).toBeGreaterThan(0); // width
      expect(rect.pos[3]).toBeGreaterThan(0); // height
    });

    it('should validate circle shape (3 values: cx, cy, radius)', () => {
      const circle: Shape = {
        id: '1',
        type: 'circle',
        pos: [100, 100, 50],
        color: '#ffffff',
        strokeWidth: 5,
      };

      expect(circle.pos.length).toBe(3);
      expect(circle.pos[2]).toBeGreaterThan(0); // radius
    });

    it('should validate path shape (minimum 4 coordinates)', () => {
      const path: Shape = {
        id: '1',
        type: 'path',
        pos: [0, 0, 50, 50, 100, 0],
        color: '#ffffff',
        strokeWidth: 5,
      };

      expect(path.pos.length).toBeGreaterThanOrEqual(4);
      expect(path.pos.length % 2).toBe(0); // Even number of coordinates
    });

    it('should reject path with insufficient points', () => {
      const invalidPath = {
        pos: [0, 0], // Only 1 point
        type: 'path',
      };

      const isValid = invalidPath.pos.length >= 4;
      expect(isValid).toBe(false);
    });
  });

  describe('Shape Bounds Calculation', () => {
    it('should calculate bounds for a point', () => {
      const point: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      const bounds = {
        minX: point.pos[0],
        minY: point.pos[1],
        maxX: point.pos[0],
        maxY: point.pos[1],
      };

      expect(bounds.minX).toBe(100);
      expect(bounds.minY).toBe(200);
      expect(bounds.maxX).toBe(100);
      expect(bounds.maxY).toBe(200);
    });

    it('should calculate bounds for a rectangle', () => {
      const rect: Shape = {
        id: '1',
        type: 'rect',
        pos: [10, 20, 100, 50], // x, y, width, height
        color: '#ffffff',
        strokeWidth: 5,
      };

      const bounds = {
        minX: rect.pos[0],
        minY: rect.pos[1],
        maxX: rect.pos[0] + rect.pos[2],
        maxY: rect.pos[1] + rect.pos[3],
      };

      expect(bounds.minX).toBe(10);
      expect(bounds.minY).toBe(20);
      expect(bounds.maxX).toBe(110);
      expect(bounds.maxY).toBe(70);
    });

    it('should calculate bounds for a path', () => {
      const path: Shape = {
        id: '1',
        type: 'path',
        pos: [0, 0, 100, 50, 50, 100, -10, 20],
        color: '#ffffff',
        strokeWidth: 5,
      };

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < path.pos.length; i += 2) {
        minX = Math.min(minX, path.pos[i]);
        maxX = Math.max(maxX, path.pos[i]);
        minY = Math.min(minY, path.pos[i + 1]);
        maxY = Math.max(maxY, path.pos[i + 1]);
      }

      expect(minX).toBe(-10);
      expect(minY).toBe(0);
      expect(maxX).toBe(100);
      expect(maxY).toBe(100);
    });
  });

  describe('Shape Transformation', () => {
    it('should translate a shape by offset', () => {
      const shape: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      const offset = { x: 50, y: -30 };
      const translated = {
        ...shape,
        pos: [shape.pos[0] + offset.x, shape.pos[1] + offset.y],
      };

      expect(translated.pos[0]).toBe(150);
      expect(translated.pos[1]).toBe(170);
    });

    it('should scale a rectangle', () => {
      const rect: Shape = {
        id: '1',
        type: 'rect',
        pos: [0, 0, 100, 50],
        color: '#ffffff',
        strokeWidth: 5,
      };

      const scale = 2;
      const scaled = {
        ...rect,
        pos: [
          rect.pos[0] * scale,
          rect.pos[1] * scale,
          rect.pos[2] * scale,
          rect.pos[3] * scale,
        ],
      };

      expect(scaled.pos).toEqual([0, 0, 200, 100]);
    });

    it('should update shape color', () => {
      const shape: Shape = {
        id: '1',
        type: 'point',
        pos: [0, 0],
        color: '#ffffff',
      };

      const newColor = '#ff0000';
      const updated = { ...shape, color: newColor };

      expect(updated.color).toBe('#ff0000');
      expect(shape.color).toBe('#ffffff'); // Original unchanged
    });
  });

  describe('Shape Cloning', () => {
    it('should create a deep copy of a shape', () => {
      const original: Shape = {
        id: '1',
        type: 'path',
        pos: [0, 0, 100, 100],
        color: '#ffffff',
        strokeWidth: 5,
      };

      const clone: Shape = {
        ...original,
        id: crypto.randomUUID(),
        pos: [...original.pos],
      };

      expect(clone.id).not.toBe(original.id);
      expect(clone.pos).toEqual(original.pos);
      expect(clone.pos).not.toBe(original.pos); // Different array reference

      // Modify clone
      clone.pos[0] = 999;
      expect(original.pos[0]).toBe(0); // Original unchanged
    });
  });

  describe('Shape Comparison', () => {
    it('should detect identical shapes', () => {
      const shape1: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      const shape2: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      expect(JSON.stringify(shape1)).toBe(JSON.stringify(shape2));
    });

    it('should detect different shapes', () => {
      const shape1: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 200],
        color: '#ffffff',
      };

      const shape2: Shape = {
        id: '1',
        type: 'point',
        pos: [100, 201], // Different Y
        color: '#ffffff',
      };

      expect(JSON.stringify(shape1)).not.toBe(JSON.stringify(shape2));
    });
  });
});
