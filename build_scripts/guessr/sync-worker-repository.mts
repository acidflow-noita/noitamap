/** Synchronize reviewed Worker source into an existing private checkout.
 * Does not copy secrets/assets, install packages, commit, push, or deploy. */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateOutput } from './private-output.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argument = process.argv.find(value => value.startsWith('--repo='));
if (!argument) throw Error('Use --repo=<existing ignored private checkout>.');
const target = privateOutput(resolve(argument.slice(7)));
const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
if (resolve(git('rev-parse', '--show-toplevel')) !== target) throw Error('Target must be its own Git checkout.');
if (git('status', '--porcelain')) throw Error('Commit or preserve the private checkout’s current edits before synchronizing.');
const worker = join(root, 'workers/noitamap-guessr'), files = new Set<string>();
for (const name of ['tsconfig.json', 'test/tsconfig.json']) {
  const path = join(worker, name), config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error) throw Error('Could not read Worker TypeScript configuration.');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path));
  for (const source of ts.createProgram(parsed.fileNames.filter(file => !file.endsWith('/auth-sessions.runtime.ts')), parsed.options).getSourceFiles()) {
    if (!source.fileName.startsWith(root + '/') || source.fileName.includes('/node_modules/')) continue;
    if (!source.fileName.startsWith(worker + '/') && !source.fileName.startsWith(join(root, 'src/guessr/'))
      && !['tests/helpers/guessr-stream.ts', 'tests/helpers/game-ticket-keys.ts', 'workers/noitamap-auth/src/game-ticket.ts'].includes(relative(root, source.fileName)))
      throw Error('Unexpected shared source dependency: ' + relative(root, source.fileName));
    files.add(source.fileName);
  }
}
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // This cross-service contract belongs only to the public combined checkout.
    if (path.endsWith('/auth-sessions.runtime.ts')) continue;
    if (entry.isSymbolicLink()) throw Error('Refusing a symbolic link in source input.');
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:ts|json|sql)$/.test(entry.name)) files.add(path);
    else throw Error('Unexpected source file: ' + relative(root, path));
  }
}
for (const directory of ['src', 'test', 'migrations']) await collect(join(worker, directory));
const configuration = await readFile(join(target, 'workers/noitamap-guessr/wrangler.jsonc'), 'utf8');
if (!configuration.includes('"directory": "../../private-assets"')) throw Error('Review the private asset binding before synchronizing.');
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'worker-configuration.d.ts', 'README.md']) files.add(join(worker, name));
// Retire tracked managed source that was deleted upstream; never prune assets,
// local credentials, recovery data, or arbitrary untracked work.
const expected = new Set([...files].map(file => relative(root, file)));
for (const file of git('ls-files').split('\n')) {
  if (/^(?:workers\/noitamap-guessr\/(?:src|test|migrations)\/|src\/guessr\/)/.test(file) && !expected.has(file))
    await rm(join(target, file));
}
const publicConfiguration = await readFile(join(worker, 'wrangler.jsonc'), 'utf8');
await writeFile(join(target, 'workers/noitamap-guessr/wrangler.jsonc'),
  publicConfiguration.replace('"directory": "../../task/guessr/private/worker-assets"', '"directory": "../../private-assets"'));
for (const file of files) {
  const destination = join(target, relative(root, file));
  if (file.endsWith('/worker-configuration.d.ts')) {
    const [incoming, existing] = await Promise.all([readFile(file, 'utf8'), readFile(destination, 'utf8').catch(() => '')]);
    if (incoming.replace(/[ \t]+$/gm, '') === existing.replace(/[ \t]+$/gm, '')) continue;
  }
  await mkdir(dirname(destination), { recursive: true }); await copyFile(file, destination);
}
console.log(JSON.stringify({ sourceFiles: files.size, repository: target, assetsCopied: false, secretsCopied: false, deployed: false }));
