// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isCatboxRef, extractCatboxFileId, createCatboxParam, getCatboxUrl } from '../../src/drawing/catbox';

describe('Catbox Utilities', () => {
  describe('isCatboxRef', () => {
    it('should return true for valid catbox references', () => {
      expect(isCatboxRef('cb:vs77xc')).toBe(true);
      expect(isCatboxRef('cb:abc123')).toBe(true);
      expect(isCatboxRef('cb:a')).toBe(true);
    });

    it('should return false for non-catbox references', () => {
      expect(isCatboxRef('vs77xc')).toBe(false);
      expect(isCatboxRef('catbox:vs77xc')).toBe(false);
      expect(isCatboxRef('')).toBe(false);
      expect(isCatboxRef('CB:vs77xc')).toBe(false); // case sensitive
    });
  });

  describe('extractCatboxFileId', () => {
    it('should extract file ID from valid catbox reference', () => {
      expect(extractCatboxFileId('cb:vs77xc')).toBe('vs77xc');
      expect(extractCatboxFileId('cb:abc123')).toBe('abc123');
      expect(extractCatboxFileId('cb:a1b2c3')).toBe('a1b2c3');
    });

    it('should handle file IDs with underscores and dashes', () => {
      expect(extractCatboxFileId('cb:file_id')).toBe('file_id');
      expect(extractCatboxFileId('cb:file-id')).toBe('file-id');
    });

    it('should strip .webp extension for backward compatibility', () => {
      expect(extractCatboxFileId('cb:vs77xc.webp')).toBe('vs77xc');
      expect(extractCatboxFileId('cb:abc123.WEBP')).toBe('abc123');
    });

    it('should return null for non-catbox references', () => {
      expect(extractCatboxFileId('vs77xc')).toBeNull();
      expect(extractCatboxFileId('catbox:vs77xc')).toBeNull();
      expect(extractCatboxFileId('')).toBeNull();
    });

    it('should return null for invalid file ID characters', () => {
      expect(extractCatboxFileId('cb:file.id')).toBeNull(); // dot in middle
      expect(extractCatboxFileId('cb:file id')).toBeNull(); // space
      expect(extractCatboxFileId('cb:file@id')).toBeNull(); // special char
    });
  });

  describe('createCatboxParam', () => {
    it('should create catbox URL param from file ID', () => {
      expect(createCatboxParam('vs77xc')).toBe('cb:vs77xc');
      expect(createCatboxParam('abc123')).toBe('cb:abc123');
    });
  });

  describe('getCatboxUrl', () => {
    it('should return full catbox URL for file ID', () => {
      expect(getCatboxUrl('vs77xc')).toBe('https://files.catbox.moe/vs77xc.webp');
      expect(getCatboxUrl('abc123')).toBe('https://files.catbox.moe/abc123.webp');
    });
  });

  describe('round-trip', () => {
    it('should round-trip file ID through param creation and extraction', () => {
      const fileId = 'test123';
      const param = createCatboxParam(fileId);
      const extracted = extractCatboxFileId(param);
      expect(extracted).toBe(fileId);
    });
  });
});
