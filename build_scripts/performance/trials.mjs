import { compareRuns } from './compare.mjs';

export function selectTrials(repeats, selected) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 9) throw Error('Invalid repeat count');
  if (selected === undefined) return Array.from({ length: repeats }, (_, i) => i);
  const trial = Number(selected);
  if (!Number.isInteger(trial) || trial < 1 || trial > repeats) throw Error('trial must be 1..repeats');
  return [trial - 1];
}

/** Each runner tests all revisions in one trial. Never compare unpaired
 * machines, or turn absent/cancelled jobs into a successful partial report. */
export function combineTrials(reports, repeats, browsers = ['chromium', 'firefox']) {
  const problems = [], results = [];
  const identities = report => JSON.stringify(report.variants.map(({ label, commit }) => [label, commit]).sort());
  const first = reports[0];
  const configKey = report => JSON.stringify(report.config);
  for (const browser of browsers) {
    const group = reports.filter(report => report.browser === browser);
    const runs = [];
    for (let trial = 1; trial <= repeats; trial++) {
      const entries = group.filter(report => report.trial === trial);
      if (entries.length !== 1) { problems.push(`${browser}: expected one report for trial ${trial}, found ${entries.length}`); continue; }
      const report = entries[0];
      if (JSON.stringify(report.variants.map(v => v.label).sort()) !== JSON.stringify(['candidate', 'previous', 'reference']))
        problems.push(`${browser}/${trial}: all three revisions are required`);
      if (report.config.repeats !== repeats || configKey(report) !== configKey(first)
        || identities(report) !== identities(first)) problems.push(`${browser}/${trial}: configuration or revisions differ`);
      if (report.dailyPreflight.status !== 'ready') problems.push(`${browser}/${trial}: Daily fixture unavailable`);
      const actual = new Set();
      for (const run of report.runs) {
        const key = `${run.variant}/${run.scenario}`;
        if (run.trial !== trial || !run.browser.startsWith(browser + ' ') || actual.has(key) || !run.phases.length)
          problems.push(`${browser}/${trial}: invalid or duplicate run ${key}`);
        actual.add(key);
      }
      const expected = report.variants.flatMap(v => ['direct', 'baked'].map(s => `${v.label}/${s}`));
      if (actual.size !== expected.length || expected.some(key => !actual.has(key))) problems.push(`${browser}/${trial}: missing or unexpected journeys`);
      runs.push(...report.runs);
    }
    if (group.some(report => !Number.isInteger(report.trial) || report.trial < 1 || report.trial > repeats))
      problems.push(`${browser}: unexpected trial number`);
    if (runs.length) results.push({ browser, runs, comparison: compareRuns(runs, { ...first.config, repeats, pairedTrials: true }) });
  }
  if (reports.some(report => !browsers.includes(report.browser))) problems.push('Unexpected browser report');
  return { valid: !problems.length && results.length === browsers.length && results.every(r => r.comparison.comparable), problems, results };
}
