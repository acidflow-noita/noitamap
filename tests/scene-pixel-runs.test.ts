import { describe, expect, it } from 'vitest';
import { encodeScenePixelRuns, decodeScenePixelRuns } from '../src/telescope/scene-pixel-runs';
import { encodeScenePack, decodeScenePack } from '../src/telescope/scene-pack';

describe('prepared material pixels', () => {
  it.each([Uint8Array, Uint8ClampedArray])('preserves exact bytes and ownership for %s', ArrayType => {
    for (const pixels of [
      new ArrayType(4096).fill(123),
      new ArrayType(Uint8Array.from({ length: 4096 }, (_, i) => (i * 173 + Math.floor(i / 7)) & 255)),
      new ArrayType([12, 34, 56, 0, 255, 255, 255, 255, 0, 0, 66, 255, 128, 1, 0, 2]),
    ]) {
      const before = pixels.slice();
      const record = encodeScenePixelRuns(pixels, pixels.length / 4, 1);
      const output = decodeScenePixelRuns(record);
      expect(output).toEqual(before);
      expect(output).toBeInstanceOf(ArrayType);
      expect(output.buffer).not.toBe(pixels.buffer);
      output.fill(0);
      expect(pixels).toEqual(before);
      expect(decodeScenePixelRuns(record)).toEqual(before);
    }
  });

  it('keeps flat scenes compressed inside the ordinary scene pack until selected', () => {
    const pixels = new Uint8Array(512 * 512 * 4);
    new Uint32Array(pixels.buffer).fill(0xff420000);
    const runs = encodeScenePixelRuns(pixels, 512, 512);
    expect(runs.encoding).toBe('runs');
    expect(runs.bytes.length).toBe(8);
    const pack = encodeScenePack({ version: 1, fullPixels: true,
      data: { room: runs }, spawns: { room: [] } }, 'revision');
    const restored = decodeScenePack(pack.buffer as ArrayBuffer, 'revision');
    expect(restored.data.room.bytes.length).toBe(8);
    expect(decodeScenePixelRuns(restored.data.room)).toEqual(pixels);
  });

  it('handles unaligned views and very short/noisy images without expanding runs', () => {
    const raw = Uint8Array.from({ length: 41 }, (_, i) => i * 3);
    const pixels = raw.subarray(1);
    const record = encodeScenePixelRuns(pixels, 10, 1);
    expect(record.encoding).toBe('rgba');
    expect(decodeScenePixelRuns(record)).toEqual(pixels);
  });

  it.each(['short', 'zero', 'long', 'incomplete', 'encoding', 'dimensions'])('rejects %s corruption', corruption => {
    const record = encodeScenePixelRuns(new Uint8Array(1024).fill(5), 16, 16);
    const words = new DataView(record.bytes.buffer);
    if (corruption === 'short') record.bytes = record.bytes.slice(1);
    else if (corruption === 'zero') words.setUint32(0, 0, true);
    else if (corruption === 'long') words.setUint32(0, 0xffffffff, true);
    else if (corruption === 'incomplete') words.setUint32(0, 2, true);
    else if (corruption === 'encoding') (record as any).encoding = 'unknown';
    else record.width = -1;
    expect(() => decodeScenePixelRuns(record)).toThrow();
  });
});
