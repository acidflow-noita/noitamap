import { sceneAtlas } from 'virtual:noitamap-data-archives';
import { readAssetPage, type AssetPage } from '../data-archive';
import { getMapMemoryBudget } from '../map-memory-budget';
import { telescopeAssetCandidates } from './telescope-asset-paths';

type ImageEntry = { width: number; height: number; tiles: number[][] };
type Atlas = { version: number; size: number; sheets: AssetPage[]; images: Record<string, ImageEntry> };
let index: Promise<Atlas> | undefined;
const decoded = new Map<string, Uint8Array>();
const pending = new Map<string, Promise<Uint8Array>>();
let bytes = 0, queue = Promise.resolve(), worker: Worker | undefined, workerUnavailable = false;
let activeSheets = 0;
const admissions: Array<() => void> = [];
function admit<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeSheets++;
      void work().then(resolve, reject).finally(() => { activeSheets--; admissions.shift()?.(); });
    };
    if (activeSheets < 2) run(); else admissions.push(run);
  });
}
const getIndex = () => index ??= readAssetPage(sceneAtlas).then(async blob => {
  const result: Atlas = JSON.parse(await blob.text());
  if (result.version !== 1 || result.size !== 1024) throw new Error('Invalid scene atlas index');
  return result;
}).catch(error => { index = undefined; throw error; });

async function decodeSheet(blob: Blob): Promise<Uint8Array> {
  if (!workerUnavailable && typeof Worker !== 'undefined') {
    try {
      worker ??= new Worker(new URL('./scene-atlas-worker.ts', import.meta.url), { type: 'module', name: 'scene-atlas' });
      const current = worker;
      return await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Scene atlas worker timed out')), 30_000);
        const done = () => { clearTimeout(timer); current.onmessage = current.onerror = current.onmessageerror = null; };
        current.onmessage = ({ data }) => {
          done();
          if (!(data.pixels instanceof Uint8Array) || data.pixels.length !== 1024 * 1024 * 4)
            reject(new Error(data.error || 'Invalid decoded scene atlas'));
          else resolve(data.pixels);
        };
        current.onerror = event => { event.preventDefault(); done(); reject(new Error(event.message)); };
        current.onmessageerror = () => { done(); reject(new Error('Scene atlas worker response could not be read')); };
        try { current.postMessage(blob); } catch (error) { done(); reject(error); }
      });
    } catch {
      worker?.terminate(); worker = undefined; workerUnavailable = true;
    }
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const { decode } = await import('fast-png');
  const image = decode(new Uint8Array(await blob.arrayBuffer()));
  if (image.width !== 1024 || image.height !== 1024 || image.channels !== 4 || image.depth !== 8)
    throw new Error('Invalid source scene atlas');
  return image.data as Uint8Array;
}
function sheet(page: AssetPage): Promise<Uint8Array> {
  const key = page.revision, hit = decoded.get(key);
  if (hit) { decoded.delete(key); decoded.set(key, hit); return Promise.resolve(hit); }
  const underway = pending.get(key);
  if (underway) return underway;
  const job = admit(async () => {
    // Overlap the next download with this decode. Two admitted sheets bound
    // pending PNGs; decode ownership remains serial on the shared worker.
    const blob = await readAssetPage(page);
    const work = queue.then(async () => {
      const limit = getMapMemoryBudget().sceneCacheBytes;
      const allocation = 1024 * 1024 * 4;
      while (decoded.size && bytes + allocation > limit) {
        const oldest = decoded.keys().next().value!;
        bytes -= decoded.get(oldest)!.byteLength; decoded.delete(oldest);
      }
      const pixels = await decodeSheet(blob);
      decoded.set(key, pixels); bytes += pixels.byteLength;
      return pixels;
    });
    queue = work.then(() => {}, () => {});
    return work;
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** Every caller receives its own material pixels: Telescope mutates masks
 * during spawn clearing/recoloring. Shared atlas bytes remain immutable. */
export async function readSceneAtlasPixels(group: string, path: string) {
  const atlas = await getIndex(), entry = atlas.images[`${group}/${path}`];
  if (!entry) return null;
  const data = new Uint8ClampedArray(entry.width * entry.height * 4);
  let yielded = performance.now();
  for (const [page, x, y, ox, oy, width, height] of entry.tiles) {
    const pixels = await sheet(atlas.sheets[page]);
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * atlas.size + x) * 4;
      data.set(pixels.subarray(start, start + width * 4), ((oy + row) * entry.width + ox) * 4);
    }
    if (performance.now() - yielded > 6) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); yielded = performance.now();
    }
  }
  return { data, width: entry.width, height: entry.height };
}
export async function readTelescopeAtlasPNG(url: string, bitmap = true) {
  for (const candidate of telescopeAssetCandidates(url)) {
    const image = await readSceneAtlasPixels(candidate.archive, candidate.path);
    if (!image) continue;
    return { ...image, bitmap: bitmap ? await createImageBitmap(new ImageData(image.data, image.width, image.height)) : null };
  }
  return null;
}

/** Optional daily warmup stores PNG bytes; it does not expand the atlas. */
export async function prepareSceneAtlas(): Promise<void> {
  const atlas = await getIndex();
  let next = 0;
  const run = async () => { while (next < atlas.sheets.length) await readAssetPage(atlas.sheets[next++]); };
  await Promise.all([run(), run()]);
}
