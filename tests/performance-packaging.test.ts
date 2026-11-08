import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageVersions } from '../build_scripts/performance/package-versions.mjs';
import { runBuildCommand, buildVersions } from '../build_scripts/performance/build-versions.mjs';

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'noitamap-perf-package-')); temporary.push(root);
  const variants = ['candidate', 'previous', 'reference'].map((label, i) => ({ label, commit: String(i + 1).repeat(40), root: join(root, label, 'dist') }));
  for (const variant of variants) {
    await mkdir(variant.root, { recursive: true });
    await writeFile(join(variant.root, 'index.html'), '<title>' + variant.label + '</title>');
    await writeFile(join(variant.root, 'common.bin'), Buffer.alloc(8192, 73));
    await writeFile(join(root, variant.label, '.env'), 'TEST_ONLY_PRIVATE_INPUT=never-package');
  }
  const runtime = join(root, 'candidate', 'node_modules');
  for (const name of ['playwright', 'playwright-core']) {
    await mkdir(join(runtime, name), { recursive: true });
    await writeFile(join(runtime, name, 'package.json'), JSON.stringify({ name, version: '1.60.0',
      ...(name === 'playwright' ? { dependencies: { 'playwright-core': '1.60.0' } } : {}) }));
    await writeFile(join(runtime, name, 'index.js'), 'module.exports = {};');
  }
  await mkdir(join(runtime, 'unrelated'), { recursive: true });
  await writeFile(join(runtime, 'unrelated', 'unused.js'), 'Do not include application dependencies');
  const versions = join(root, 'versions.json'); await writeFile(versions, JSON.stringify(variants));
  return { root, variants, runtime, versions, output: join(root, 'package') };
}

it('ships relocatable public builds, deduplicates shared bytes and includes only the locked browser runtime', async () => {
  const f = await fixture(), result = await packageVersions(f.versions, f.output);
  expect(result.image).toBe('mcr.microsoft.com/playwright:v1.60.0-noble');
  expect(result.uniqueBytes).toBeLessThan(result.totalBytes - 16383);
  const extracted = join(f.root, 'another-runner'); await mkdir(extracted);
  const extraction = spawnSync('tar', ['-xzf', result.archive, '-C', extracted], { encoding: 'utf8' });
  expect(extraction.error).toBeUndefined(); expect(extraction.status, extraction.stderr).toBe(0);
  const versions = JSON.parse(await readFile(join(extracted, 'performance-versions.json'), 'utf8'));
  for (const variant of versions) {
    expect(variant.root).toBe(variant.label);
    expect(await readFile(join(resolve(extracted, variant.root), 'index.html'), 'utf8')).toContain(variant.label);
    await expect(access(join(extracted, variant.label, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect((await stat(join(extracted, 'candidate/common.bin'))).ino).toBe((await stat(join(extracted, 'previous/common.bin'))).ino);
  expect(JSON.parse(await readFile(join(extracted, 'harness/node_modules/playwright/package.json'), 'utf8')).version).toBe('1.60.0');
  await expect(access(join(extracted, 'harness/node_modules/unrelated'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(extracted, 'harness/run.mjs'))).resolves.toBeUndefined();
  await expect(access(join(extracted, 'harness/check-runtime.mjs'))).resolves.toBeUndefined();
});

it('rejects mismatched runtime versions before generating an uploadable bundle', async () => {
  const f = await fixture();
  await writeFile(join(f.runtime, 'playwright-core/package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }));
  await expect(packageVersions(f.versions, f.output)).rejects.toThrow('Unexpected Playwright');
  await expect(access(join(f.output, 'performance-build.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not follow a build symlink into source or credentials', async () => {
  const f = await fixture();
  await symlink('../.env', join(f.variants[0].root, 'private-link'));
  await expect(packageVersions(f.versions, f.output)).rejects.toThrow('Refusing symlink');
  await expect(access(join(f.output, 'performance-build.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects private configuration accidentally copied into a public build', async () => {
  const f = await fixture(); await writeFile(join(f.variants[0].root, '.env.local'), 'TEST_ONLY_PRIVATE_INPUT=do-not-upload');
  await expect(packageVersions(f.versions, f.output)).rejects.toThrow('Refusing private configuration');
});

it('refuses a missing or unidentified comparison revision', async () => {
  const f = await fixture(); await writeFile(f.versions, JSON.stringify(f.variants.slice(0, 2)));
  await expect(packageVersions(f.versions, f.output)).rejects.toThrow('three identified');
});

it('terminates a stuck preparation command and identifies the failed stage', async () => {
  const f = await fixture(), logPath = join(f.root, 'build.log'), fd = openSync(logPath, 'w');
  try {
    await expect(runBuildCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { cwd: f.root, fd, label: 'candidate', logPath, timeoutMs: 100 })).rejects.toThrow('timed out after 0.1s');
    await expect(runBuildCommand(process.execPath, ['-e', "console.error('fixture failure'); process.exit(7)"],
      { cwd: f.root, fd, label: 'reference', logPath, timeoutMs: 5000 })).rejects.toThrow('failed (7)');
  } finally { closeSync(fd); }
  expect(await readFile(logPath, 'utf8')).toContain('fixture failure');
});

it('does not build other revisions outside CI', async () => {
  vi.stubEnv('CI', 'false');
  await expect(buildVersions()).rejects.toThrow('CI-only');
});

it('builds three fixture revisions concurrently without changing the source checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noitamap-perf-builder-')); temporary.push(root);
  const repository = join(root, 'repository'), output = join(root, 'builds'), gate = join(root, 'gate');
  await mkdir(repository); await mkdir(gate);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  git('init', '--quiet');
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'performance-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' } }));
  await writeFile(join(repository, 'package-lock.json'), JSON.stringify({ name: 'performance-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'performance-fixture', version: '1.0.0' } } }));
  await writeFile(join(repository, 'build.cjs'), `
    const fs=require('node:fs'),path=require('node:path'),gate=process.env.PERF_FIXTURE_GATE;
    fs.writeFileSync(path.join(gate,path.basename(process.cwd())), 'started');
    const timeout=setTimeout(()=>process.exit(9),10000);
    const wait=setInterval(()=>{
      if(fs.readdirSync(gate).length!==3)return;
      clearTimeout(timeout);clearInterval(wait);fs.mkdirSync('dist');
      fs.copyFileSync('value.txt','dist/index.html');
    },10);
  `);
  const commits: string[] = [];
  for (const value of ['reference', 'previous', 'candidate']) {
    await writeFile(join(repository, 'value.txt'), value); git('add', '.');
    git('-c', 'user.name=Performance Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    commits.push(git('rev-parse', 'HEAD'));
  }
  vi.stubEnv('CI', 'true'); vi.stubEnv('PERF_FIXTURE_GATE', gate);
  await buildVersions({ repository, output, referenceCommit: commits[0] });
  const versions = JSON.parse(await readFile(join(repository, 'performance-versions.json'), 'utf8'));
  expect(versions.map((v: any) => v.commit)).toEqual([...commits].reverse());
  for (const variant of versions) expect(await readFile(join(variant.root, 'index.html'), 'utf8')).toBe(variant.label);
  expect(git('rev-parse', 'HEAD')).toBe(commits[2]);
  await expect(access(join(repository, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);
