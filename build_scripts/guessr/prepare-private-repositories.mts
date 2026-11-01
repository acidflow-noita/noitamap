/** Prepare self-contained private repository folders. Does not initialize Git,
 * stage files, push, create repositories or change Cloudflare deployments. */
import ts from 'typescript';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateOutput } from './private-output.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argument = process.argv.find(value => value.startsWith('--out='));
const backgroundArgument = process.argv.find(value => value.startsWith('--background='));
if (!argument || !backgroundArgument) throw new Error('Use --out=<new ignored directory> --background=<prepared background-site>.');
const backgroundDirectory = resolve(backgroundArgument.slice(13));
const output = privateOutput(resolve(argument.slice(6)));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Repository preparation needs an empty output directory.');

const ignore = `node_modules/\ndist/\n.wrangler/\n.env\n.env.*\n*.env\n*.env.*\n!.env.example\n!*.env.example\n.dev.vars\n.dev.vars.*\n!.dev.vars.example\n*-secrets.json\n`;
async function copy(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
async function copyTree(source: string, destination: string) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Refusing a symlink in repository input: ' + entry.name);
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await copy(from, to);
  }
}

const assetBuilder = `import { cp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const background = process.env.CF_PAGES_BRANCH === 'background';
const configuration = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'deployment.json'), 'utf8'));
if (background && !configuration.background) throw new Error('This project has no background branch.');
const source = join(root, background ? 'background' : 'public');
const allowed = configuration.kind === 'clues'
  ? /^(?:_headers|dataset\\.json|images\\/[a-f0-9]{32}\\.webp)$/
  : background ? /^(?:_headers|background\\.json|map_files\\/\\d+\\/\\d+_\\d+\\.webp)$/
  : /^(?:_headers|map\\.dzi|map_files\\/\\d+\\/\\d+_\\d+\\.webp)$/;
let count = 0;
async function validate(directory, prefix = '') {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + file.name, path = join(directory, file.name);
    if (file.isDirectory()) { await validate(path, name + '/'); continue; }
    const info = await stat(path);
    if (!file.isFile() || !allowed.test(name) || !info.size || info.size > 25 * 1024 ** 2)
      throw new Error('Unexpected or oversized public file: ' + name);
    if (++count > 20000) throw new Error('Pages Free file limit exceeded.');
  }
}
await validate(source);
await rm(join(root, 'dist'), { recursive: true, force: true });
await cp(source, join(root, 'dist'), { recursive: true });
console.log('Prepared ' + count + ' public files in dist/');
`;

for (const [name, source, kind, domain] of [
  ['noitaguessr-tiles', 'task/guessr/opaque-site', 'clues', 'guessr-tiles.sage-data.xyz'],
  ['noitaguessr-map', 'task/guessr/reference-site', 'reference', 'guessr-map.sage-data.xyz'],
] as const) {
  const project = join(output, name);
  await copyTree(join(root, source), join(project, 'public'));
  if (kind === 'reference') await copyTree(backgroundDirectory, join(project, 'background'));
  await writeFile(join(project, '.gitignore'), ignore);
  await writeFile(join(project, 'build.mjs'), assetBuilder);
  const pkg = { name, version: '1.0.0', private: true, type: 'module', scripts: { build: 'node build.mjs' } };
  await writeFile(join(project, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(join(project, 'package-lock.json'), JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name, version: '1.0.0' } } }, null, 2) + '\n');
  await writeFile(join(project, 'deployment.json'), JSON.stringify({ kind, background: kind === 'reference',
    accountId: '3d75ffad634d443fca37da68c0ed4f3c', existingProject: name,
    domain, productionBranch: 'main', rootDirectory: '', buildCommand: 'npm run build', outputDirectory: 'dist' }, null, 2) + '\n');
  await writeFile(join(project, 'README.md'), `# ${name}\n\nPrivate source repository for the ${kind} images.\n\n` +
    'Cloudflare Pages: connect this private repository, production branch `main`, build command `npm run build`, output directory `dist`.\n\n' +
    'The build validates and copies the existing image files; it does not slice the map or generate new puzzles. No secrets are required for native Pages builds.\n\n' +
    (kind === 'reference' ? 'The `background/` directory preserves the clean static background. A `background` Git branch pointing at this source deploys that directory instead of the reference map. Pin the resulting immutable `/background.json` URL in the Daily baker.\n\n' : '') +
    `Use the existing Pages project \`${name}\` and its custom domain \`${domain}\`. These projects support their configured Git connections in place. Publish only \`dist/\`, not the repository root, so image URLs and the Pages file limit remain correct. Existing immutable background deployments can stay in use.\n`);
}

const worker = join(root, 'workers/noitamap-guessr');
const project = join(output, 'noitamap-guessr');
const destination = join(project, 'workers/noitamap-guessr');
const shared = new Set<string>();
for (const name of ['tsconfig.json', 'test/tsconfig.json']) {
  const configPath = join(worker, name), config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(root + '/') || source.fileName.includes('/node_modules/') || source.fileName.startsWith(worker + '/')) continue;
    if (!source.fileName.startsWith(join(root, 'src/guessr/'))) throw new Error('Unexpected shared dependency: ' + source.fileName);
    shared.add(source.fileName);
  }
}
for (const name of ['src', 'test', 'migrations']) await copyTree(join(worker, name), join(destination, name));
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'worker-configuration.d.ts'])
  await copy(join(worker, name), join(destination, name));
for (const file of shared) await copy(file, join(project, relative(root, file)));
let configuration = await readFile(join(worker, 'wrangler.jsonc'), 'utf8');
const old = '"directory": "../../task/guessr/private/worker-assets"';
if (!configuration.includes(old)) throw new Error('The private asset binding has changed; review the export.');
configuration = configuration.replace(old, '"directory": "../../private-assets"');
await writeFile(join(destination, 'wrangler.jsonc'), configuration);
await copyTree(join(root, 'task/guessr/private/worker-assets'), join(project, 'private-assets'));
await writeFile(join(project, '.gitignore'), ignore);
await copy(join(root, 'LICENSE'), join(project, 'LICENSE'));
await writeFile(join(project, 'README.md'), '# NoitaGuessr API\n\n' +
  'This repository must remain private: `private-assets/` contains the answer/image lookup and valid-start samplers. It contains no login or deployment secrets.\n\n' +
  'Cloudflare Workers Builds: connect the existing `noitamap-guessr` Worker in account `3d75ffad634d443fca37da68c0ed4f3c`. Use `workers/noitamap-guessr` as the root directory, `npm run typecheck` as the build command, and `npx wrangler deploy` as the deploy command.\n\n' +
  'For local checks, enter that directory, run `npm ci`, `npm run typecheck`, `npm test`, and `npx wrangler deploy --dry-run`.\n\n' +
  'The existing D1 database, Durable Object namespace and secrets remain in Cloudflare. Apply new D1 migrations deliberately before deploying code that needs them. The `ASSETS` binding must keep `run_worker_first: true`; direct HTTP access to private data is rejected.\n\n' +
  'Shared protocol modules are included under `src/guessr/`; this project does not depend on another VM checkout. Updates to the frontend protocol must be synchronized with this service.\n');
await writeFile(join(output, 'PREPARATION.json'), JSON.stringify({ preparedAt: new Date().toISOString(), projects: ['noitaguessr-tiles', 'noitaguessr-map', 'noitamap-guessr'],
  sharedModules: shared.size, remoteRepositoriesCreated: false, gitStaged: false,
  captureBackup: { path: 'task/guessr/full_map.png', instruction: 'Preserve the original capture as an asset of a private GitHub release. It exceeds the 100 MiB Git file limit; do not add it to a Git commit.' },
}, null, 2) + '\n');
console.log(JSON.stringify({ directory: output, projects: 3, sharedModules: shared.size, staged: false, deployed: false }));
