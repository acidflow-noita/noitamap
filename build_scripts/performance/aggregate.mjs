#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { combineTrials } from './trials.mjs';
import { markdownSummary } from './compare.mjs';

const input = resolve(process.argv[2] || 'performance-input');
const output = resolve(process.argv[3] || 'performance-results/combined');
const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
let files;
try { files = await readdir(input, { recursive: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
const reports = [], readErrors = [];
for (const file of files.filter(file => file.endsWith('/results.json'))) {
  try { reports.push(JSON.parse(await readFile(join(input, file), 'utf8'))); }
  catch (error) { readErrors.push(`${file}: ${error}`); }
}
const combined = combineTrials(reports, config.repeats);
combined.problems.push(...readErrors);
if (process.env.GITHUB_SHA && reports.some(report => report.variants.find(v => v.label === 'candidate')?.commit !== process.env.GITHUB_SHA))
  combined.problems.push('Candidate revision does not match this workflow run');
combined.valid &&= combined.problems.length === 0;
const summary = ['Trials run on separate standard runners; each compares all three revisions on the same machine.',
  'Baked cases use a captured public bake within each trial; CDN latency and live rollover are excluded.',
  ...combined.problems.map(problem => `**INCOMPLETE:** ${problem}`),
  ...combined.results.map(result => `# ${result.browser}\n\n${markdownSummary(result.comparison, result.runs)}`)].join('\n\n');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'results.json'), JSON.stringify({ config, combined, reports }, null, 2));
await writeFile(join(output, 'summary.txt'), summary);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
for (const result of combined.results) for (const row of result.comparison.timingRegressions) for (const r of row.regressions)
  console.log(`::warning title=Map performance::${result.browser} ${row.scenario}/${row.phase} vs ${r.baseline}: +${Math.round(r.deltaMs)}ms, ${(r.relative * 100).toFixed(1)}%`);
process.exitCode = !combined.valid || (config.enforceTiming && combined.results.some(r => r.comparison.timingRegressions.length)) ? 1 : 0;
