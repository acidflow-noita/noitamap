#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { combineTrials } from './trials.mjs';
import { aggregateReport, verdictAnnotation } from './report.mjs';

const input = resolve(process.argv[2] || 'performance-input');
const output = resolve(process.argv[3] || 'performance-results/combined');
const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
let files;
try { files = await readdir(input, { recursive: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
const reports = [], readErrors = [], setupFailures = [], statuses = new Set();
for (const file of files.filter(file => file === 'job-status.json' || file.endsWith('/job-status.json'))) {
  try {
    const record = JSON.parse(await readFile(join(input, file), 'utf8'));
    const key = `${record.browser}/${record.trial}`;
    if (!['chromium', 'firefox'].includes(record.browser) || !Number.isInteger(record.trial)
      || record.trial < 1 || record.trial > config.repeats || statuses.has(key) || !record.setup)
      throw Error('Invalid or duplicate job setup record');
    statuses.add(key);
    for (const phase of ['download', 'extract', 'runtime']) if (record.setup[phase] !== 'success')
      setupFailures.push(`${key}: ${phase} setup ${record.setup[phase] || 'did not run'}`);
    if (['download', 'extract', 'runtime'].every(phase => record.setup[phase] === 'success') && record.measure !== 'success')
      readErrors.push(`${key}: measurement step ${record.measure || 'did not run'}`);
  } catch (error) { readErrors.push(`${file}: ${error}`); }
}
for (const file of files.filter(file => file.endsWith('/results.json'))) {
  try { reports.push(JSON.parse(await readFile(join(input, file), 'utf8'))); }
  catch (error) { readErrors.push(`${file}: ${error}`); }
}
const combined = combineTrials(reports, config.repeats);
if (process.env.PERF_PREPARE_RESULT && process.env.PERF_PREPARE_RESULT !== 'success')
  setupFailures.unshift(`Shared builds/checks ${process.env.PERF_PREPARE_RESULT}; browser measurements were not ready to run.`);
combined.setupFailures = setupFailures;
combined.problems.push(...setupFailures);
combined.problems.push(...readErrors);
if (process.env.PERF_REPORT_DOWNLOAD === 'failure') combined.problems.push('Could not download all worker reports.');
if (process.env.PERF_WORKER_RESULT && process.env.PERF_WORKER_RESULT !== 'success')
  combined.problems.push('One or more worker jobs did not complete successfully.');
if (process.env.GITHUB_SHA && reports.some(report => report.variants.find(v => v.label === 'candidate')?.commit !== process.env.GITHUB_SHA))
  combined.problems.push('Candidate revision does not match this workflow run');
combined.valid &&= combined.problems.length === 0;
const report = aggregateReport(combined, config);
const summary = report.markdown;
await mkdir(output, { recursive: true });
await writeFile(join(output, 'results.json'), JSON.stringify({ config, combined, reports, verdict: report.headline }, null, 2));
await writeFile(join(output, 'summary.txt'), summary);
console.log(report.headline);
console.log(verdictAnnotation(report));
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, 'summary-written=true\n', { flag: 'a' });
process.exitCode = !combined.valid || (config.enforceTiming && combined.results.some(r => r.comparison.timingRegressions.length)) ? 1 : 0;
