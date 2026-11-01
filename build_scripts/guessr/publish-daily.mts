/** Publish versioned static imagery first; activate the matching private daily last. */
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDailyPack } from '../../workers/noitamap-guessr/src/daily-publish';
import type { DailyImagePack } from '../../src/guessr/daily-pack';
import { DAILY_ROUNDS } from '../../src/guessr/daily-pack';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile);
const branch = 'daily-images';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
interface Settings {
  account: string; token: string; cluesProject: string; referenceProject: string;
  api: string; signingSecret: string;
}

export async function validatePublicDirectory(directory: string, kind: 'clues' | 'reference', expected: number) {
  let files = 0;
  async function walk(path: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name, filename = join(path, entry.name);
      if (entry.isDirectory()) { await walk(filename, relative + '/'); continue; }
      const allowed = kind === 'clues' ? /^(?:_headers|dataset\.json|images\/[a-f0-9]{32}\.webp)$/
        : /^(?:_headers|map\.dzi|map_files\/\d+\/\d+_\d+\.webp)$/;
      const stat = await lstat(filename);
      if (!allowed.test(relative) || !stat.isFile() || !stat.size || stat.size > 25 * 1024 ** 2)
        throw new Error(`Unexpected, private, or oversized file in ${kind} output: ${relative}`);
      files++;
    }
  }
  await walk(directory);
  if (files !== expected || files > 20000) throw new Error(`Invalid ${kind} file count: ${files}/${expected}.`);
  return files;
}

function settings(env: NodeJS.ProcessEnv): Settings {
  const account = env.GUESSR_CLOUDFLARE_ACCOUNT_ID || '', token = env.GUESSR_CLOUDFLARE_API_TOKEN || '';
  const cluesProject = env.GUESSR_CLUE_PROJECT || '', referenceProject = env.GUESSR_REFERENCE_PROJECT || '';
  const api = new URL(env.GUESSR_API_URL || 'https://invalid.invalid');
  const signingSecret = env.GUESSR_DAILY_PUBLISH_SECRET || '';
  if (!/^[a-f0-9]{32}$/.test(account) || !token || ![cluesProject, referenceProject].every(p => /^[a-z0-9][a-z0-9-]{0,57}$/.test(p))
      || cluesProject === referenceProject || api.hostname === 'invalid.invalid' || api.protocol !== 'https:'
      || api.username || api.password || api.port || api.pathname !== '/' || api.search || api.hash || signingSecret.length < 32)
    throw new Error('Configure the separate Guessr account, Pages projects, API origin, and publisher secret before publishing.');
  return { account, token, cluesProject, referenceProject, api: api.origin, signingSecret };
}

export async function publishDailyPackage(options: {
  directory: string;
  publish?: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  deploy?: (directory: string, project: string, settings: Settings) => Promise<string>;
  now?: number;
}) {
  const directory = resolve(options.directory), env = options.env ?? process.env, fetcher = options.fetch ?? fetch;
  const [manifest, draft] = await Promise.all([json(join(directory, 'manifest.json')), json(join(directory, 'private/daily.json'))]);
  const pack = draft as DailyImagePack;
  if (manifest.complete !== true || manifest.schemaVersion !== 1 || manifest.day !== pack.day || manifest.seed !== pack.seed
      || manifest.version !== pack.version || manifest.renderId !== pack.renderId
      || manifest.rounds !== DAILY_ROUNDS || pack.rounds.length !== DAILY_ROUNDS)
    throw new Error('Daily package is incomplete or its identities do not match.');
  await Promise.all([
    validatePublicDirectory(join(directory, 'clues'), 'clues', manifest.clueFiles),
    validatePublicDirectory(join(directory, 'reference'), 'reference', manifest.referenceFiles),
  ]);
  if (!options.publish) return { ...manifest, published: false };
  const cfg = settings(env), now = options.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10), yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  if (![today, yesterday].includes(pack.day)) throw new Error('Only today or yesterday can be published.');
  const checkSeed = async () => {
    const pointer = pack.day === new Date(options.now ?? Date.now()).toISOString().slice(0, 10) ? 'current' : 'previous';
    const response = await fetcher(`https://daily-seed.acidflow.stream/${pointer}_seed.txt`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const text = (await response.text()).trim();
    if (!response.ok || !/^\d+$/.test(text) || Number(text) !== pack.seed) throw new Error('The live daily seed changed; refusing to publish this package.');
  };
  await checkSeed();
  const hosts = new Map<string, string>();
  for (const project of [cfg.cluesProject, cfg.referenceProject]) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${cfg.account}/pages/projects/${project}`, {
      headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(15000),
    });
    const info: any = await response.json();
    if (!response.ok || !info.success || !info.result || info.result.production_branch === branch
        || typeof info.result.subdomain !== 'string' || !/^[a-z0-9-]+\.pages\.dev$/.test(info.result.subdomain))
      throw new Error('The expected Pages project is missing or its production branch conflicts with daily publication.');
    hosts.set(project, info.result.subdomain);
  }
  const deploy = options.deploy ?? (async (path: string, project: string) => {
    const wrangler = join(root, 'workers/noitamap-guessr/node_modules/wrangler/bin/wrangler.js');
    const { stdout } = await exec(process.execPath, [wrangler, 'pages', 'deploy', path, '--project-name', project,
      '--branch', branch, '--commit-dirty=true'], { cwd: path, maxBuffer: 5 * 1024 ** 2,
      env: { ...env, CLOUDFLARE_ACCOUNT_ID: cfg.account, CLOUDFLARE_API_TOKEN: cfg.token, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'info' } });
    const escaped = hosts.get(project)!.replaceAll('.', '\\.');
    const urls = stdout.match(new RegExp(`https://[a-f0-9]{8}\\.${escaped}`, 'g'));
    if (!urls?.length) throw new Error('Wrangler did not return an immutable Pages deployment URL.');
    return urls.at(-1)!;
  });
  const [clueDeployment, referenceDeployment] = await Promise.all([
    deploy(join(directory, 'clues'), cfg.cluesProject, cfg), deploy(join(directory, 'reference'), cfg.referenceProject, cfg),
  ]);
  for (const round of pack.rounds) for (const frame of round.frames) {
    const image = new URL(frame.image);
    if (image.origin !== 'https://images.invalid' || !/^\/images\/[a-f0-9]{32}\.webp$/.test(image.pathname)) throw new Error('Unexpected draft image URL.');
    frame.image = clueDeployment + image.pathname;
  }
  pack.config.map.tiles = referenceDeployment + '/map_files/';
  validateDailyPack(pack, [...hosts.values()], options.now ?? Date.now());
  const urls = [...new Set(pack.rounds.flatMap(round => round.frames.map(frame => frame.image)))];
  urls.push(referenceDeployment + '/map.dzi');
  // Verify the images players will need before exposing the new daily.
  for (const url of urls) {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    if (!response.ok || url.endsWith('.webp') && !response.headers.get('Content-Type')?.includes('image/webp'))
      throw new Error('A published daily image is not available yet; the daily was not activated.');
  }
  await checkSeed();
  const body = JSON.stringify(pack), signature = createHmac('sha256', cfg.signingSecret).update(body).digest('hex');
  const response = await fetcher(cfg.api + '/api/admin/daily', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Guessr-Publish-Signature': signature }, body, signal: AbortSignal.timeout(30000) });
  const receipt: any = await response.json();
  if (!response.ok || receipt.day !== pack.day || receipt.seed !== pack.seed || receipt.version !== pack.version)
    throw new Error(`Daily activation failed: ${typeof receipt.error === 'string' ? receipt.error : response.status}. Existing daily data remains active.`);
  const published = { ...manifest, published: true, id: receipt.id, clueDeployment, referenceDeployment };
  await writeFile(join(directory, 'publication.json'), JSON.stringify(published, null, 2) + '\n');
  return published;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv.find(arg => arg.startsWith('--input='))?.slice(8);
  if (!directory) throw new Error('Required: --input=<prepared daily directory>; add --publish to deploy.');
  console.log(JSON.stringify(await publishDailyPackage({ directory, publish: process.argv.includes('--publish') }), null, 2));
}
