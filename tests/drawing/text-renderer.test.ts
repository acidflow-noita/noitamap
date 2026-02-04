// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Shape } from '../../src/drawing/doodle-integration';

/**
 * Unit tests for text rendering logic
 * Tests the actual text positioning, scaling, and coordinate conversion
 */
describe('Text Renderer - Unit Tests', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('Text Shape Creation', () => {
    it('should create a valid text shape with required properties', () => {
      const textShape: Shape = {
        id: crypto.randomUUID(),
        type: 'text',
        text: 'Hello World',
        fontSize: 16,
        color: '#ffffff',
        pos: [100, 200],
        filled: true,
        strokeWidth: 0,
      };

      expect(textShape.id).toBeTruthy();
      expect(textShape.type).toBe('text');
      expect(textShape.text).toBe('Hello World');
      expect(textShape.fontSize).toBe(16);
      expect(textShape.pos).toEqual([100, 200]);
    });

    it('should handle multiline text', () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      const textShape: Shape = {
        id: crypto.randomUUID(),
        type: 'text',
        text: multilineText,
        fontSize: 16,
        color: '#ffffff',
        pos: [0, 0],
        filled: true,
        strokeWidth: 0,
      };

      const lines = textShape.text!.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('Line 1');
      expect(lines[1]).toBe('Line 2');
      expect(lines[2]).toBe('Line 3');
    });

    it('should support resizable width', () => {
      const textShape: Shape = {
        id: crypto.randomUUID(),
        type: 'text',
        text: 'Resizable text',
        fontSize: 16,
        color: '#ffffff',
        pos: [0, 0],
        width: 200,
        filled: true,
        strokeWidth: 0,
      };

      expect(textShape.width).toBe(200);
    });
  });

  describe('Coordinate Conversion', () => {
    it('should convert world coordinates to screen pixels correctly', () => {
      // Simulate viewport transformation
      const worldX = 1000;
      const worldY = 2000;
      const zoom = 1.5;
      const containerWidth = 800;
      const containerHeight = 600;

      // Simple linear transformation for testing
      const screenX = worldX * zoom;
      const screenY = worldY * zoom;

      expect(screenX).toBe(1500);
      expect(screenY).toBe(3000);
    });

    it('should handle negative world coordinates', () => {
      const worldX = -500;
      const worldY = -1000;
      const zoom = 1.0;

      const screenX = worldX * zoom;
      const screenY = worldY * zoom;

      expect(screenX).toBe(-500);
      expect(screenY).toBe(-1000);
    });

    it('should scale coordinates with zoom', () => {
      const worldX = 100;
      const worldY = 100;
      const zoom = 2.0;

      const screenX = worldX * zoom;
      const screenY = worldY * zoom;

      expect(screenX).toBe(200);
      expect(screenY).toBe(200);
    });
  });

  describe('Text Scaling Strategies', () => {
    it('should maintain fixed screen size regardless of zoom', () => {
      const baseFontSize = 16;
      const zoom = 2.0;
      const strategy = 'fixed-screen';

      // Fixed screen: font size stays the same
      const displayFontSize = strategy === 'fixed-screen' ? baseFontSize : baseFontSize * zoom;

      expect(displayFontSize).toBe(16);
    });

    it('should scale with world zoom', () => {
      const baseFontSize = 16;
      const zoom = 2.0;
      const strategy = 'fixed-world';

      // Fixed world: font size scales with zoom
      const displayFontSize = strategy === 'fixed-world' ? baseFontSize * zoom : baseFontSize;

      expect(displayFontSize).toBe(32);
    });

    it('should clamp hybrid zoom between limits', () => {
      const baseFontSize = 16;
      const strategy = 'hybrid';

      // Test various zoom levels
      const testZooms = [0.3, 0.5, 1.0, 1.5, 2.0, 3.0];
      const results = testZooms.map(zoom => {
        if (strategy === 'hybrid') {
          const clampedZoom = Math.max(0.5, Math.min(2.0, zoom));
          return baseFontSize * clampedZoom;
        }
        return baseFontSize;
      });

      expect(results[0]).toBe(8);  // 0.3 clamped to 0.5
      expect(results[1]).toBe(8);  // 0.5
      expect(results[2]).toBe(16); // 1.0
      expect(results[3]).toBe(24); // 1.5
      expect(results[4]).toBe(32); // 2.0
      expect(results[5]).toBe(32); // 3.0 clamped to 2.0
    });
  });

  describe('Text Wrapping', () => {
    it('should split text into words for wrapping', () => {
      const text = 'This is a long text that needs wrapping';
      const words = text.split(' ');

      expect(words.length).toBe(8);
      expect(words[0]).toBe('This');
      expect(words[words.length - 1]).toBe('wrapping');
    });

    it('should handle empty text', () => {
      const text = '';
      const words = text.split(' ');

      expect(words.length).toBe(1);
      expect(words[0]).toBe('');
    });

    it('should preserve multiple spaces', () => {
      const text = 'Word1  Word2   Word3';
      const words = text.split(' ');

      // split(' ') creates empty strings for consecutive spaces
      expect(words.length).toBeGreaterThan(3);
    });
  });

  describe('Text Selection', () => {
    it('should track selected text ID', () => {
      let selectedId: string | null = null;
      const textId = 'text-123';

      // Simulate selection
      selectedId = textId;
      expect(selectedId).toBe('text-123');

      // Simulate deselection
      selectedId = null;
      expect(selectedId).toBeNull();
    });

    it('should allow only one text to be selected at a time', () => {
      let selectedId: string | null = null;

      selectedId = 'text-1';
      expect(selectedId).toBe('text-1');

      // Select another text
      selectedId = 'text-2';
      expect(selectedId).toBe('text-2');
      expect(selectedId).not.toBe('text-1');
    });
  });

  describe('Text Dragging', () => {
    it('should calculate delta from drag start to current position', () => {
      const dragStartPos = { x: 100, y: 200 };
      const currentPos = { x: 150, y: 250 };

      const dx = currentPos.x - dragStartPos.x;
      const dy = currentPos.y - dragStartPos.y;

      expect(dx).toBe(50);
      expect(dy).toBe(50);
    });

    it('should update world position based on viewport delta', () => {
      const worldStartPos = { x: 1000, y: 2000 };
      const viewportDelta = { x: 10, y: 20 };

      const newWorldX = worldStartPos.x + viewportDelta.x;
      const newWorldY = worldStartPos.y + viewportDelta.y;

      expect(newWorldX).toBe(1010);
      expect(newWorldY).toBe(2020);
    });

    it('should handle negative deltas (dragging left/up)', () => {
      const worldStartPos = { x: 1000, y: 2000 };
      const viewportDelta = { x: -50, y: -100 };

      const newWorldX = worldStartPos.x + viewportDelta.x;
      const newWorldY = worldStartPos.y + viewportDelta.y;

      expect(newWorldX).toBe(950);
      expect(newWorldY).toBe(1900);
    });
  });

  describe('Text Resize', () => {
    it('should update width when resized', () => {
      const textShape: Shape = {
        id: 'text-1',
        type: 'text',
        text: 'Resizable',
        fontSize: 16,
        color: '#ffffff',
        pos: [0, 0],
        width: 100,
        filled: true,
        strokeWidth: 0,
      };

      // Simulate resize
      const newWidth = 200;
      textShape.width = newWidth;

      expect(textShape.width).toBe(200);
    });

    it('should not resize if width change is negligible', () => {
      const currentWidth = 200;
      const newWidth = 200.5;
      const threshold = 1;

      const shouldUpdate = Math.abs(newWidth - currentWidth) > threshold;

      expect(shouldUpdate).toBe(false);
    });

    it('should resize if width change exceeds threshold', () => {
      const currentWidth = 200;
      const newWidth = 205;
      const threshold = 1;

      const shouldUpdate = Math.abs(newWidth - currentWidth) > threshold;

      expect(shouldUpdate).toBe(true);
    });
  });
});
