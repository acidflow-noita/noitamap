#!/usr/bin/env node
// CI-only isolated builds. Never run another revision's generators in the
// working checkout, and never pull the private Pro repository or credentials.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
if (process.env.CI !== 'true') throw Error('This builder is CI-only. For local checks pass prebuilt roots to performance/run.mjs.');
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const repository = process.cwd(), output = resolve(process.env.RUNNER_TEMP || '/tmp', 'noitamap-performance');
mkdirSync(output, { recursive: true });
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr);
  return result.stdout.trim();
};
const variants = [
  { label: 'candidate', commit: git('rev-parse', 'HEAD') },
  { label: 'previous', commit: git('rev-parse', 'HEAD^1') },
  { label: 'reference', commit: git('rev-parse', `${config.referenceCommit}^{commit}`) },
];
for (const variant of variants) {
  const directory = join(output, variant.label), logPath = join(output, variant.label + '-build.log');
  git('worktree', 'add', '--detach', directory, variant.commit);
  const fd = openSync(logPath, 'w');
  try {
    for (const [command, args] of [
      ['git', ['submodule', 'update', '--init', '--recursive', '--depth=1']],
      ['npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts']],
      ['npm', ['run', 'build']],
    ]) {
      console.log(`${variant.label}: ${command} ${args.join(' ')}`);
      const result = spawnSync(command, args, { cwd: directory, stdio: ['ignore', fd, fd] });
      if (result.status !== 0) throw Error(`${variant.label} build failed; see ${logPath}`);
    }
  } finally { closeSync(fd); }
  variant.root = join(directory, 'dist');
}
writeFileSync('performance-versions.json', JSON.stringify(variants, null, 2));
