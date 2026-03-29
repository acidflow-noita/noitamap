#!/usr/bin/env node
// scripts/update-telescope.cjs
//
// Automated telescope submodule update script (cross-platform).
// Pulls latest from upstream, shows what changed, runs tests + build.
// All merging/committing is MANUAL — this script never commits.

const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TELESCOPE_DIR = path.join(REPO_ROOT, 'lib', 'noita-telescope');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: opts.cwd || REPO_ROOT,
      encoding: 'utf8',
      stdio: opts.stdio || 'pipe',
    }).trim();
  } catch (e) {
    if (opts.ignoreError) return '';
    if (opts.returnStatus) return null;
    throw e;
  }
}

function runPassthrough(cmd, cwd) {
  try {
    execSync(cmd, { cwd: cwd || REPO_ROOT, stdio: 'inherit' });
    return 0;
  } catch (e) {
    return e.status || 1;
  }
}

console.log('==============================================');
console.log('  Telescope Submodule Update');
console.log('==============================================');
console.log('');

// 1. Record current commit
const oldCommit = run('git rev-parse HEAD', { cwd: TELESCOPE_DIR, ignoreError: true }) || 'none';
const oldShort = oldCommit.substring(0, 8);
console.log(`Current telescope commit: ${oldShort}`);

// 2. Reset any local changes in the submodule (telescope is upstream-only)
console.log('');
console.log('Pulling latest telescope...');
run('git checkout -- .', { cwd: TELESCOPE_DIR, ignoreError: true });
run('git clean -fd', { cwd: TELESCOPE_DIR, ignoreError: true });
runPassthrough('git submodule update --remote lib/noita-telescope');

// 3. Check what changed
const newCommit = run('git rev-parse HEAD', { cwd: TELESCOPE_DIR });
const newShort = newCommit.substring(0, 8);

if (oldCommit === newCommit) {
  console.log(`✅ Already up to date (${oldShort})`);
  console.log('');
  console.log('Running tests anyway to verify integration...');
} else {
  console.log(`Updated: ${oldShort} -> ${newShort}`);
  console.log('');

  // Show commit count
  const commitCount = run(`git rev-list --count ${oldCommit}..${newCommit}`, { cwd: TELESCOPE_DIR, ignoreError: true }) || '?';
  console.log(`${commitCount} new commit(s):`);
  console.log('----------------------------------------------');
  const log = run(`git log --oneline --no-decorate ${oldCommit}..${newCommit}`, { cwd: TELESCOPE_DIR, ignoreError: true });
  console.log(log || '  (could not read commit log)');
  console.log('----------------------------------------------');
  console.log('');

  // Show changed files
  console.log('Changed files:');
  const diff = run(`git diff --name-only ${oldCommit}..${newCommit}`, { cwd: TELESCOPE_DIR, ignoreError: true });
  console.log(diff || '  (could not diff)');
  console.log('');
}

// 4. Run tests
console.log('Running tests...');
console.log('');
const testResult = runPassthrough('npm test');

if (testResult !== 0) {
  console.log('');
  console.log(`❌ TESTS FAILED (exit code ${testResult})`);
  console.log('');
  console.log('⚠️  The telescope update introduced breaking changes.');
  console.log('   Review the test output above and fix before committing.');
  console.log('');
  console.log('   To revert: git submodule update --init lib/noita-telescope');
  process.exit(1);
}

console.log('');
console.log('✅ Tests passed');

// 5. Build
console.log('');
console.log('Running build...');
const buildResult = runPassthrough('npm run build');

if (buildResult !== 0) {
  console.log('');
  console.log(`❌ BUILD FAILED (exit code ${buildResult})`);
  console.log('');
  console.log('⚠️  The telescope update broke the build.');
  console.log('   Review the build output above and fix before committing.');
  console.log('');
  console.log('   To revert: git submodule update --init lib/noita-telescope');
  process.exit(1);
}

console.log('');
console.log('✅ Build passed');

// 6. Summary
console.log('');
console.log('==============================================');
console.log('  Summary');
console.log('==============================================');
if (oldCommit === newCommit) {
  console.log('  Status:    Already up to date');
} else {
  const commitCount = run(`git rev-list --count ${oldCommit}..${newCommit}`, { cwd: TELESCOPE_DIR, ignoreError: true }) || '?';
  console.log('  Status:    Updated');
  console.log(`  From:      ${oldShort}`);
  console.log(`  To:        ${newShort}`);
  console.log(`  Commits:   ${commitCount}`);
}
console.log('  Tests:     ✅ Passed');
console.log('  Build:     ✅ Passed');
console.log('==============================================');
console.log('');
console.log('To commit this update:');
console.log('   git add lib/noita-telescope');
console.log(`   git commit -m "chore: update telescope submodule to ${newShort}"`);
console.log('');
