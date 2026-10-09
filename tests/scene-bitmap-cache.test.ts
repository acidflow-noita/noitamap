import { createCanvas } from '@napi-rs/canvas';
import { expect, it, vi } from 'vitest';
import { SceneBitmapCache } from '../src/telescope/scene-bitmap-cache';

function bitmap(color: string, size = 4) {
  const image = createCanvas(size, size), ctx = image.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  return Object.assign(image, { close: vi.fn(() => { image.width = image.height = 0; }) }) as unknown as ImageBitmap;
}
function pixel(image: ImageBitmap) {
  const output = createCanvas(4, 4), ctx = output.getContext('2d');
  ctx.drawImage(image as any, 0, 0);
  return [...ctx.getImageData(1, 1, 1, 1).data];
}

it('keeps shared pixels alive when the outgoing seed releases its layer or the cache clears', () => {
  const cache = new SceneBitmapCache(64), image = bitmap('#e04020');
  const old = cache.adopt('same-scene', image), current = cache.acquire('same-scene')!;
  expect(current.bitmap).toBe(old.bitmap);
  old.release(); old.release();
  cache.clear();
  expect(image.close).not.toHaveBeenCalled();
  expect(pixel(current.bitmap)).toEqual([224, 64, 32, 255]);
  current.release(); current.release(); cache.clear();
  expect(image.close).toHaveBeenCalledOnce();
  expect(cache.stats.bytes).toBe(0);
});

it('retains decoded artwork after a layer is gone so a later seed needs no new image', () => {
  const cache = new SceneBitmapCache(64), image = bitmap('#20c060');
  cache.adopt('room', image).release();
  expect(image.close).not.toHaveBeenCalled();
  const next = cache.acquire('room')!;
  expect(next.bitmap).toBe(image);
  expect(pixel(next.bitmap)).toEqual([32, 192, 96, 255]);
  next.release(); cache.clear();
  expect(image.close).toHaveBeenCalledOnce();
});

it('bounds retained bytes while an evicted image remains usable by an active layer', () => {
  const cache = new SceneBitmapCache(64), first = bitmap('#ff0000'), second = bitmap('#0000ff');
  const old = cache.adopt('old', first), next = cache.adopt('new', second);
  expect(cache.stats).toEqual({ entries: 1, bytes: 64, maxBytes: 64 });
  expect(cache.acquire('old')).toBeUndefined();
  expect(pixel(old.bitmap)).toEqual([255, 0, 0, 255]);
  expect(first.close).not.toHaveBeenCalled();
  old.release();
  expect(first.close).toHaveBeenCalledOnce();
  next.release(); cache.clear();
  expect(second.close).toHaveBeenCalledOnce();
});

it('evicts unused least-recently-used images without aliasing a replacement under the same key', () => {
  const cache = new SceneBitmapCache(128), a = bitmap('#ff0000'), b = bitmap('#0000ff'), c = bitmap('#00ff00');
  cache.adopt('a', a).release(); cache.adopt('b', b).release();
  const active = cache.acquire('a')!;
  cache.adopt('c', c).release();
  expect(b.close).toHaveBeenCalledOnce();
  const replacement = bitmap('#ffffff');
  const replaced = cache.adopt('a', replacement);
  expect(pixel(active.bitmap)).toEqual([255, 0, 0, 255]);
  expect(pixel(replaced.bitmap)).toEqual([255, 255, 255, 255]);
  active.release(); replaced.release(); cache.clear();
  for (const image of [a,b,c,replacement]) expect(image.close).toHaveBeenCalledOnce();
});

it('does not evict useful cached scenes to retain an image larger than the entire budget', () => {
  const cache = new SceneBitmapCache(64), small = bitmap('#ff0000'), huge = bitmap('#0000ff', 8);
  cache.adopt('small', small).release();
  const active = cache.adopt('huge', huge);
  expect(cache.stats).toEqual({ entries: 1, bytes: 64, maxBytes: 64 });
  expect(cache.acquire('huge')).toBeUndefined();
  expect(pixel(active.bitmap)).toEqual([0, 0, 255, 255]);
  active.release();
  expect(huge.close).toHaveBeenCalledOnce();
  expect(small.close).not.toHaveBeenCalled();
  cache.clear();
  expect(small.close).toHaveBeenCalledOnce();
});

it('still owns and releases a layer image when retaining decoded scenes is disabled', () => {
  const cache = new SceneBitmapCache(0), image = bitmap('#ff0000');
  const active = cache.adopt('room', image);
  expect(cache.acquire('room')).toBeUndefined();
  cache.clear();
  expect(pixel(active.bitmap)).toEqual([255, 0, 0, 255]);
  active.release();
  expect(image.close).toHaveBeenCalledOnce();
});
