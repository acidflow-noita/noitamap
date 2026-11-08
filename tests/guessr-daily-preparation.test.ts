import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { prepareCapturedMap } from '../build_scripts/guessr/prepare-captured-map.mjs';
import { prepareDaily } from '../build_scripts/guessr/prepare-daily.mts';
import { publishDailyPackage } from '../build_scripts/guessr/publish-daily.mts';
import { handle, type Env } from '../workers/noitamap-guessr/src/index';
import { gameDatabase } from './helpers/guessr-database';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'guessr-daily-')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function fixture(material = { r: 30, g: 40, b: 50, alpha: 1 }) {
  const png = join(directory, 'source.png'), bake = join(directory, 'middle');
  await sharp({ create: { width: 2048, height: 2048, channels: 4, background: material } }).png().toFile(png);
  const source = await prepareCapturedMap(png, bake, { originX: -17920, originY: 0 });
  await writeFile(join(bake, 'background.json'), JSON.stringify({ schemaVersion: 1, kind: 'dynamic-map-background', identity: 'a'.repeat(64),
    source: 'test-fixture', capture: { width: 2048, height: 2048, originX: -17920, originY: 0, tileSize: 512, overlap: 2, maxLevel: 11 } }));
  const generatedAt = '2026-10-25T10:00:00.000Z';
  await writeFile(join(bake, 'map.dzi'), JSON.stringify({ Image: { Format: 'webp', TileSize: 512, Overlap: 2,
    Size: { Width: 2048, Height: 2048 }, TopLeft: { X: -17920, Y: 0 } } }));
  await writeFile(join(bake, 'manifest.json'), JSON.stringify({ seed: 123, world: 'middle', complete: true, baked: true, renderId: 'fixture-render',
    terrainVersion: 'fixture', generatedAt, tileCount: source.tiles, regions: [{ pw: 0, minX: -17920, minY: 0, fullW: 2048, fullH: 2048 }] }));
  await writeFile(join(bake, 'generation.json'), JSON.stringify({ seed: 123 }));
  const areasPath = join(directory, 'areas.json');
  await writeFile(areasPath, JSON.stringify({ schemaVersion: 1, areas: [{ id: 'test/area', label: 'Test area', originY: 0,
    runs: [[0, 0, 4], [1, 0, 4], [2, 0, 4], [3, 0, 4]], bounds: { x: -17920, y: 0, width: 2048, height: 2048 }, cells: 16,
    difficultyTier: 'normal', scoring: { area: 1000, position: 4000, maximum: 5000 } }] }));
  return { bakeDirectory: bake, outputDirectory: join(directory, 'prepared'), day: '2026-10-25', expectedSeed: 123, areasPath, backgroundManifest: join(bake, 'background.json') };
}

it('prepares a reusable whole-world image set and publishes its matching private daily only after image verification', async () => {
  const input = await fixture(), manifest = await prepareDaily(input);
  expect(manifest).toMatchObject({ complete: true, seed: 123, eligibleAreas: 1, rounds: 10 });
  const data = JSON.parse(await readFile(join(input.outputDirectory, 'clues/dataset.json'), 'utf8'));
  expect(JSON.stringify(data)).not.toContain('answer');
  expect(await publishDailyPackage({ directory: input.outputDirectory })).toMatchObject({ published: false });
  const database = gameDatabase();
  try {
    const secret = 'local-test-publisher-secret-01234567890123456789';
    const env: Env = { DB: database.db, ASSETS: { fetch: async () => new Response('', { status: 404 }) },
      GAME_SIGNING_SECRET: 'local-test-game-secret-01234567890123456789', ALLOWED_ORIGINS: '',
      DAILY_PUBLISH_SECRET: secret, DAILY_ASSET_HOSTS: 'clue-test.pages.dev,map-test.pages.dev' };
    let verified = 0, activated = false;
    const network: typeof fetch = async (resource, init) => {
      const url = String(resource);
      if (url.includes('/current_seed.txt')) return new Response('123');
      if (url.includes('api.cloudflare.com')) return Response.json({ success: true, result: { production_branch: 'main', subdomain: url.endsWith('clue-test') ? 'clue-test.pages.dev' : 'map-test.pages.dev' } });
      if (init?.method === 'HEAD') { verified++; return new Response(null, { headers: { 'Content-Type': url.endsWith('.webp') ? 'image/webp' : 'application/json' } }); }
      if (url.endsWith('/api/admin/daily')) {
        expect(verified).toBeGreaterThan(1); activated = true;
        return handle(new Request(url, init), env, Date.UTC(2026, 9, 25, 12));
      }
      throw new Error('Unexpected network request');
    };
    const published = await publishDailyPackage({ directory: input.outputDirectory, publish: true, fetch: network,
      now: Date.UTC(2026, 9, 25, 12), env: { GUESSR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), GUESSR_CLOUDFLARE_API_TOKEN: 'test-token',
        GUESSR_CLUE_PROJECT: 'clue-test', GUESSR_REFERENCE_PROJECT: 'map-test', GUESSR_API_URL: 'https://api.sage-data.xyz', GUESSR_DAILY_PUBLISH_SECRET: secret },
      pagesCommand: async (_command, args, options) => {
        const project = args[args.indexOf('--project-name') + 1];
        expect(args).toContain('daily-images');
        expect(options.env.GUESSR_DAILY_PUBLISH_SECRET).toBeUndefined();
        // Exercise the actual default deployment adapter, including its structured
        // URL discovery, rather than bypassing it with a completed URL.
        options.log('Upload complete. Human-readable output does not contain a URL.');
        await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH!, JSON.stringify({ type: 'pages-deploy', version: 1,
          pages_project: project, deployment_id: 'a1b2c3d4-1111-4111-8111-111111111111', url: `https://a1b2c3d4.${project}.pages.dev` }) + '\n');
      },
    });
    expect(activated).toBe(true); expect(published.published).toBe(true);
    expect(database.sqlite.prepare('SELECT COUNT(*) n FROM questions').get()).toMatchObject({ n: 10 });
  } finally { database.close(); }
});

it('classifies final composed Daily images privately and limits featureless views across the ten-round selection', async () => {
  const input = await fixture({ r: 39, g: 22, b: 18, alpha: 1 });
  const recipe = JSON.parse(await readFile(input.areasPath, 'utf8'));
  recipe.areas[0].id = 'terrain/edr';
  recipe.areas.push({ ...recipe.areas[0], id: 'biome/other' });
  await writeFile(input.areasPath, JSON.stringify(recipe));
  const report = await prepareDaily(input);
  expect(report.featurelessVariants).toBe(1);
  expect(report.featurelessPositions).toBeGreaterThan(0);
  const daily = JSON.parse(await readFile(join(input.outputDirectory, 'private/daily.json'), 'utf8'));
  expect(daily.rounds).toHaveLength(10);
  const hard = daily.rounds.filter((r: any) => r.area.viewDifficulty);
  expect(hard.length).toBeLessThanOrEqual(1);
  for (const round of hard) expect(round.area).toMatchObject({ id: 'terrain/edr', difficultyTier: 'hard',
    scoring: { area: 1000, position: 4000, maximum: 5000 } });
  const publicData = await readFile(join(input.outputDirectory, 'clues/dataset.json'), 'utf8');
  expect(publicData).not.toMatch(/viewDifficulty|featureless|terrain\/edr/);
});

it('rejects a mismatched seed before producing publishable output', async () => {
  const input = await fixture();
  await expect(prepareDaily({ ...input, expectedSeed: 456 })).rejects.toThrow('seed-matched');
});

it.each(['missing image', 'changed seed'])('keeps the previous Daily active after %s during publication', async failure => {
  const input = await fixture(); await prepareDaily(input);
  let seedReads = 0, uploads = 0, activations = 0;
  const network: typeof fetch = async (resource, init) => {
    const url = String(resource);
    if (url.includes('/current_seed.txt')) return new Response(++seedReads > 1 && failure === 'changed seed' ? '456' : '123');
    if (url.includes('api.cloudflare.com')) return Response.json({ success: true, result: { production_branch: 'main',
      subdomain: url.endsWith('clue-test') ? 'clue-test.pages.dev' : 'map-test.pages.dev' } });
    if (init?.method === 'HEAD') return new Response(null, { status: failure === 'missing image' ? 404 : 200,
      headers: { 'Content-Type': url.endsWith('.webp') ? 'image/webp' : 'application/xml' } });
    if (url.endsWith('/api/admin/daily')) activations++;
    throw new Error('Unexpected network request');
  };
  await expect(publishDailyPackage({ directory: input.outputDirectory, publish: true, fetch: network,
    now: Date.UTC(2026, 9, 25, 12), env: { GUESSR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), GUESSR_CLOUDFLARE_API_TOKEN: 'test-token',
      GUESSR_CLUE_PROJECT: 'clue-test', GUESSR_REFERENCE_PROJECT: 'map-test', GUESSR_API_URL: 'https://api.sage-data.xyz',
      GUESSR_DAILY_PUBLISH_SECRET: 'local-publish-test-secret-01234567890123456789' },
    deploy: async (_path, project) => { uploads++; return `https://a1b2c3d4.${project}.pages.dev`; },
  })).rejects.toThrow(failure === 'missing image' ? 'not available' : 'live daily seed changed');
  expect(uploads).toBe(2); expect(activations).toBe(0);
  await expect(readFile(join(input.outputDirectory, 'publication.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
