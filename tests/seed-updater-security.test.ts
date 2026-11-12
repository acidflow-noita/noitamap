import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHeaderRepair } from '../workers/daily-seed-updater/repair-headers.mjs';
let worker: { fetch(...args: unknown[]): Promise<Response>; scheduled(...args: unknown[]): Promise<void> };
beforeAll(async () => {
  const result = await build({ entryPoints: ['workers/daily-seed-updater/src/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'SeedTest', platform: 'neutral', target: 'es2022' });
  worker = new Function(result.outputFiles[0].text + '\nreturn SeedTest.default;')();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['GET', 'POST', 'OPTIONS'])('never starts privileged work over HTTP %s', async method => {
  const get = vi.fn(), network = vi.fn(); vi.stubGlobal('fetch', network);
  const response = await worker.fetch(new Request('https://updater.test/update', { method }), { CF_API_TOKEN: { get } }, {});
  expect(response.status).toBe(404); expect(get).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
it('does not deploy, read secrets or trigger a bake when the published seed already matches', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const get = vi.fn(), network = vi.fn(async (input: string) => new Response(input.includes('takapuoli') ? 'daily;1234' : '1234'));
  vi.stubGlobal('fetch', network);
  await worker.scheduled({}, { CF_API_TOKEN: { get }, CF_ACCOUNT_ID: { get } }, {});
  expect(network).toHaveBeenCalledTimes(2); expect(get).not.toHaveBeenCalled();
});
it('keeps upstream errors and tokens out of failure output', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('takapuoli')) return new Response('daily;1234');
    if (input.includes('current_seed')) return new Response('1233');
    return new Response('private-upload-token-and-injected-log-data', { status: 403 });
  }));
  const env = { CF_API_TOKEN: { get: async () => 'test-only-token' }, CF_ACCOUNT_ID: { get: async () => 'a'.repeat(32) }, SEED_WORKER_NAME: 'daily-seed-serve' };
  await expect(worker.scheduled({}, env, {})).rejects.toThrow('Asset upload session failed (HTTP 403).');
});
it('publishes CORS as asset configuration and uploads text with its MIME type', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let manifest: any, metadata: any, uploads: FormData | undefined;
  const network = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('takapuoli')) return new Response('daily;1191638428');
    if (input.includes('current_seed')) return new Response('1818269278');
    if (input.includes('assets-upload-session')) {
      manifest = JSON.parse(String(init!.body)).manifest;
      return Response.json({ result: { jwt: 'test-only-upload', buckets: [Object.values(manifest).map((entry: any) => entry.hash)] } });
    }
    if (input.includes('/assets/upload')) { uploads = init!.body as FormData; return Response.json({ result: { jwt: 'test-only-completion' } }); }
    if (input.includes('/scripts/')) { metadata = JSON.parse(await ((init!.body as FormData).get('metadata') as Blob).text()); return Response.json({ success: true }); }
    if (input.includes('gitlab')) return Response.json({ id: 1, web_url: 'https://gitlab.test/pipeline/1' });
    throw Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', network);
  await worker.scheduled({}, { CF_API_TOKEN: { get: async () => 'test-only-token' }, CF_ACCOUNT_ID: { get: async () => 'a'.repeat(32) },
    SEED_WORKER_NAME: 'daily-seed-serve', GITLAB_BIOME_BAKER_TRIGGER_TOKEN: { get: async () => 'test-only-trigger' } }, {});
  expect(Object.keys(manifest).sort()).toEqual(['/current_seed.txt', '/previous_seed.txt']);
  expect(metadata.assets.config._headers).toContain('Access-Control-Allow-Origin: *');
  expect(metadata.assets.config._headers).toContain('/previous_seed.txt');
  const files = [...uploads!.values()] as File[];
  expect(files).toHaveLength(2);
  for (const file of files) expect(file.type).toBe('text/plain; charset=utf-8');
  const contents = await Promise.all(files.map(async file => Buffer.from(await file.text(), 'base64').toString()));
  expect(contents.sort()).toEqual(['1191638428\n', '1818269278\n']);
});
it('prepares the one-time header repair without changing either published seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-repair-test-'));
  try {
    const fetcher = vi.fn(async (url: string) => new Response(url.includes('current_seed') ? '1191638428\r\n' : '1818269278\n'));
    const result = await prepareHeaderRepair(directory, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readFile(join(directory, 'public/current_seed.txt'), 'utf8')).toBe('1191638428\r\n');
    expect(await readFile(join(directory, 'public/previous_seed.txt'), 'utf8')).toBe('1818269278\n');
    expect(await readFile(join(directory, 'public/_headers'), 'utf8')).toContain('Access-Control-Allow-Origin: *');
    const config = JSON.parse(await readFile(result.config, 'utf8'));
    expect(config).toMatchObject({ name: 'daily-seed-serve', account_id: '666c045f38dd332e459bfe2a18c4e9a9' });
    expect(config).not.toHaveProperty('main');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('refuses to prepare a seed repair if the remote seed returns an error page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-repair-test-'));
  try {
    await expect(prepareHeaderRepair(directory, async () => new Response('<html>Error</html>'))).rejects.toThrow('Invalid');
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
