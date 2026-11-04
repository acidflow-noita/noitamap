import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface CommandOptions { cwd: string; env: NodeJS.ProcessEnv; log: (line: string) => void }
export type PagesCommand = (command: string, args: string[], options: CommandOptions) => Promise<void>;
const runPagesCommand: PagesCommand = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const readers = [child.stdout, child.stderr].map(stream => createInterface({ input: stream }));
  for (const reader of readers) reader.on('line', options.log);
  child.on('error', reject);
  child.on('close', (code, signal) => {
    readers.forEach(reader => reader.close());
    if (code === 0) resolve();
    else reject(new Error(`Wrangler Pages deployment failed (${signal ?? code}); see the project-prefixed output above.`));
  });
});

/** Wrangler's structured record, not its colored/user-facing stdout, identifies
 * the immutable deployment. Reject aliases, other projects and stale records. */
export function readPagesDeployment(output: string, project: string, host: string): string {
  if (output.length > 1024 ** 2) throw new Error('Wrangler deployment output is too large.');
  let records: any[];
  try { records = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error(`Invalid Wrangler deployment record for ${project}.`); }
  const matches = records.filter(record => record?.type === 'pages-deploy');
  if (matches.length !== 1 || matches[0].version !== 1 || matches[0].pages_project !== project
    || !/^[a-f0-9-]{36}$/.test(matches[0].deployment_id)) throw new Error(`Missing or mismatched Wrangler deployment record for ${project}.`);
  let url: URL;
  try { url = new URL(matches[0].url); } catch { throw new Error(`Invalid Pages URL for ${project}.`); }
  const name = url.hostname.slice(0, 8);
  if (!/^[a-f0-9]{8}$/.test(name) || url.hostname !== `${name}.${host}` || url.protocol !== 'https:'
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`Wrangler returned an unexpected Pages URL for ${project}.`);
  return url.origin;
}

export async function deployPagesDirectory(options: {
  directory: string; project: string; host: string; account: string; token: string; wrangler: string;
  env: NodeJS.ProcessEnv; run?: PagesCommand; log?: (line: string) => void;
}): Promise<string> {
  // Outside the uploaded directory, with one output file per concurrent deploy.
  const temporary = await mkdtemp(join(tmpdir(), 'guessr-pages-'));
  const file = join(temporary, 'deployment.jsonl');
  const env: NodeJS.ProcessEnv = { ...options.env, CLOUDFLARE_ACCOUNT_ID: options.account, CLOUDFLARE_API_TOKEN: options.token,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'info', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_OUTPUT_FILE_PATH: file, FORCE_COLOR: '0' };
  delete env.GUESSR_DAILY_PUBLISH_SECRET; delete env.DAILY_PUBLISH_SECRET;
  const hidden = [options.token, options.env.GUESSR_DAILY_PUBLISH_SECRET, options.env.DAILY_PUBLISH_SECRET].filter((value): value is string => !!value);
  const log = (line: string) => {
    for (const value of hidden) line = line.replaceAll(value, '[redacted]');
    (options.log ?? console.log)(`[Guessr daily: ${options.project}] ${line}`);
  };
  try {
    await (options.run ?? runPagesCommand)(process.execPath, [options.wrangler, 'pages', 'deploy', options.directory,
      '--project-name', options.project, '--branch', 'daily-images', '--commit-dirty=true'], { cwd: options.directory, env, log });
    if ((await stat(file)).size > 1024 ** 2) throw new Error('Wrangler deployment output is too large.');
    const url = readPagesDeployment(await readFile(file, 'utf8'), options.project, options.host);
    log(`Immutable deployment ready: ${url}`);
    return url;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
