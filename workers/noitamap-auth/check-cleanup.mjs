/** Host-only, read-only rollout check. Never displays credential values. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const primary = '666c045f38dd332e459bfe2a18c4e9a9';
export function runWrangler(directory, args) {
  return new Promise((done, reject) => {
    const cli = resolve(directory, 'node_modules/wrangler/bin/wrangler.js');
    if (!existsSync(cli)) return reject(Error('Run npm ci in the auth Worker folder first.'));
    const child = spawn(process.execPath, [cli, ...args, '--config', resolve(directory, 'wrangler.jsonc')], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: primary, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    const output = [], errors = []; let size = 0;
    const collect = target => chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) child.kill(); else target.push(chunk);
    };
    child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors));
    child.on('error', () => reject(Error('Could not start the local Wrangler CLI.')));
    const timer = setTimeout(() => child.kill(), 45000);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) }); });
  });
}
export async function checkCleanup(run, fetcher = fetch) {
  const report = {};
  for (const [key, url, disabled] of [
    ['productionAuthV2', 'https://noitamap-auth.wuote.workers.dev/auth/result-ticket', false],
    ['developmentAuthDisabled', 'https://noitamap-auth-dev.wuote.workers.dev/auth/check', true],
  ]) {
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      report[key] = disabled ? response.status === 503 && (await response.text()) === 'Authentication is not configured for this environment.' : response.status === 405;
    } catch { report[key] = false; }
  }
  const query = "SELECT COUNT(*) AS remaining FROM auth_identities WHERE credentials<>'' AND credentials NOT LIKE 'c2.1.%'";
  const count = await run(['d1', 'execute', 'ACCOUNT_DB', '--remote', '--json', '--command', query]);
  try {
    if (count.code !== 0) throw Error();
    const data = JSON.parse(count.stdout.toString('utf8'));
    const groups = Array.isArray(data) ? data : data.result || [data];
    const remaining = groups.flatMap(group => group.results || []).find(row => Number.isSafeInteger(row.remaining) && row.remaining >= 0)?.remaining;
    report.legacyCredentialRows = remaining ?? 'CHECK FAILED';
  } catch { report.legacyCredentialRows = 'CHECK FAILED'; }
  finally { count.stdout.fill(0); count.stderr.fill(0); }

  // Binary mode writes directly to captured stdout. Do not use --text, which
  // routes credential content through Wrangler's logger.
  const kv = await run(['kv', 'key', 'get', 'broadcaster-token-v1', '--binding', 'TWITCH_TOKEN_STORE', '--remote']);
  report.broadcasterKv = kv.code === 0 ? kv.stdout.subarray(0, 5).toString() === 'c2.1.' ? 'encrypted' : 'NOT MIGRATED'
    : /\b404\b/.test(kv.stderr.toString()) ? 'absent' : 'CHECK FAILED';
  kv.stdout.fill(0); kv.stderr.fill(0);
  for (const [field, name] of [['oldGameSecretOnAuth', 'noitamap-auth'], ['oldGameSecretOnDevAuth', 'noitamap-auth-dev']]) {
    const result = await run(['secret', 'list', '--name', name, '--format', 'json']);
    try {
      if (result.code !== 0) throw Error();
      const names = JSON.parse(result.stdout.toString('utf8'));
      if (!Array.isArray(names)) throw Error();
      report[field] = names.some(secret => secret.name === 'GAME_SIGNING_SECRET') ? 'present' : 'absent';
    } catch { report[field] = 'CHECK FAILED'; }
    finally { result.stdout.fill(0); result.stderr.fill(0); }
  }
  report.readyToRemoveLegacyCredentialBinding = report.productionAuthV2 && report.developmentAuthDisabled
    && report.legacyCredentialRows === 0 && ['encrypted', 'absent'].includes(report.broadcasterKv);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] || process.cwd());
  try { console.log(JSON.stringify(await checkCleanup(args => runWrangler(directory, args)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
