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
import { generatedStreamSource } from '../workers/noitamap-guessr/src/generated-stream-source';
import { signGameTicket, testGameKeys } from './helpers/game-ticket-keys';
import { streamRoute } from '../workers/noitamap-guessr/src/streams';
import type { ParallelInitialization } from '../src/guessr/parallel-types';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'guessr-daily-')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
async function fixture(material = { r: 30, g: 40, b: 50, alpha: 1 }, shoreX: number | null = 850) {
  const png = join(directory, 'source.png'), bake = join(directory, 'middle');
  // A one-unit change on this shoreline must survive the exact solid-color filter.
  const scene = sharp({ create: { width: 2048, height: 2048, channels: 4, background: material } });
  if (shoreX !== null) {
    const shore = await sharp({ create: { width: 1, height: 2048, channels: 4,
      background: { ...material, r: material.r + 1 } } }).png().toBuffer();
    scene.composite([{ input: shore, left: shoreX, top: 0 }]);
  }
  await scene.png().toFile(png);
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
  expect(manifest).toMatchObject({ complete: true, seed: 123, eligibleAreas: 1, rounds: 10, solidStartZoom: 4 });
  const daily = JSON.parse(await readFile(join(input.outputDirectory, 'private/daily.json'), 'utf8'));
  const shoreline = -17920 + 850;
  for (const round of daily.rounds) {
    expect(shoreline).toBeGreaterThanOrEqual(round.answer.x - 216);
    expect(shoreline).toBeLessThan(round.answer.x + 216);
  }
  const data = JSON.parse(await readFile(join(input.outputDirectory, 'clues/dataset.json'), 'utf8'));
  expect(JSON.stringify(data)).not.toContain('answer');
  expect(await publishDailyPackage({ directory: input.outputDirectory })).toMatchObject({ published: false });
  const database = gameDatabase();
  try {
    for (const migration of ['0002_stream_results', '0005_stream_history', '0006_stream_storage', '0007_result_ownership', '0008_result_history_summaries', '0009_generated_stream_maps', '0010_stream_game_admission'])
      database.sqlite.exec(await readFile(`workers/noitamap-guessr/migrations/${migration}.sql`, 'utf8'));
    const secret = 'local-test-publisher-secret-01234567890123456789';
    const env: Env = { DB: database.db, ASSETS: { fetch: async () => new Response('', { status: 404 }) },
      GAME_SIGNING_SECRET: 'local-test-game-secret-01234567890123456789', ALLOWED_ORIGINS: '',
      DAILY_PUBLISH_SECRET: secret, DAILY_ASSET_HOSTS: 'clue-test.pages.dev,map-test.pages.dev' };
    let verified = 0, activated = false;
    const network: typeof fetch = async (resource, init) => {
      const url = String(resource);
      if (url.includes('/current_seed.txt')) return new Response('123');
      if (url.includes('api.cloudflare.com')) return Response.json({ success: true, result: { production_branch: 'main', subdomain: url.endsWith('clue-test') ? 'clue-test.pages.dev' : 'map-test.pages.dev' } });
      if (init?.method === 'HEAD') { verified++; return new Response(null, { headers: { 'Content-Type': url.endsWith('.webp') ? 'image/webp' : url.endsWith('.bin') ? 'application/octet-stream' : 'application/json' } }); }
      if (new URL(url).pathname.startsWith('/prepared/')) return new Response(new Uint8Array(await readFile(join(input.outputDirectory, 'clues', new URL(url).pathname))));
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
    const saved = database.sqlite.prepare('SELECT source_json FROM stream_maps').get()!;
    expect(saved.source_json).not.toContain('"rounds"');
    const readPrepared: typeof fetch = async resource => {
      const url = new URL(String(resource));
      expect(url.pathname).toMatch(/^\/prepared\/[a-f0-9]{64}\.bin$/);
      return new Response(new Uint8Array(await readFile(join(input.outputDirectory, 'clues', url.pathname))));
    };
    const generated = await generatedStreamSource(env, Date.UTC(2026, 9, 25, 12), readPrepared);
    expect(generated.dataset).toMatchObject({ day: '2026-10-25', seed: 123 });
    const selected = await generated.source.sampleRounds(5); expect(selected).toHaveLength(5);
    expect(selected.every(round => round.frames.every(frame => frame.image.startsWith(published.clueDeployment + '/images/')))).toBe(true);
    expect((await generated.source.config()).map.tiles).toBe(published.referenceDeployment + '/map_files/');
    const initialized: ParallelInitialization[] = [], signing = 'test-only-generated-map-ticket-signing-key';
    env.STREAM_ENABLED = 'true'; env.STREAM_SIGNING_SECRET = signing;
    env.GAME_TICKET_PUBLIC_KEY = (await testGameKeys(signing)).publicKey;
    env.STREAM_COORDINATORS = { getByName: () => ({ initialize: async value => { initialized.push(value); }, fetch: async () => new Response() }) };
    const ticket = await signGameTicket('account:host', 'Host', signing, { twitchUserId: '123', twitchLogin: 'host' }, Date.UTC(2026, 9, 25, 12));
    vi.stubGlobal('fetch', readPrepared);
    const created = await streamRoute(new Request('https://api.test/api/streams/sessions', { method: 'POST', headers: {
      Authorization: 'Bearer ' + ticket.token, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ protocol: 2, transport: 'parallel', rounds: 3 }) }), env, Date.UTC(2026, 9, 25, 12));
    expect(created.status).toBe(201);
    const session = await created.json() as any;
    expect(session.dataset).toMatchObject({ day: '2026-10-25', seed: 123 });
    expect(session.config.map.tiles).toBe(published.referenceDeployment + '/map_files/');
    expect(session.rounds.every((round: any) => !round.token && !round.clue.frames.length)).toBe(true);
    expect(JSON.stringify(session)).not.toContain(JSON.parse(saved.source_json as string).preparedSource.key);
    expect(initialized[0].reveals).toHaveLength(3);
    await expect(generatedStreamSource(env, Date.UTC(2026, 9, 26, 12))).rejects.toThrow('still being prepared');
  } finally { database.close(); }
});

it('classifies final composed Daily images privately and excludes every Hard view from all ten rounds', async () => {
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
  expect(daily.rounds.every((r: any) => ['easy', 'normal'].includes(r.area.difficultyTier) && !r.area.viewDifficulty)).toBe(true);
  const publicData = await readFile(join(input.outputDirectory, 'clues/dataset.json'), 'utf8');
  expect(publicData).not.toMatch(/viewDifficulty|featureless|terrain\/edr/);
});

it('rejects a mismatched seed before producing publishable output', async () => {
  const input = await fixture();
  await expect(prepareDaily({ ...input, expectedSeed: 456 })).rejects.toThrow('seed-matched');
});

it('does not publish an unplayable fallback when all eligible starts are solid lava', async () => {
  const input = await fixture({ r: 255, g: 96, b: 0, alpha: 1 }, null);
  await expect(prepareDaily(input)).rejects.toThrow('No reviewed playable areas');
  await expect(readFile(join(input.outputDirectory, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
      headers: { 'Content-Type': url.endsWith('.webp') ? 'image/webp' : url.endsWith('.bin') ? 'application/octet-stream' : 'application/xml' } });
    if (new URL(url).pathname.startsWith('/prepared/')) return new Response(new Uint8Array(await readFile(join(input.outputDirectory, 'clues', new URL(url).pathname))));
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
