import { describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createSceneBitmapProvider, type CompressedSceneBitmap } from '../src/telescope/scene-bitmap-provider';

function image(width = 384, height = 300) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  const pixels = context.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels.data.set([x % 251, y % 241, (x * 31 + y * 7) % 239, x % 19 < 6 ? 0 : 255], i);
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}
function decoder() {
  const bitmaps: any[] = [];
  const decode = vi.fn(async (blob: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
    const original = await loadImage(Buffer.from(await blob.arrayBuffer()));
    const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
    const context = bitmap.getContext('2d'); context.imageSmoothingEnabled = false;
    context.drawImage(original, sx, sy, sw, sh, 0, 0, bitmap.width, bitmap.height);
    bitmap.close = vi.fn(); bitmaps.push(bitmap);
    return bitmap;
  });
  return { decode, bitmaps };
}
const rgba = (canvas: any) => Buffer.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);

describe('bounded compressed scene bitmap leases', () => {
  it('admits lazy native generation serially and shares its completed PNG across concurrent crops', async () => {
    const source = image(32, 32), blob = new Blob([new Uint8Array(source.toBuffer('image/png'))]);
    const scenes = new Map<string, CompressedSceneBitmap>(), { decode } = decoder();
    let active = 0, peak = 0;
    const load = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return { blob, width: 32, height: 32 };
    });
    const provider = createSceneBitmapProvider(scenes, 4096, decode, load);
    const context = createCanvas(32, 32).getContext('2d') as any;
    try {
      const draws = ['a', 'b', 'a', 'c', 'b'].map(key => provider.draw(key, context, 0, 0, 32, 32));
      expect(load).not.toHaveBeenCalled();
      expect(provider.stats.pendingDraws).toBe(5);
      await Promise.all(draws);
      expect(peak).toBe(1);
      expect(load.mock.calls).toHaveLength(3);
      expect(provider.stats).toMatchObject({ loads: 3, loading: 0, pendingDraws: 0, loadedScenes: 3 });
    } finally { provider.dispose(); }
  });

  it('retires lazy loads before decode and never admits queued work from a removed layer', async () => {
    let finish!: (scene: CompressedSceneBitmap) => void;
    const scenes = new Map<string, CompressedSceneBitmap>();
    const load = vi.fn(() => new Promise<CompressedSceneBitmap>(resolve => { finish = resolve; }));
    const { decode } = decoder(), provider = createSceneBitmapProvider(scenes, 4096, decode, load);
    const context = createCanvas(32, 32).getContext('2d') as any;
    const first = provider.draw('a', context, 0, 0, 32, 32);
    const second = provider.draw('b', context, 0, 0, 32, 32);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    provider.dispose();
    finish({ blob: new Blob(), width: 32, height: 32 });
    const results = await Promise.allSettled([first, second]);
    expect(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(scenes.size).toBe(0);
    expect(provider.stats).toMatchObject({ loading: 0, pendingDraws: 0, loadedScenes: 0, bytes: 0 });
  });
  it.each([
    [-100, -87, 384, 300], [-57, -23, 768, 600], [-113, -98, 1152, 900],
    [19, 7, 96, 75], [19, 7, 192, 150], [19, 7, 200, 160],
  ])('preserves tile pixels at position %j', async (dx, dy, dw, dh) => {
    const source = image(), { decode } = decoder();
    const blob = new Blob([new Uint8Array(source.toBuffer('image/png'))]);
    const provider = createSceneBitmapProvider(new Map([['a', { blob, width: source.width, height: source.height }]]), 4 * 1024 * 1024, decode);
    try {
      const actual = createCanvas(256, 256), expected = createCanvas(256, 256);
      expected.getContext('2d').imageSmoothingEnabled = false;
      actual.getContext('2d').imageSmoothingEnabled = false;
      expected.getContext('2d').drawImage(source, dx, dy, dw, dh);
      await provider.draw('a', actual.getContext('2d') as any, dx, dy, dw, dh);
      expect(rgba(actual)).toEqual(rgba(expected));
    } finally { provider.dispose(); }
  });

  it('serializes concurrent decodes, evicts before allocation and reuses completed crop bitmaps', async () => {
    const source = image(), blob = new Blob([new Uint8Array(source.toBuffer('image/png'))]);
    const { decode: nativeDecode, bitmaps } = decoder();
    let active = 0, maxActive = 0;
    const decode = vi.fn(async (...args: Parameters<typeof nativeDecode>) => {
      active++; maxActive = Math.max(maxActive, active);
      const expectedBytes = args[5].resizeWidth! * args[5].resizeHeight! * 4;
      expect(provider.stats.bytes + expectedBytes).toBeLessThanOrEqual(provider.stats.maxBytes);
      try { return await nativeDecode(...args); } finally { active--; }
    });
    const provider = createSceneBitmapProvider(new Map([['a', { blob, width: source.width, height: source.height }]]), 256 * 256 * 4, decode);
    const contexts = Array.from({ length: 3 }, () => createCanvas(256, 256).getContext('2d') as any);
    try {
      await Promise.all(contexts.map(context => provider.draw('a', context, 0, 0, 384, 300)));
      expect(decode).toHaveBeenCalledTimes(1);
      expect(provider.stats.hits).toBe(2);
      await provider.draw('a', contexts[0], -64, 0, 384, 300);
      expect(maxActive).toBe(1);
      expect(bitmaps[0].close).toHaveBeenCalledOnce();
      expect(provider.stats).toMatchObject({ entries: 1, bytes: 256 * 256 * 4, evictions: 1 });
      expect(provider.stats.peakBytes).toBeLessThanOrEqual(provider.stats.maxBytes);
    } finally { provider.dispose(); }
    expect(bitmaps.at(-1).close).toHaveBeenCalledOnce();
    expect(provider.stats.bytes).toBe(0);
  });

  it('decodes giant overview artwork at tile density and close views from native source crops', async () => {
    const requests: any[] = [];
    const decode = vi.fn(async (_: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
      requests.push({ sx, sy, sw, sh, width: options.resizeWidth, height: options.resizeHeight });
      const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
      bitmap.close = vi.fn(); return bitmap;
    });
    const provider = createSceneBitmapProvider(new Map([['huge', { blob: new Blob(), width: 8192, height: 8192 }]]), 256 * 256 * 4, decode);
    const context = createCanvas(256, 256).getContext('2d') as any;
    try {
      await provider.draw('huge', context, 0, 0, 256, 256);
      await provider.draw('huge', context, -4000, -6000, 8192, 8192);
      expect(requests).toEqual([
        { sx: 0, sy: 0, sw: 8192, sh: 8192, width: 256, height: 256 },
        { sx: 4000, sy: 6000, sw: 256, sh: 256, width: 256, height: 256 },
      ]);
      expect(provider.stats.peakBytes).toBe(256 * 256 * 4);
    } finally { provider.dispose(); }
  });

  it('closes a late decode after removal and never paints the disposed layer', async () => {
    let finish!: (image: ImageBitmap) => void;
    const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; }));
    const provider = createSceneBitmapProvider(new Map([['a', { blob: new Blob(), width: 32, height: 32 }]]), 4096, decode);
    const context = createCanvas(32, 32).getContext('2d') as any;
    const request = provider.draw('a', context, 0, 0, 32, 32);
    await Promise.resolve();
    provider.dispose();
    const bitmap = createCanvas(32, 32) as any; bitmap.close = vi.fn();
    finish(bitmap);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(rgba(context.canvas).some(byte => byte !== 0)).toBe(false);
    expect(provider.stats.bytes).toBe(0);
  });
});
