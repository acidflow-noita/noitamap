import { createCanvas, ImageData } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { LiquidSnapshot } from '../src/liquids/snapshot';
import { LIQUID_MAX_FRAME_PIXELS } from '../src/liquids/geometry';

function fixture() {
  const source = createCanvas(160, 120), context = source.getContext('2d');
  const pixels = context.createImageData(source.width, source.height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++)
    pixels.data.set([x, y, (x + y) % 255, 255], (y * source.width + x) * 4);
  context.putImageData(pixels, 0, 0);
  const canvases: typeof source[] = [];
  const create = vi.fn(() => { const canvas = createCanvas(1, 1); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; });
  const bitmap = vi.fn(async (canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ImageBitmap> => ({ width: canvas.width, height: canvas.height,
    pixels: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.slice(), close: vi.fn(),
  }) as unknown as ImageBitmap);
  const capture = new LiquidSnapshot(create, bitmap);
  return { source: source as unknown as HTMLCanvasElement, context, create, bitmap, capture, canvases };
}

describe('standalone liquid snapshot crops', () => {
  it('resizes a frozen crop without rotating its axes or retaining a large scratch surface', async () => {
    const f = fixture();
    const result = await f.capture.capture(f.source, 40, 20, 80, 60, 40, 20);
    expect([result.width, result.height]).toEqual([40, 20]);
    const pixels = (result as any).pixels;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      const at = (y * 40 + x) * 4;
      expect(pixels[at]).toBeGreaterThanOrEqual(40 + x * 2);
      expect(pixels[at]).toBeLessThan(42 + x * 2);
      expect(pixels[at + 1]).toBeGreaterThanOrEqual(20 + y * 3);
      expect(pixels[at + 1]).toBeLessThan(23 + y * 3);
    }
    expect(f.canvases[0].width * f.canvases[0].height).toBe(800);
    result.close(); f.capture.destroy();
  });
  it('materializes nonzero source offsets and captures the entire correctly sized surface', async () => {
    const f = fixture();
    for (const [x, y, width, height] of [[37, 21, 43, 29], [0, 3, 160, 117], [139, 97, 21, 23], [2, 4, 43, 29]]) {
      const result = await f.capture.capture(f.source, x, y, width, height);
      expect([result.width, result.height]).toEqual([width, height]);
      expect((result as any).pixels).toEqual(f.context.getImageData(x, y, width, height).data);
      const call = f.bitmap.mock.calls.at(-1)!;
      expect(call).toHaveLength(1); // No ImageBitmap crop view backed by the large source.
      expect(call[0]).not.toBe(f.source);
      expect([call[0].width, call[0].height]).toEqual([width, height]);
      result.close();
    }
    expect(f.create).toHaveBeenCalledOnce();
    f.capture.destroy(); expect(f.canvases[0].width * f.canvases[0].height).toBe(1);
  });
  it('replaces transparent pixels when reusing a same-sized scratch surface', async () => {
    const f = fixture();
    (await f.capture.capture(f.source, 0, 0, 20, 10)).close();
    f.context.putImageData(new ImageData(new Uint8ClampedArray(20 * 10 * 4), 20, 10), 0, 0);
    const blank = await f.capture.capture(f.source, 0, 0, 20, 10);
    expect((blank as any).pixels.some(Boolean)).toBe(false);
    blank.close(); f.capture.destroy();
  });
  it('rejects invalid crops before allocating or copying and bounds retained memory', async () => {
    const f = fixture();
    for (const crop of [[-1, 0, 4, 4], [0, 0, 0, 4], [0, 0, 161, 120], [0, 0, 10, 121], [0, 0, 4.5, 4], [NaN, 0, 4, 4]])
      await expect(f.capture.capture(f.source, ...crop as [number, number, number, number])).rejects.toThrow('crop');
    const huge = { width: 4096, height: 4096 } as HTMLCanvasElement;
    await expect(f.capture.capture(huge, 0, 0, 4096, LIQUID_MAX_FRAME_PIXELS / 4096 + 1)).rejects.toThrow('crop');
    expect(f.create).not.toHaveBeenCalled(); expect(f.bitmap).not.toHaveBeenCalled(); f.capture.destroy();
  });
  it('does not reuse a surface before the bitmap settles and closes late results after disposal', async () => {
    const f = fixture(); let finish!: (image: ImageBitmap) => void;
    f.bitmap.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.capture.capture(f.source, 0, 0, 20, 10);
    await expect(f.capture.capture(f.source, 20, 0, 40, 10)).rejects.toThrow('already');
    f.capture.destroy();
    const late = { width: 20, height: 10, close: vi.fn() } as unknown as ImageBitmap;
    finish(late); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(late.close).toHaveBeenCalledOnce();
    await expect(f.capture.capture(f.source, 0, 0, 20, 10)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('closes incorrectly sized bitmaps rather than forwarding them to a smaller texture', async () => {
    const f = fixture(), close = vi.fn();
    f.bitmap.mockResolvedValueOnce({ width: 160, height: 120, close } as unknown as ImageBitmap);
    await expect(f.capture.capture(f.source, 37, 21, 43, 29)).rejects.toThrow('dimensions');
    expect(close).toHaveBeenCalledOnce(); f.capture.destroy();
  });
});
