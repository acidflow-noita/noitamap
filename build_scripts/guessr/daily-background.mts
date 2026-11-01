import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, copyFile, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export interface PyramidGeometry {
  width: number; height: number; originX: number; originY: number;
  tileSize: number; overlap: number; maxLevel: number;
}
interface BackgroundManifest { schemaVersion: 1; kind: 'dynamic-map-background'; identity: string; capture: PyramidGeometry; source: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function tileDimensions(c: PyramidGeometry, level: number, x: number, y: number) {
  const scale = 2 ** (c.maxLevel - level), width = Math.ceil(c.width / scale), height = Math.ceil(c.height / scale);
  const left = Math.max(0, x * c.tileSize - c.overlap), top = Math.max(0, y * c.tileSize - c.overlap);
  return { width: Math.min(width, (x + 1) * c.tileSize + c.overlap) - left,
    height: Math.min(height, (y + 1) * c.tileSize + c.overlap) - top };
}
function validate(c: PyramidGeometry) {
  if (!c || !Object.values(c).every(Number.isSafeInteger) || c.width <= 0 || c.height <= 0
      || c.width > 65536 || c.height > 131072 || c.tileSize !== 512 || c.overlap !== 2
      || c.maxLevel !== Math.ceil(Math.log2(Math.max(c.width, c.height)))) throw new Error('Invalid static background geometry.');
}

export async function loadDailyBackground(options: { manifest?: string; cacheDirectory: string; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  let manifest: BackgroundManifest, tileRoot: string;
  if (options.manifest) {
    if (/^https:\/\//.test(options.manifest)) {
      const response = await fetcher(options.manifest, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('The pinned Guessr background is unavailable.');
      manifest = await response.json() as BackgroundManifest;
      tileRoot = new URL('map_files/', options.manifest).href;
    } else {
      const file = resolve(options.manifest);
      manifest = JSON.parse(await readFile(file, 'utf8'));
      tileRoot = join(dirname(file), 'map_files');
    }
  } else {
    const definitions = JSON.parse(await readFile(join(root, 'src/data/tilesources.json'), 'utf8'));
    const definition = definitions['dynamic-main-branch'][0], image = JSON.parse(definition.dziContent).Image;
    const capture = { width: Number(image.Size.Width), height: Number(image.Size.Height), originX: Number(image.TopLeft.X),
      originY: Number(image.TopLeft.Y), tileSize: Number(image.TileSize), overlap: Number(image.Overlap),
      maxLevel: Math.ceil(Math.log2(Math.max(Number(image.Size.Width), Number(image.Size.Height)))) };
    if (image.Format !== 'webp' || !/^https:\/\//.test(definition.url)) throw new Error('Unsupported dynamic-map background.');
    manifest = { schemaVersion: 1, kind: 'dynamic-map-background', identity: hash(JSON.stringify(definition)), capture, source: definition.url };
    tileRoot = definition.url.replace(/\.dzi$/, '_files/');
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'dynamic-map-background' || !/^[a-f0-9]{64}$/.test(manifest.identity))
    throw new Error('Use a prepared clean dynamic-map background, not a captured game map.');
  validate(manifest.capture);
  const cache = join(resolve(options.cacheDirectory), manifest.identity);
  async function tile(level: number, x: number, y: number): Promise<string> {
    const relative = `${level}/${x}_${y}.webp`;
    if (!/^https:\/\//.test(tileRoot)) return join(tileRoot, relative);
    const file = join(cache, 'map_files', relative);
    try { if ((await stat(file)).size > 0) return file; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetcher(new URL(relative, tileRoot), { signal: AbortSignal.timeout(30000) });
    if (!response.ok || Number(response.headers.get('Content-Length')) > 25 * 1024 ** 2)
      throw new Error(`Static background tile unavailable: ${relative}`);
    let bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 25 * 1024 ** 2 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP')
      throw new Error('Invalid background WebP response.');
    const expected = tileDimensions(manifest.capture, level, x, y);
    const metadata = await sharp(bytes, { limitInputPixels: 516 * 516 }).metadata();
    if (metadata.width !== expected.width || metadata.height !== expected.height) {
      // The legacy static pyramid pads some tiny edge mips by one pixel. Crop
      // only that excess/pad a short edge; native pixels are never rescaled.
      const actualW = metadata.width || 0, actualH = metadata.height || 0;
      if (level === manifest.capture.maxLevel || Math.abs(actualW - expected.width) > 2 || Math.abs(actualH - expected.height) > 2)
        throw new Error(`Background tile ${relative} has ${actualW}x${actualH}; descriptor expects ${expected.width}x${expected.height}.`);
      const width = Math.min(actualW, expected.width), height = Math.min(actualH, expected.height);
      bytes = await sharp(bytes).ensureAlpha().extract({ left: 0, top: 0, width, height })
        .extend({ left: 0, top: 0, right: expected.width - width, bottom: expected.height - height, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ lossless: true, effort: 1 }).toBuffer();
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes); await rename(temporary, file);
    return file;
  }
  return { manifest, tile };
}

async function linkOrCopy(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  try { await link(source, target); } catch (error: any) {
    if (error.code === 'EEXIST') {
      const [a, b] = await Promise.all([stat(source), stat(target)]);
      if (a.ino === b.ino && a.dev === b.dev || a.size === b.size && (await readFile(source)).equals(await readFile(target))) return;
      throw new Error('The background output contains a different image set. Use a new output directory.');
    }
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await copyFile(source, target);
  }
}

export async function composeDailyWorld(bake: string, native: PyramidGeometry, destination: string,
  background: Awaited<ReturnType<typeof loadDailyBackground>>) {
  const c = background.manifest.capture;
  if (c.originX !== native.originX || c.originY !== native.originY || c.maxLevel !== native.maxLevel
      || c.width < native.width || c.height < native.height) throw new Error('The daily bake and static background do not align.');
  let tiles = 0;
  sharp.concurrency(2); sharp.cache({ memory: 64, files: 32, items: 64 });
  const jobs: [number, number, number][] = [];
  for (let level = 0; level <= c.maxLevel; level++) {
    const scale = 2 ** (c.maxLevel - level), columns = Math.ceil(Math.ceil(c.width / scale) / 512), rows = Math.ceil(Math.ceil(c.height / scale) / 512);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) jobs.push([level, x, y]);
  }
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < jobs.length) {
      const [level, x, y] = jobs[next++], size = tileDimensions(c, level, x, y), scale = 2 ** (native.maxLevel - level);
      const output = join(destination, 'map_files', String(level), `${x}_${y}.webp`);
      const inNative = x < Math.ceil(Math.ceil(native.width / scale) / 512) && y < Math.ceil(Math.ceil(native.height / scale) / 512);
      const foreground = inNative ? join(bake, 'map_files', String(level), `${x}_${y}.webp`) : null;
      const info = foreground ? await sharp(foreground).metadata() : null;
      if (foreground && !info!.hasAlpha && info!.width === size.width && info!.height === size.height) await linkOrCopy(foreground, output);
      else {
        const base = await background.tile(level, x, y);
        if (!foreground) await linkOrCopy(base, output);
        else {
          await mkdir(dirname(output), { recursive: true });
          await sharp(base, { limitInputPixels: 516 * 516 }).composite([{ input: foreground, left: 0, top: 0, blend: 'over' }])
            .webp({ lossless: true, effort: 1 }).toFile(output);
        }
      }
      tiles++;
    }
  }));
  return { capture: c, tiles, backgroundIdentity: background.manifest.identity };
}

/** One-time secondary-account background snapshot. No coordinates are round answers. */
export async function prepareDailyBackground(output: string, cacheDirectory: string) {
  const background = await loadDailyBackground({ cacheDirectory }), c = background.manifest.capture;
  const jobs: [number, number, number][] = [];
  for (let level = 0; level <= c.maxLevel; level++) {
    const scale = 2 ** (c.maxLevel - level);
    for (let y = 0; y < Math.ceil(Math.ceil(c.height / scale) / 512); y++)
      for (let x = 0; x < Math.ceil(Math.ceil(c.width / scale) / 512); x++) jobs.push([level, x, y]);
  }
  let next = 0, complete = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < jobs.length) {
      const [level, x, y] = jobs[next++];
      await linkOrCopy(await background.tile(level, x, y), join(output, 'map_files', String(level), `${x}_${y}.webp`));
      if (++complete % 1000 === 0) console.log(`[Guessr background] ${complete}/${jobs.length} tiles ready`);
    }
  }));
  if (jobs.length + 2 > 20000) throw new Error('Static background exceeds the Pages Free file budget.');
  await writeFile(join(output, 'background.json'), JSON.stringify(background.manifest));
  await writeFile(join(output, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n');
  return { files: jobs.length + 2, identity: background.manifest.identity };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.find(v => v.startsWith('--out='))?.slice(6);
  const cache = process.argv.find(v => v.startsWith('--cache='))?.slice(8);
  if (!output || !cache) throw new Error('Required: --out=<new directory> --cache=<background cache>');
  console.log(JSON.stringify(await prepareDailyBackground(resolve(output), resolve(cache))));
}
