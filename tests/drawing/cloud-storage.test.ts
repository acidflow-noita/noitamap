// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isCloudRef, getCloudUrl } from '../../src/drawing/cloud-storage';

describe('Cloud Storage Utilities', () => {
  describe('isCloudRef', () => {
    it('should return true for valid primary (catbox) references', () => {
      expect(isCloudRef('cb:vs77xc')).toBe(true);
      expect(isCloudRef('cb:abc123')).toBe(true);
    });

    it('should return true for valid fallback (qu.ax) references', () => {
      expect(isCloudRef('qx:abc.webp')).toBe(true);
      expect(isCloudRef('qx:xyz123')).toBe(true);
    });

    it('should return true for legacy fallback (0x0) references', () => {
      expect(isCloudRef('0x0:abc.webp')).toBe(true);
      expect(isCloudRef('0x0:xyz123')).toBe(true);
    });

    it('should return false for unknown references', () => {
      expect(isCloudRef('vs77xc')).toBe(false);
      expect(isCloudRef('cloud:vs77xc')).toBe(false);
      expect(isCloudRef('')).toBe(false);
      expect(isCloudRef('CB:vs77xc')).toBe(false);
    });
  });

  describe('getCloudUrl', () => {
    it('should return full primary URL for primary param', () => {
      expect(getCloudUrl('cb:vs77xc')).toBe('https://files.catbox.moe/vs77xc.webp');
      expect(getCloudUrl('cb:abc123')).toBe('https://files.catbox.moe/abc123.webp');
    });

    it('should strip .webp from primary param if present (backward compat)', () => {
        expect(getCloudUrl('cb:vs77xc.webp')).toBe('https://files.catbox.moe/vs77xc.webp');
    });

    it('should return full fallback URL for fallback param', () => {
      expect(getCloudUrl('qx:abc.webp')).toBe('https://qu.ax/abc.webp');
      expect(getCloudUrl('qx:xyz123')).toBe('https://qu.ax/xyz123');
    });

    it('should map legacy 0x0 param to current fallback URL', () => {
      expect(getCloudUrl('0x0:abc.webp')).toBe('https://qu.ax/abc.webp');
      expect(getCloudUrl('0x0:xyz123')).toBe('https://qu.ax/xyz123');
    });

    it('should return null for unknown params', () => {
      expect(getCloudUrl('unknown:123')).toBeNull();
      expect(getCloudUrl('')).toBeNull();
    });
  });
});
