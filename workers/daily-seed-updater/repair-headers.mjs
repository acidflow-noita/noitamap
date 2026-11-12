/** Run on the primary-account host. Republishes the existing two seed files with CORS. */
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const origin = 'https://daily-seed.acidflow.stream';
const primaryAccount = '666c045f38dd332e459bfe2a18c4e9a9';

/** @param {(url: string, init?: RequestInit) => Promise<Response>} fetcher */
export async function prepareHeaderRepair(destination, fetcher = fetch) {
  const names = ['current_seed.txt', 'previous_seed.txt'];
  const values = await Promise.all(names.map(async name => {
    const response = await fetcher(`${origin}/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`Cannot read ${name} (HTTP ${response.status}). Nothing deployed.`);
    const bytes = await response.arrayBuffer();
    const value = new TextDecoder().decode(bytes).trim();
    if (bytes.byteLength > 128 || !/^\d{1,10}$/.test(value) || Number(value) > 0xffffffff)
      throw Error(`Invalid ${name}. Nothing deployed.`);
    return Buffer.from(bytes);
  }));
  const assets = join(destination, 'public');
  await mkdir(assets, { recursive: true });
  for (let index = 0; index < names.length; index++) await writeFile(join(assets, names[index]), values[index]);
  const { rules } = JSON.parse(await readFile(join(directory, 'seed-headers.json'), 'utf8'));
  await writeFile(join(assets, '_headers'), rules);
  const config = join(destination, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'daily-seed-serve', account_id: primaryAccount,
    compatibility_date: '2026-06-01', assets: { directory: assets },
    routes: [{ pattern: 'daily-seed.acidflow.stream', custom_domain: true }],
    vars: { ALLOWED_ORIGINS: 'http://localhost:5173,https://noitamap.com,https://dev.noitamap.com,https://dynamic-map.noitamap.com,https://dynamic-map.noitamap.pages.dev,https://sage.runfast.stream' },
  }, null, 2));
  return { config, seed: values[0].toString().trim(), previousSeed: values[1].toString().trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const destination = await mkdtemp(join(tmpdir(), 'noitamap-seed-headers-'));
  try {
    const { config, seed, previousSeed } = await prepareHeaderRepair(destination);
    console.log(`Repairing daily-seed-serve headers. Keeping current seed ${seed} and previous seed ${previousSeed}.`);
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(directory, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', config], {
        cwd: directory, stdio: 'inherit',
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: primaryAccount, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' },
      });
      child.once('error', () => reject(Error('Cannot start Wrangler. Run npm ci in the updater folder first.')));
      child.once('close', code => done(code ?? 1));
    });
    process.exitCode = code;
    if (code === 0) console.log('Seed headers deployed. No bake was started.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await rm(destination, { recursive: true, force: true }); }
}
