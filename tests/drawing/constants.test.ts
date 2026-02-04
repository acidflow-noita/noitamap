import { describe, it, expect } from 'vitest';
import {
  COLOR_PALETTE,
  COLOR_TO_INDEX,
  COLOR_NAME_KEYS,
  STROKE_WIDTHS,
  FONT_SIZES,
  TYPE_CODES,
  CODE_TO_TYPE,
} from '../../src/drawing/constants';

describe('Drawing Constants', () => {
  describe('COLOR_PALETTE', () => {
    it('should have exactly 8 colors (3 bits)', () => {
      expect(COLOR_PALETTE).toHaveLength(8);
    });

    it('should contain valid hex color strings', () => {
      for (const color of COLOR_PALETTE) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });

  describe('COLOR_TO_INDEX', () => {
    it('should map every palette color to its index', () => {
      COLOR_PALETTE.forEach((color, i) => {
        expect(COLOR_TO_INDEX[color.toLowerCase()]).toBe(i);
      });
    });

    it('should have same size as palette', () => {
      expect(Object.keys(COLOR_TO_INDEX)).toHaveLength(COLOR_PALETTE.length);
    });
  });

  describe('COLOR_NAME_KEYS', () => {
    it('should have same length as COLOR_PALETTE', () => {
      expect(COLOR_NAME_KEYS).toHaveLength(COLOR_PALETTE.length);
    });

    it('should all be i18n keys starting with drawing.color.', () => {
      for (const key of COLOR_NAME_KEYS) {
        expect(key).toMatch(/^drawing\.color\.\w+$/);
      }
    });
  });

  describe('STROKE_WIDTHS', () => {
    it('should have exactly 4 widths (2 bits)', () => {
      expect(STROKE_WIDTHS).toHaveLength(4);
    });

    it('should be in ascending order', () => {
      for (let i = 1; i < STROKE_WIDTHS.length; i++) {
        expect(STROKE_WIDTHS[i]).toBeGreaterThan(STROKE_WIDTHS[i - 1]);
      }
    });
  });

  describe('FONT_SIZES', () => {
    it('should have exactly 4 sizes (2 bits)', () => {
      expect(FONT_SIZES).toHaveLength(4);
    });

    it('should be in ascending order', () => {
      for (let i = 1; i < FONT_SIZES.length; i++) {
        expect(FONT_SIZES[i]).toBeGreaterThan(FONT_SIZES[i - 1]);
      }
    });
  });

  describe('TYPE_CODES / CODE_TO_TYPE', () => {
    it('should have matching forward and reverse mappings', () => {
      for (const [type, code] of Object.entries(TYPE_CODES)) {
        expect(CODE_TO_TYPE[code]).toBe(type);
      }
    });

    it('should include text type', () => {
      expect(TYPE_CODES['text']).toBeDefined();
      expect(CODE_TO_TYPE[TYPE_CODES['text']]).toBe('text');
    });

    it('should have all codes fit in 4 bits (0-15)', () => {
      for (const code of Object.values(TYPE_CODES)) {
        expect(code).toBeGreaterThanOrEqual(0);
        expect(code).toBeLessThan(16);
      }
    });

    it('should have unique codes', () => {
      const codes = Object.values(TYPE_CODES);
      expect(new Set(codes).size).toBe(codes.length);
    });
  });
});
