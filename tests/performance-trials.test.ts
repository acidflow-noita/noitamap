import { describe, expect, it } from 'vitest';
import { selectTrials, combineTrials } from '../build_scripts/performance/trials.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const config = { repeats: 3, warning: { relative: .05, absoluteMs: 250 } };
const variants = ['candidate', 'previous', 'reference'].map(label => ({ label, commit: label + '-commit' }));
function report(browser: string, trial: number): any {
  return { browser, trial, config, variants, dailyPreflight: { status: 'ready' },
    runs: variants.flatMap(v => ['direct', 'baked'].map(scenario => ({
      variant: v.label, trial, scenario, valid: true, browser: browser + ' 148',
      backend: 'main-gpu', graphics: { renderer: browser + '-software' },
      phases: [{ label: 'first-paint', durationMs: (v.label === 'candidate' ? 1500 : 1000) * trial }],
    }))) };
}
const reports = () => ['chromium', 'firefox'].flatMap(browser => [1, 2, 3].map(trial => report(browser, trial)));

describe('isolated performance trials', () => {
  it('keeps all repeats by default and preserves the global rotation for a selected trial', () => {
    expect(selectTrials(3, undefined)).toEqual([0, 1, 2]);
    expect(selectTrials(3, '2')).toEqual([1]);
    const [trial] = selectTrials(3, '2');
    expect(variants.map((_, i) => variants[(i + trial) % variants.length].label)).toEqual(['previous', 'reference', 'candidate']);
    for (const value of ['0', '4', '1.5', 'x', '']) expect(() => selectTrials(3, value)).toThrow();
  });
  it('combines six reports into all three paired samples for both browsers', () => {
    const result = combineTrials(reports(), 3);
    expect(result.valid).toBe(true);
    expect(result.results).toHaveLength(2);
    for (const browser of result.results) {
      expect(browser.runs).toHaveLength(18);
      expect(browser.comparison.timingRegressions).toHaveLength(2);
      expect(browser.comparison.rows[0].values.candidate).toHaveLength(3);
      expect(browser.comparison.rows[0].regressions).toEqual([
        { baseline: 'previous', deltaMs: 1000, relative: .5 },
        { baseline: 'reference', deltaMs: 1000, relative: .5 },
      ]);
    }
  });
  it.each(['missing', 'duplicate', 'wrong commit', 'wrong config', 'failed bake', 'wrong trial', 'missing journey', 'mixed graphics', 'failed journey']) (
    'fails a %s instead of reporting a healthy partial comparison', kind => {
      const data = reports();
      if (kind === 'missing') data.pop();
      if (kind === 'duplicate') data.push(data[0]);
      if (kind === 'wrong commit') data[0] = { ...data[0], variants: [{ ...variants[0], commit: 'other' }, ...variants.slice(1)] };
      if (kind === 'wrong config') data[0] = { ...data[0], config: { ...config, repeats: 1 } };
      if (kind === 'failed bake') data[0].dailyPreflight.status = 'failed';
      if (kind === 'wrong trial') data[0].runs[0].trial = 3;
      if (kind === 'missing journey') data[0].runs.pop();
      if (kind === 'mixed graphics') data[0].runs[0].graphics.renderer = 'unexpected-driver';
      if (kind === 'failed journey') data[0].runs[0].valid = false;
      expect(combineTrials(data, 3).valid).toBe(false);
    },
  );
  it('reports cancellation of every job as incomplete', () => {
    expect(combineTrials([], 3)).toMatchObject({ valid: false, results: [] });
  });
  it('requires the fixed reference as well as the immediate parent', () => {
    const data = reports();
    for (const report of data) {
      report.variants = report.variants.filter((v: any) => v.label !== 'reference');
      report.runs = report.runs.filter((r: any) => r.variant !== 'reference');
    }
    expect(combineTrials(data, 3).valid).toBe(false);
  });
  it('aggregates downloaded artifact directories and exits nonzero if one is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'noitamap-trial-'));
    try {
      for (const report of reports()) {
        const dir = join(root, 'input', `map-performance-${report.browser}-${report.trial}`, 'performance-results');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'results.json'), JSON.stringify(report));
      }
      const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, ['build_scripts/performance/aggregate.mjs', join(root, 'input'), join(root, 'output')], {
        encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'candidate-commit', GITHUB_STEP_SUMMARY: join(root, 'step-summary'),
          GITHUB_OUTPUT: join(root, 'step-output'), PERF_REPORT_DOWNLOAD: 'success', PERF_WORKER_RESULT: 'success', ...env },
      });
      const complete = run();
      expect(complete.error).toBeUndefined();
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout).toContain('::warning title=Overall deploy verdict::DEPLOY: REVIEW');
      expect(complete.stdout).not.toContain('| Browser |');
      expect(readFileSync(join(root, 'step-summary'), 'utf8')).toMatch(/^\*\*DEPLOY: REVIEW/);
      expect(readFileSync(join(root, 'step-output'), 'utf8')).toContain('summary-written=true');
      expect(run({ PERF_WORKER_RESULT: 'failure' }).status).toBe(1);
      expect(readFileSync(join(root, 'step-summary'), 'utf8')).toMatch(/^\*\*DEPLOY: HOLD/);
      rmSync(join(root, 'input', 'map-performance-chromium-3'), { recursive: true });
      expect(run().status).toBe(1);
      expect(readFileSync(join(root, 'step-summary'), 'utf8')).toMatch(/^\*\*DEPLOY: HOLD/);
      expect(JSON.parse(readFileSync(join(root, 'output', 'results.json'), 'utf8')).combined.valid).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
