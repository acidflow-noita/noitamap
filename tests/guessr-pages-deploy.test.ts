import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deployPagesDirectory, readPagesDeployment } from '../build_scripts/guessr/pages-deploy.mts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'guessr-pages-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const record = { type: 'pages-deploy', version: 1, pages_project: 'noitaguessr-map',
  deployment_id: 'd4636d22-2630-45b5-b074-e93d8f2ce33d', url: 'https://d4636d22.noitaguessr-map.pages.dev' };

it('accepts the exact successful deployment URL rejected by the old CI output matcher', () => {
  expect(readPagesDeployment(JSON.stringify(record) + '\n', 'noitaguessr-map', 'noitaguessr-map.pages.dev')).toBe(record.url);
  expect(readPagesDeployment([record, { ...record, type: 'pages-deploy-detailed', alias: 'https://daily-images.noitaguessr-map.pages.dev' }]
    .map(row => JSON.stringify(row)).join('\r\n'), 'noitaguessr-map', 'noitaguessr-map.pages.dev')).toBe(record.url);
});

it.each([
  { url: 'https://daily-images.noitaguessr-map.pages.dev' },
  { url: 'https://d4636d22.noitaguessr-map.pages.dev.evil.test' },
  { url: 'https://d4636d22.noitaguessr-tiles.pages.dev' },
  { url: 'https://d4636d22.noitaguessr-map.pages.dev/?secret=anything' },
  { pages_project: 'noitaguessr-tiles' },
])('rejects a mismatched or non-immutable deployment record: %j', overrides => {
  expect(() => readPagesDeployment(JSON.stringify({ ...record, ...overrides }), 'noitaguessr-map', 'noitaguessr-map.pages.dev')).toThrow();
});

it('streams child output before completion and reads JSON independently of stdout or stderr formatting', async () => {
  const fake = join(directory, 'wrangler.mjs'), upload = join(directory, 'images'); await mkdir(upload);
  await writeFile(fake, `
    import { writeFile } from 'node:fs/promises';
    if (process.env.GUESSR_DAILY_PUBLISH_SECRET) process.exit(2);
    console.log('upload started, ' + process.env.CLOUDFLARE_API_TOKEN);
    await new Promise(resolve => setTimeout(resolve, 200));
    console.error('Deployment complete. Human wording deliberately contains no URL.');
    await writeFile(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(${JSON.stringify(record)}) + '\\n');
  `);
  const log = vi.fn(); let finished = false;
  const result = deployPagesDirectory({ directory: upload, project: 'noitaguessr-map', host: 'noitaguessr-map.pages.dev',
    account: 'secondary-account', token: 'private-test-token', wrangler: fake,
    env: { ...process.env, GUESSR_DAILY_PUBLISH_SECRET: 'private-signing-test-secret' }, log }).then(value => { finished = true; return value; });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[Guessr daily: noitaguessr-map] upload started, [redacted]'));
  expect(finished).toBe(false);
  expect(await result).toBe(record.url);
  expect(log.mock.calls.flat().join('\n')).not.toContain('private-test-token');
  expect(log.mock.calls.flat().join('\n')).toContain('Human wording deliberately contains no URL.');
});

it('uses separate private output files for concurrent uploads and cleans them on success or failure', async () => {
  const files: string[] = [];
  const deploy = (project: string, fail: boolean) => deployPagesDirectory({ directory, project, host: project + '.pages.dev',
    account: 'account', token: 'test-token', wrangler: 'unused', env: {}, log() {}, run: async (_command, _args, options) => {
      const file = options.env.WRANGLER_OUTPUT_FILE_PATH!; files.push(file);
      expect(file.startsWith(directory)).toBe(false);
      if (fail) throw new Error('Upload rejected');
      await writeFile(file, JSON.stringify({ ...record, pages_project: project, url: `https://d4636d22.${project}.pages.dev` }) + '\n');
    } });
  const settled = await Promise.allSettled([deploy('clues', false), deploy('reference', true)]);
  expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(new Set(files).size).toBe(2);
  for (const file of files) await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
