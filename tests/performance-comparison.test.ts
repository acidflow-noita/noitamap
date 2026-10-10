import { describe, expect, it } from 'vitest';
import { compareRuns, median } from '../build_scripts/performance/compare.mjs';
const config = { repeats: 3, warning: { relative: .05, absoluteMs: 250 } };
function samples(variant: string, values: number[]) {
  return values.map((durationMs, trial) => ({ variant, trial, scenario: 'direct', valid: true,
    browser: 'same-browser', backend: 'main-gpu', graphics: { renderer: 'same-driver' }, phases: [{ label: 'first-terrain', durationMs }] }));
}
describe('paired performance regression reporting', () => {
  it('uses the median and requires both a relative and an absolute slowdown', () => {
    expect(median([9000, 1000, 1100])).toBe(1100);
    const report = compareRuns([...samples('previous', [7000, 7010, 6990]), ...samples('candidate', [7690, 7710, 11000])], config);
    expect(report.comparable).toBe(true);
    expect(report.timingRegressions[0].regressions[0].deltaMs).toBe(710);
    expect(compareRuns([...samples('previous', [100, 100, 100]), ...samples('candidate', [200, 200, 200])], config).timingRegressions).toEqual([]);
  });
  it('compares against the fixed reference as well as the immediate predecessor', () => {
    const report = compareRuns([...samples('reference', [1000, 1000, 1000]), ...samples('previous', [1800, 1800, 1800]), ...samples('candidate', [1810, 1810, 1810])], config);
    expect(report.timingRegressions[0].regressions.map((r: any) => r.baseline)).toEqual(['reference']);
  });
  it('never calls missing runs or mixed renderers a valid timing comparison', () => {
    const runs = [...samples('previous', [1000, 1000, 1000]), ...samples('candidate', [1000, 1000])];
    expect(compareRuns(runs, config).comparable).toBe(false);
    runs.push({ ...samples('candidate', [1000])[0], graphics: { renderer: 'another-driver' } });
    expect(compareRuns(runs, config).problems).toContain('Browser or rendering backend differed between runs; timings cannot be compared.');
    runs[0].valid = false;
    expect(compareRuns(runs, config).comparable).toBe(false);
  });
  it('reports navigation pauses using their own threshold and rejects non-finite timing samples', () => {
    const runs = [...samples('previous', [30, 30, 30]), ...samples('candidate', [120, 120, 120])];
    for (const run of runs) run.phases[0].label = 'navigation-frame-gap';
    const navigationConfig = { ...config, navigationWarning: { relative: .2, absoluteMs: 50 } };
    expect(compareRuns(runs, navigationConfig).timingRegressions).toHaveLength(1);
    runs[0].phases[0].durationMs = NaN;
    const invalid = compareRuns(runs, navigationConfig);
    expect(invalid.comparable).toBe(false);
    expect(invalid.timingRegressions).toEqual([]);
  });
});
