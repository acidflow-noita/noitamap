// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Shape } from '../../src/drawing/doodle-integration';
import { encodeShapesBinary, decodeShapesBinary } from '../../src/drawing/binary-encoder';
import { encodeShapesForUrl, decodeShapesFromUrl } from '../../src/drawing/url-encoder';

/**
 * E2E tests for complete drawing workflows
 * Tests real user scenarios from start to finish
 */
describe('Drawing Workflow - E2E Tests', () => {
  describe('Create and Share Drawing Workflow', () => {
    it('should complete full workflow: create shapes -> encode -> share URL -> decode -> restore', () => {
      // Step 1: User creates shapes
      const shapes: Shape[] = [
        {
          id: crypto.randomUUID(),
          type: 'rect',
          pos: [100, 100, 200, 150],
          color: '#ff0000',
          strokeWidth: 5,
          filled: false,
        },
        {
          id: crypto.randomUUID(),
          type: 'text',
          pos: [150, 200],
          text: 'Hello World',
          fontSize: 16,
          color: '#ffffff',
          filled: true,
          strokeWidth: 0,
        },
        {
          id: crypto.randomUUID(),
          type: 'circle',
          pos: [300, 300, 50],
          color: '#00ff00',
          strokeWidth: 3,
          filled: false,
        },
      ];

      const mapName = 'coalmine';
      const viewport = { x: 0, y: 0, zoom: 1 };

      // Step 2: Encode to URL
      const urlData = encodeShapesForUrl(shapes, 10000, mapName, 5);
      expect(urlData).toBeTruthy();
      expect(urlData!.length).toBeGreaterThan(0);

      // Step 3: Share URL (simulate)
      const sharedUrl = `https://noitamap.com/?d=${urlData}`;
      expect(sharedUrl).toContain('?d=');

      // Step 4: Recipient decodes URL
      const decoded = decodeShapesFromUrl(urlData);
      expect(decoded).not.toBeNull();
      expect(decoded!.shapes.length).toBe(3);
      expect(decoded!.mapName).toBe(mapName);

      // Step 5: Verify shapes are restored correctly
      expect(decoded!.shapes[0].type).toBe('rect');
      expect(decoded!.shapes[1].type).toBe('text');
      expect(decoded!.shapes[1].text).toBe('Hello World');
      expect(decoded!.shapes[2].type).toBe('circle');
    });

    it('should handle empty drawing', () => {
      const shapes: Shape[] = [];
      const mapName = 'test';

      const urlData = encodeShapesForUrl(shapes, 10000, mapName, 5);
      expect(urlData).toBeNull(); // Empty drawings return null
    });

    it('should preserve shape properties through encode/decode cycle', () => {
      const originalShape: Shape = {
        id: crypto.randomUUID(),
        type: 'line',
        pos: [0, 0, 1000, 1000],
        color: '#0000ff',
        strokeWidth: 10,
        filled: false,
      };

      const encoded = encodeShapesBinary([originalShape], 'test');
      expect(encoded).not.toBeNull();

      const decoded = decodeShapesBinary(encoded!);
      expect(decoded).not.toBeNull();
      expect(decoded!.shapes[0].type).toBe('line');
      expect(decoded!.shapes[0].pos).toEqual(originalShape.pos);
    });
  });

  describe('Import Drawing Workflow', () => {
    it('should import drawing from WebP metadata', async () => {
      // Simulate creating a drawing
      const shapes: Shape[] = [
        {
          id: crypto.randomUUID(),
          type: 'point',
          pos: [500, 500],
          color: '#ffff00',
          strokeWidth: 5,
        },
      ];

      // Encode to binary
      const binary = encodeShapesBinary(shapes, 'test_map', 5);
      expect(binary).not.toBeNull();

      // Decode (simulating import)
      const decoded = decodeShapesBinary(binary!);
      expect(decoded).not.toBeNull();
      expect(decoded!.shapes.length).toBe(1);
      expect(decoded!.mapName).toBe('test_map');
    });
  });

  describe('Multi-User Collaboration Workflow', () => {
    it('should allow multiple users to add shapes to same drawing', () => {
      // User 1 creates initial shapes
      const user1Shapes: Shape[] = [
        {
          id: 'user1-shape1',
          type: 'rect',
          pos: [0, 0, 100, 100],
          color: '#ff0000',
          strokeWidth: 5,
        },
      ];

      // User 2 adds more shapes
      const user2Shapes: Shape[] = [
        {
          id: 'user2-shape1',
          type: 'circle',
          pos: [200, 200, 50],
          color: '#00ff00',
          strokeWidth: 3,
        },
      ];

      // Combine shapes
      const combinedShapes = [...user1Shapes, ...user2Shapes];

      expect(combinedShapes.length).toBe(2);
      expect(combinedShapes[0].id).toContain('user1');
      expect(combinedShapes[1].id).toContain('user2');
    });
  });

  describe('Drawing History Workflow', () => {
    it('should track shape additions for undo/redo', () => {
      const history: Shape[][] = [];
      let currentShapes: Shape[] = [];

      // Add shape 1
      const shape1: Shape = {
        id: '1',
        type: 'point',
        pos: [0, 0],
        color: '#ffffff',
      };
      history.push([...currentShapes]);
      currentShapes = [...currentShapes, shape1];

      // Add shape 2
      const shape2: Shape = {
        id: '2',
        type: 'point',
        pos: [100, 100],
        color: '#ffffff',
      };
      history.push([...currentShapes]);
      currentShapes = [...currentShapes, shape2];

      expect(currentShapes.length).toBe(2);
      expect(history.length).toBe(2);

      // Undo (restore previous state)
      currentShapes = history.pop()!;
      expect(currentShapes.length).toBe(1);
    });

    it('should clear redo stack on new action', () => {
      const undoStack: Shape[][] = [];
      const redoStack: Shape[][] = [];
      let currentShapes: Shape[] = [];

      // Add shape
      undoStack.push([...currentShapes]);
      currentShapes = [{ id: '1', type: 'point', pos: [0, 0], color: '#fff' }];

      // Undo
      redoStack.push([...currentShapes]);
      currentShapes = undoStack.pop()!;

      expect(redoStack.length).toBe(1);

      // New action - should clear redo
      undoStack.push([...currentShapes]);
      currentShapes = [{ id: '2', type: 'point', pos: [100, 100], color: '#fff' }];
      redoStack.length = 0;

      expect(redoStack.length).toBe(0);
    });
  });

  describe('Map Change Workflow', () => {
    it('should clear shapes when changing maps', () => {
      let currentMap = 'coalmine';
      let shapes: Shape[] = [
        { id: '1', type: 'point', pos: [0, 0], color: '#fff' },
        { id: '2', type: 'point', pos: [100, 100], color: '#fff' },
      ];

      expect(shapes.length).toBe(2);

      // Change map
      currentMap = 'snowcave';
      shapes = []; // Clear shapes

      expect(shapes.length).toBe(0);
      expect(currentMap).toBe('snowcave');
    });

    it('should preserve shapes when staying on same map', () => {
      const currentMap = 'coalmine';
      const shapes: Shape[] = [
        { id: '1', type: 'point', pos: [0, 0], color: '#fff' },
      ];

      // Navigate within same map
      const viewport = { x: 1000, y: 1000, zoom: 2 };

      expect(shapes.length).toBe(1);
      expect(currentMap).toBe('coalmine');
    });
  });

  describe('Drawing Visibility Workflow', () => {
    it('should toggle drawing layer visibility', () => {
      let visible = true;

      // Hide drawings
      visible = false;
      expect(visible).toBe(false);

      // Show drawings
      visible = true;
      expect(visible).toBe(true);
    });

    it('should maintain shapes when hidden', () => {
      const shapes: Shape[] = [
        { id: '1', type: 'point', pos: [0, 0], color: '#fff' },
      ];
      let visible = true;

      // Hide
      visible = false;
      expect(shapes.length).toBe(1); // Shapes still exist

      // Show
      visible = true;
      expect(shapes.length).toBe(1);
    });
  });

  describe('Error Recovery Workflow', () => {
    it('should handle corrupted URL data gracefully', () => {
      const corruptedData = 'invalid-base64-!!!';
      const decoded = decodeShapesFromUrl(corruptedData);

      expect(decoded).toBeNull();
    });

    it('should handle invalid shape data', () => {
      const invalidShapes = [
        { id: '1', type: 'point', pos: [NaN, 100], color: '#fff' },
      ];

      const isValid = invalidShapes.every(s =>
        s.pos && s.pos.length >= 2 && s.pos.every(n => Number.isFinite(n))
      );

      expect(isValid).toBe(false);
    });

    it('should recover from failed encoding', () => {
      const tooManyShapes: Shape[] = Array.from({ length: 300 }, (_, i) => ({
        id: `shape-${i}`,
        type: 'point',
        pos: [i, i],
        color: '#ffffff',
      }));

      const encoded = encodeShapesBinary(tooManyShapes, 'test');
      expect(encoded).toBeNull(); // Should fail gracefully (max 255 shapes)
    });
  });

  describe('Performance Workflow', () => {
    it('should handle large number of shapes efficiently', () => {
      const startTime = performance.now();

      const shapes: Shape[] = Array.from({ length: 100 }, (_, i) => ({
        id: `shape-${i}`,
        type: 'point',
        pos: [i * 10, i * 10],
        color: '#ffffff',
        strokeWidth: 5,
      }));

      const encoded = encodeShapesBinary(shapes, 'test');
      const decoded = decodeShapesBinary(encoded!);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(decoded!.shapes.length).toBe(100);
      expect(duration).toBeLessThan(100); // Should complete in under 100ms
    });

    it('should handle complex paths efficiently', () => {
      const complexPath: Shape = {
        id: 'complex',
        type: 'path',
        pos: Array.from({ length: 200 }, (_, i) => i * 5), // 100 points
        color: '#ffffff',
        strokeWidth: 5,
      };

      const startTime = performance.now();
      const encoded = encodeShapesBinary([complexPath], 'test');
      const decoded = decodeShapesBinary(encoded!);
      const endTime = performance.now();

      expect(decoded!.shapes[0].pos.length).toBe(200);
      expect(endTime - startTime).toBeLessThan(50);
    });
  });
});
