import { expect, it, vi } from 'vitest';
import { createScenePreparation } from '../src/telescope/scene-preparation';
const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const image = { blob: new Blob(['native pixels']), width: 2, height: 2 };

it('prepares only requested scenes initially, prioritizes navigation between background jobs, and includes persistence', async () => {
  const started: string[] = [], release = new Map<string, () => void>();
  const prep = createScenePreparation(['a', 'b', 'c', 'visible'], key => {
    started.push(key);
    return new Promise(resolve => release.set(key, () => resolve(image)));
  }, vi.fn());
  const complete = vi.fn(); void prep.complete.then(complete);
  expect(started).toEqual([]);
  const warming = prep.warmAll(); await drain(); expect(started).toEqual(['a']);
  const visible = prep.loadBitmap('visible');
  expect(prep.loadBitmap('visible')).toBe(visible);
  release.get('a')!(); await drain(); expect(started).toEqual(['a', 'visible']);
  expect(complete).not.toHaveBeenCalled();
  release.get('visible')!(); await visible; await drain(); expect(started).toEqual(['a', 'visible', 'b']);
  release.get('b')!(); await drain(); release.get('c')!(); await warming;
  expect(complete).toHaveBeenCalledOnce(); expect(prep.images.size).toBe(4);
  prep.dispose();
});

it('cancels background cooking and rejects queued work without retaining late images', async () => {
  let finish!: () => void;
  const close = vi.fn(), paint = vi.fn(() => new Promise<typeof image>(resolve => { finish = () => resolve(image); }));
  const prep = createScenePreparation(['a', 'b'], paint, close);
  const a = prep.loadBitmap('a'), b = prep.loadBitmap('b');
  const errors = Promise.all([expect(a).rejects.toMatchObject({ name: 'AbortError' }),
    expect(b).rejects.toMatchObject({ name: 'AbortError' }), expect(prep.complete).rejects.toMatchObject({ name: 'AbortError' })]);
  await drain(); prep.dispose(); finish(); await errors;
  expect(paint).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(prep.images.size).toBe(0);
});
