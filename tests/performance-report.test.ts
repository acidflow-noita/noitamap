import { describe, expect, it } from 'vitest';
import { combineTrials } from '../build_scripts/performance/trials.mjs';
import { aggregateReport, verdictAnnotation } from '../build_scripts/performance/report.mjs';

const config = { repeats: 3, warning: { relative: .05, absoluteMs: 250 },
  navigationWarning: { relative: .2, absoluteMs: 50 }, enforceTiming: false };
const variants = ['candidate', 'previous', 'reference'].map(label => ({ label, commit: label + '-commit' }));
function reports(warning = false) {
  const unlocks = { candidate: [4308, 2700, 2595], previous: [3942, 2586, 2313], reference: [9166, 5693, 5066] };
  return ['chromium', 'firefox'].flatMap(browser => [1, 2, 3].map(trial => ({
    browser, trial, config, variants, dailyPreflight: { status: 'ready' },
    runs: variants.flatMap(v => ['direct', 'baked'].map(scenario => ({
      variant: v.label, commit: v.commit, trial, scenario, valid: true, browser: browser + ' 148',
      backend: 'main-gpu', graphics: { renderer: browser + '-software' },
      phases: [{ label: scenario === 'direct' ? 'mod-unlocks' : 'first-dynamic',
        durationMs: warning && browser === 'chromium' && scenario === 'direct'
          ? unlocks[v.label as keyof typeof unlocks][trial - 1] : 1000 }],
    }))),
  })));
}

describe('workflow deploy verdict', () => {
  it('leads with one deploy pass and collapses one combined table for both browsers', () => {
    const report = aggregateReport(combineTrials(reports(), 3), config);
    expect(report.status).toBe('pass');
    expect(report.headline).toMatch(/^DEPLOY: PASS — All 36 browser runs passed/);
    expect(report.headline).not.toContain('\n');
    const visible = report.markdown.split('<details>')[0];
    expect(visible).toContain('Chromium and Firefox');
    expect(visible).not.toContain('|');
    expect(report.markdown.match(/\| Browser \|/g)).toHaveLength(1);
    expect(report.markdown).toContain('| Check | This commit | Previous commit | Fixed reference |');
    expect(verdictAnnotation(report)).toContain('::notice title=Overall deploy verdict::DEPLOY: PASS');
  });
  it('puts the actual run-38102267536 warning in the one-line verdict', () => {
    const report = aggregateReport(combineTrials(reports(true), 3), config);
    expect(report.status).toBe('review');
    expect(report.headline).toBe('DEPLOY: REVIEW — All 36 browser runs passed; 1 timing warning: Chromium mod unlock update +282 ms (+9.3%) vs previous commit.');
    expect(report.markdown).toContain('Timing warnings require review');
    expect(verdictAnnotation(report)).toContain('+9.3%25');
  });
  it('holds when timing regressions are configured to fail the check', () => {
    const report = aggregateReport(combineTrials(reports(true), 3), { ...config, enforceTiming: true });
    expect(report.status).toBe('hold');
    expect(report.headline).toContain('DEPLOY: HOLD — All 36 browser runs passed; 1 timing warning');
    expect(report.markdown).toContain('timing warning fails this check');
  });
  it('holds failed runs even when another completed comparison has a timing warning', () => {
    const data = reports(true);
    data[0].runs.find(run => run.scenario === 'baked')!.valid = false;
    const report = aggregateReport(combineTrials(data, 3), config);
    expect(report.headline).toMatch(/^DEPLOY: HOLD — 1 of 36 browser runs failed/);
    expect(report.markdown).toContain('+282 ms');
    expect(verdictAnnotation(report)).toContain('::error');
  });
  it('never clears an incomplete or inconsistent set of reports for deployment', () => {
    const data = reports();
    data.pop();
    expect(aggregateReport(combineTrials(data, 3), config).headline).toContain('DEPLOY: HOLD — Missing or inconsistent');
    expect(aggregateReport(combineTrials([], 3), config).status).toBe('hold');
    const inconsistent = reports();
    inconsistent[0].config = { ...config, repeats: 1 };
    expect(aggregateReport(combineTrials(inconsistent, 3), config).status).toBe('hold');
  });
});
