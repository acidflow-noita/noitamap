#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, lstat, copyFile, link, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labels = ['candidate', 'previous', 'reference'];
const scripts = ['run.mjs', 'compare.mjs', 'daily-preflight.mjs', 'daily-fixture.mjs', 'trials.mjs', 'config.json', 'check-runtime.mjs'];

/** Relocatable public builds and the installed, locked Playwright runtime.
 * No source worktrees, Git metadata, credentials or other node_modules enter
 * this artifact. Hard links let tar store common static files only once. */
export async function packageVersions(versionsFile, output, scriptsRoot = here) {
  const variants = JSON.parse(await readFile(versionsFile, 'utf8'));
  if (!Array.isArray(variants) || variants.length !== 3 || labels.some(label => variants.filter(v => v.label === label).length !== 1)
    || variants.some(v => !/^[a-f0-9]{40}$/.test(v.commit) || typeof v.root !== 'string')) throw Error('Expected three identified public builds');
  const roots = variants.map(v => ({ ...v, root: resolve(dirname(versionsFile), v.root) }));
  const runtime = join(dirname(roots.find(v => v.label === 'candidate').root), 'node_modules');
  const packages = await Promise.all(['playwright', 'playwright-core'].map(async name => ({ name,
    metadata: JSON.parse(await readFile(join(runtime, name, 'package.json'), 'utf8')) })));
  const version = packages[0].metadata.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || packages.some(p => p.metadata.version !== version || p.metadata.name !== p.name)
    || packages.some(p => Object.keys(p.metadata.dependencies ?? {}).some(name => name !== 'playwright-core')
      || Object.keys(p.metadata.optionalDependencies ?? {}).some(name => name !== 'fsevents')))
    throw Error('Unexpected Playwright runtime dependency; review packaging before changing versions');
  const image = `mcr.microsoft.com/playwright:v${version}-noble`;
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, 'bundle-')), seen = new Map();
  const stats = { files: 0, totalBytes: 0, uniqueBytes: 0 };
  async function copy(source, destination) {
    if (/^(?:\.git|\.npmrc|\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(basename(source)))
      throw Error('Refusing private configuration in performance build: ' + source);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw Error('Refusing symlink in performance build: ' + source);
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      for (const name of (await readdir(source)).sort()) await copy(join(source, name), join(destination, name));
    } else if (info.isFile()) {
      const mode = info.mode & 0o777;
      const key = createHash('sha256').update(await readFile(source)).digest('hex') + ':' + mode;
      stats.files++; stats.totalBytes += info.size;
      if (seen.has(key)) await link(seen.get(key), destination);
      else { await copyFile(source, destination); await chmod(destination, mode); seen.set(key, destination); stats.uniqueBytes += info.size; }
    } else throw Error('Unexpected file in performance build: ' + source);
  }
  const archive = resolve(output, 'performance-build.tar.gz');
  try {
    for (const variant of roots) await copy(variant.root, join(staging, variant.label));
    await mkdir(join(staging, 'harness', 'node_modules'), { recursive: true });
    for (const file of scripts) await copy(join(scriptsRoot, file), join(staging, 'harness', file));
    // The optional fsevents dependency is macOS-only. Benchmark runners are Linux.
    for (const { name } of packages) await copy(join(runtime, name), join(staging, 'harness', 'node_modules', name));
    await writeFile(join(staging, 'performance-versions.json'), JSON.stringify(variants.map(({ label, commit }) => ({ label, commit, root: label })), null, 2));
    const compressed = spawnSync('tar', ['-I', 'gzip -1', '-cf', archive, '-C', staging, '.'], { encoding: 'utf8', timeout: 120000 });
    if (compressed.error || compressed.status !== 0) throw compressed.error || Error(compressed.stderr);
    const archiveBytes = (await lstat(archive)).size;
    if (archiveBytes > 256 * 1024 * 1024) throw Error('Shared performance archive exceeds 256 MiB; inspect its contents before uploading');
    const manifest = { schemaVersion: 1, ...stats, archiveBytes, playwrightVersion: version, image };
    await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2));
    return { archive, ...manifest };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageVersions(resolve(process.argv[2] || 'performance-versions.json'), resolve(process.argv[3] || 'performance-package'));
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
    `archive=${result.archive}\nplaywright-image=${result.image}\n`, { flag: 'a' });
}
