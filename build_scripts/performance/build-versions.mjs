#!/usr/bin/env node
// CI-only isolated builds. Never run another revision's generators in the
// working checkout, and never pull the private Pro repository or credentials.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runBuildCommand(command, args, { cwd, fd, label, logPath, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const started = Date.now(), grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, detached: grouped, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }, timeoutMs);
    const heartbeat = setInterval(() => console.log(`[Performance build] ${label}: ${command} still running (${Math.round((Date.now() - started) / 1000)}s)`), 15000);
    const cleanup = () => { clearTimeout(timer); clearInterval(heartbeat); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0 && !timedOut) resolve();
      else reject(Error(`${label}: ${command} ${timedOut ? `timed out after ${timeoutMs / 1000}s` : `failed (${signal || code})`}; see ${logPath}`));
    });
  });
}

/** @param {{ repository?: string, output?: string, referenceCommit?: string }} [options] */
export async function buildVersions(options = {}) {
  if (process.env.CI !== 'true') throw Error('This builder is CI-only. For local checks pass prebuilt roots to performance/run.mjs.');
  const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const repository = resolve(options.repository ?? process.cwd());
  const output = resolve(options.output ?? join(process.env.RUNNER_TEMP || '/tmp', 'noitamap-performance'));
  mkdirSync(output, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 60000 });
    if (result.error || result.status !== 0) throw result.error || Error(result.stderr);
    return result.stdout.trim();
  };
  const variants = [
    { label: 'candidate', commit: git('rev-parse', 'HEAD') },
    { label: 'previous', commit: git('rev-parse', 'HEAD^1') },
    { label: 'reference', commit: git('rev-parse', `${options.referenceCommit ?? config.referenceCommit}^{commit}`) },
  ];
  // Local clones share Git object bytes, but keep submodule/config writes
  // isolated. Only the later browser measurements require a quiet runner.
  const results = await Promise.allSettled(variants.map(async variant => {
    const directory = join(output, variant.label), logPath = join(output, variant.label + '-build.log');
    const fd = openSync(logPath, 'w');
    try {
      for (const [command, args] of [
        ['git', ['clone', '--local', '--no-checkout', repository, directory]],
        ['git', ['checkout', '--detach', variant.commit]],
        ['git', ['submodule', 'update', '--init', '--recursive', '--depth=1']],
        ['npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts']],
        ['npm', ['run', 'build']],
      ]) {
        console.log(`[Performance build] ${variant.label}: ${command} ${args.join(' ')}`);
        await runBuildCommand(command, args, { cwd: args[0] === 'clone' ? output : directory, fd, label: variant.label, logPath });
      }
    } finally { closeSync(fd); }
    variant.root = join(directory, 'dist');
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Performance build preparation failed');
  writeFileSync(join(repository, 'performance-versions.json'), JSON.stringify(variants, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildVersions();
