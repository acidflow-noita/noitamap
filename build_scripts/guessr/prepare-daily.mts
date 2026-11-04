/** Consume a completed main-world bake; never modify or delay map publication. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, symlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportImageSet } from './export-image-set.mjs';
import { prepareWorkerData } from './prepare-worker-data.mts';
import { privateOutput } from './private-output.mjs';
import { createPreparedRoundSource } from '../../src/guessr/prepared-rounds';
import { DAILY_ROUNDS, type DailyImagePack } from '../../src/guessr/daily-pack';
import type { AreaDefinition } from '../../src/guessr/area-rules';
import { loadDailyBackground, composeDailyWorld } from './daily-background.mts';
import { withProgress } from './progress.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pendingImages = 'https://images.invalid/images';
const pendingReference = 'https://reference.invalid/map_files/';
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

export async function prepareDaily(options: {
  bakeDirectory: string;
  outputDirectory: string;
  day: string;
  expectedSeed?: number;
  areasPath?: string;
  backgroundManifest?: string;
  backgroundCache?: string;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.day) || new Date(options.day).toISOString().slice(0, 10) !== options.day)
    throw new Error('A valid UTC daily date is required.');
  const bake = resolve(options.bakeDirectory), output = privateOutput(resolve(options.outputDirectory));
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Daily output must be a new, empty directory.');
  const [manifest, descriptor, generation, recipe] = await Promise.all([
    read(join(bake, 'manifest.json')), read(join(bake, 'map.dzi')), read(join(bake, 'generation.json')),
    read(options.areasPath ?? join(root, 'build_scripts/guessr/reviewed-areas.json')),
  ]);
  const image = descriptor.Image, region = manifest.regions?.[0];
  const seed = manifest.seed;
  if (!manifest.complete || !manifest.baked || manifest.world !== 'middle' || !manifest.renderId || !manifest.terrainVersion
      || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || generation.seed !== seed
      || options.expectedSeed !== undefined && seed !== options.expectedSeed || region?.pw !== 0
      || !Number.isFinite(Date.parse(manifest.generatedAt)))
    throw new Error('Daily preparation requires a complete, seed-matched main-world bake.');
  const width = Number(image?.Size?.Width), height = Number(image?.Size?.Height);
  const tileSize = Number(image?.TileSize), overlap = Number(image?.Overlap);
  const originX = Number(image?.TopLeft?.X), originY = Number(image?.TopLeft?.Y);
  if (image?.Format !== 'webp' || tileSize !== 512 || overlap !== 2
      || ![width, height, originX, originY].every(Number.isSafeInteger)
      || width <= 0 || height <= 0 || width > 65536 || height > 131072
      || region.fullW !== width || region.fullH !== height || region.minX !== originX || region.minY !== originY)
    throw new Error('The bake descriptor and world extent do not match.');
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  let expectedTiles = 0;
  const reference = join(output, 'reference');
  await withProgress('Validating bake tiles', manifest.tileCount, async progress => {
    for (let level = 0; level <= maxLevel; level++) {
      const scale = 2 ** (maxLevel - level);
      const cols = Math.ceil(Math.ceil(width / scale) / tileSize), rows = Math.ceil(Math.ceil(height / scale) / tileSize);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const name = `${x}_${y}.webp`, source = join(bake, 'map_files', String(level), name);
        const info = await stat(source);
        if (!info.isFile() || !info.size || info.size > 25 * 1024 ** 2) throw new Error(`Invalid or missing bake tile ${level}/${name}.`);
        expectedTiles++; progress.advance();
      }
    }
    if (expectedTiles !== manifest.tileCount) throw new Error('The completed bake has a mismatched tile count.');
  }, { unit: 'tiles' });
  const background = await withProgress('Loading background manifest', null, () => loadDailyBackground({ manifest: options.backgroundManifest,
    cacheDirectory: options.backgroundCache ?? join(output, 'private/background-cache') }));
  const composed = await composeDailyWorld(bake, { width, height, originX, originY, tileSize, overlap, maxLevel }, reference, background);
  if (composed.tiles + 2 > 20000) throw new Error('Reference images exceed the configured Pages Free file budget.');
  const sha256 = createHash('sha256').update(JSON.stringify({ seed, renderId: manifest.renderId, background: composed.backgroundIdentity, capture: composed.capture })).digest('hex');
  const capture = { version: 1, sha256, ...composed.capture, tiles: composed.tiles };
  const privateRoot = join(output, 'private'), sourceRoot = join(privateRoot, 'source');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(capture));
  const dzi = `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="webp" TileSize="${tileSize}" Overlap="${overlap}"><Size Width="${capture.width}" Height="${capture.height}"/></Image>`;
  await writeFile(join(sourceRoot, 'map.dzi'), dzi);
  await symlink(join(reference, 'map_files'), join(sourceRoot, 'map_files'), 'dir');
  await writeFile(join(reference, 'map.dzi'), dzi);
  await writeFile(join(reference, '_headers'), '/map_files/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n');
  const indexPath = join(privateRoot, 'image-set.json');
  let exportStats = { assets: 0, bytes: 0, indexedContent: 0 };
  const images = await withProgress('Exporting clue tiles', composed.tiles, progress => exportImageSet({
    sourceDirectory: sourceRoot, publicDirectory: join(output, 'clues'), privateIndexPath: indexPath,
    onProgress: stats => { exportStats = stats; progress.advance(); },
  }), { unit: 'tiles', details: () => `${exportStats.assets} unique images, ${exportStats.indexedContent} content masks, ${(exportStats.bytes / 1024 ** 2).toFixed(1)} MiB` });
  if (images.stats.assets + 2 > 20000) throw new Error('Clue images exceed the configured Pages Free file budget.');
  if (recipe.schemaVersion !== 1 || !Array.isArray(recipe.areas) || !recipe.areas.length) throw new Error('Reviewed puzzle-area recipe is unavailable.');
  const inventoryPath = join(privateRoot, 'inventory.json');
  await writeFile(inventoryPath, JSON.stringify({ capture, puzzleAreas: recipe.areas as AreaDefinition[] }));
  const workerDirectory = join(privateRoot, 'worker-assets');
  const prepared = await withProgress('Preparing playable areas', recipe.areas.length, progress => prepareWorkerData({
    indexPath, inventoryPath, outputDirectory: workerDirectory, onProgress: () => progress.advance(),
  }), { unit: 'areas' });
  // Choose the shared daily rounds once in CI, never while a player is exploring.
  const entropy = randomBytes(32); let counter = 0;
  const random = () => createHash('sha256').update(entropy).update(String(counter++)).digest().readUInt32LE(0) / 4294967296;
  const source = createPreparedRoundSource(async path => new Response(await readFile(join(workerDirectory, path))), pendingImages, pendingReference, random);
  const config = await source.config(), rounds = await withProgress('Selecting Daily rounds', DAILY_ROUNDS, async progress => {
    const selected = await source.sampleRounds(DAILY_ROUNDS); progress.advance(selected.length); return selected;
  }, { unit: 'rounds' });
  const pack: DailyImagePack = {
    schemaVersion: 1, day: options.day, seed, version: config.version, renderId: manifest.renderId,
    generatedAt: manifest.generatedAt, config, rounds,
  };
  await writeFile(join(privateRoot, 'daily.json'), JSON.stringify(pack), { mode: 0o600 });
  const summary = {
    schemaVersion: 1, complete: true, day: pack.day, seed, version: pack.version, renderId: pack.renderId,
    clueFiles: images.stats.assets + 2, referenceFiles: composed.tiles + 2, backgroundIdentity: composed.backgroundIdentity,
    eligibleAreas: prepared.areas, eligiblePositions: prepared.positions, excludedAreas: prepared.excluded,
    rounds: rounds.length,
  };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const split = arg.indexOf('='); if (!arg.startsWith('--') || split < 3) throw new Error('Use --name=value arguments.');
    return [arg.slice(2, split), arg.slice(split + 1)];
  }));
  if (!args.bake || !args.out || !args.day) throw new Error('Required: --bake=<middle bake> --out=<new private directory> --day=YYYY-MM-DD');
  console.log(JSON.stringify(await prepareDaily({ bakeDirectory: args.bake, outputDirectory: args.out, day: args.day,
    ...(args.background ? { backgroundManifest: args.background } : {}), ...(args['background-cache'] ? { backgroundCache: args['background-cache'] } : {}),
    ...(args.seed === undefined ? {} : { expectedSeed: Number(args.seed) }) }), null, 2));
}
